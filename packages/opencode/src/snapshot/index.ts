import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Duration, Effect, FileSystem, Layer, Option, Schedule, Schema, Semaphore, Context } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { formatPatch, structuredPatch } from "diff"
import path from "path"
import { AppProcess } from "@opencode-ai/core/process"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Hash } from "@opencode-ai/core/util/hash"
import { Config } from "@/config/config"
import { Global } from "@opencode-ai/core/global"
import { Info } from "@opencode-ai/schema/file-diff"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { which } from "@opencode-ai/core/util/which"
import { DEFAULT_EXCLUDES, LIMITS, prober, resolveScope, type Unavailable } from "./folder"

// A file the agent changed that this checkpoint could not capture, so undo cannot restore it.
export const Skipped = SessionV1.PatchSkippedFile
export type Skipped = typeof Skipped.Type

export const Patch = Schema.Struct({
  hash: Schema.String,
  files: Schema.mutable(Schema.Array(Schema.String)),
  skipped: Schema.optional(Schema.mutable(Schema.Array(Skipped))),
})
export type Patch = typeof Patch.Type

export type Status = {
  mode: "git" | "folder" | "off"
  worktree: string
  reason?: Unavailable | "disabled"
}

export type PatchInput = {
  // Step start time: blocked large or cloud-placeholder files modified since then are reported.
  since?: number
  // Absolute paths the agent's file tools wrote during the step.
  touched?: readonly string[]
}

export const FileDiff = Info
export type FileDiff = typeof FileDiff.Type

const prune = "7.days"
const limit = LIMITS.maxFileBytes
const core = ["-c", "core.longpaths=true", "-c", "core.symlinks=true"]
const cfg = ["-c", "core.autocrlf=false", ...core]
const quote = [...cfg, "-c", "core.quotepath=false"]
interface GitResult {
  readonly code: ChildProcessSpawner.ExitCode
  readonly text: string
  readonly stderr: string
}

type State = Omit<Interface, "init">

type Blocked = { rel: string; mtimeMs: number; offline: boolean }
// Blocked paths recorded for a checkpoint: worktree-relative path to whether it was a cloud placeholder.
type BlockedAt = Map<string, boolean>

// An evicted iCloud file reports its full size but no allocated blocks. Reading it would force a download.
const placeholder = (size: number, stat: FileSystem.File.Info) =>
  process.platform === "darwin" && size > 0 && Option.getOrUndefined(stat.blocks) === 0

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly cleanup: () => Effect.Effect<void>
  readonly track: () => Effect.Effect<string | undefined>
  readonly status: () => Effect.Effect<Status>
  readonly patch: (hash: string, input?: PatchInput) => Effect.Effect<Patch>
  readonly restore: (snapshot: string) => Effect.Effect<void>
  readonly revert: (patches: Patch[]) => Effect.Effect<void>
  readonly diff: (hash: string) => Effect.Effect<string>
  readonly diffFull: (from: string, to: string) => Effect.Effect<FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Snapshot") {}

const layer: Layer.Layer<Service, never, FSUtil.Service | AppProcess.Service | Config.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const appProcess = yield* AppProcess.Service
    const config = yield* Config.Service
    const locks = new Map<string, Semaphore.Semaphore>()

    const lock = (key: string) => {
      const hit = locks.get(key)
      if (hit) return hit

      const next = Semaphore.makeUnsafe(1)
      locks.set(key, next)
      return next
    }

    const state = yield* InstanceState.make<State>(
      Effect.fn("Snapshot.state")(function* (ctx) {
        const realpath = (file: string) => fs.realPath(file).pipe(Effect.catch(() => Effect.succeed(file)))
        // Git projects keep their worktree and gitdir. Everything else checkpoints the opened folder
        // with its own gitdir, and never a drive root, the home folder or the data directory.
        const scope = resolveScope({
          vcs: ctx.project.vcs,
          worktree: ctx.worktree,
          directory: ctx.directory,
          home: yield* realpath(Global.Path.home),
          data: yield* realpath(Global.Path.data),
        })
        const state: {
          directory: string
          worktree: string
          gitdir: string
          mode: "git" | "folder" | "off"
          off: Unavailable | undefined
        } = {
          directory: ctx.directory,
          worktree: scope.worktree,
          gitdir: path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(scope.worktree)),
          mode: scope.mode,
          off: scope.mode === "off" ? scope.reason : undefined,
        }

        const args = (cmd: string[]) => ["--git-dir", state.gitdir, "--work-tree", state.worktree, ...cmd]

        const encodeNulTerminatedPaths = (files: string[]) => files.join("\0") + "\0"
        const encodeTopLevelLiteralPathspecs = (files: string[]) =>
          encodeNulTerminatedPaths(files.map((file) => `:(top,literal)${file}`))

        const git = Effect.fnUntraced(
          function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string>; stdin?: string }) {
            const result = yield* appProcess.run(
              ChildProcess.make("git", cmd, { cwd: opts?.cwd, env: opts?.env, extendEnv: true }),
              { stdin: opts?.stdin },
            )
            return {
              code: ChildProcessSpawner.ExitCode(result.exitCode),
              text: result.stdout.toString("utf8"),
              stderr: result.stderr.toString("utf8"),
            } satisfies GitResult
          },
          Effect.catch((err) =>
            Effect.succeed({
              code: ChildProcessSpawner.ExitCode(1),
              text: "",
              stderr: err instanceof Error ? err.message : String(err),
            }),
          ),
        )

        const ignore = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return new Set<string>()
          // check-ignore treats a leading colon as pathspec magic but accepts and echoes a protective ./ prefix.
          const checkIgnorePaths = files.map((item) => (item.startsWith(":") ? `./${item}` : item))
          const check = yield* git(
            [
              ...quote,
              "--git-dir",
              // A plain folder has no repo of its own: the snapshot's info/exclude holds the default
              // excludes, and the folder's .gitignore files and core.excludesFile still apply.
              state.mode === "git" ? path.join(state.worktree, ".git") : state.gitdir,
              "--work-tree",
              state.worktree,
              "check-ignore",
              "--no-index",
              "--stdin",
              "-z",
            ],
            {
              cwd: state.worktree,
              stdin: encodeNulTerminatedPaths(checkIgnorePaths),
            },
          )
          if (check.code !== 0 && check.code !== 1) return new Set<string>()
          return new Set(
            check.text
              .split("\0")
              .filter(Boolean)
              .map((item) => (item.startsWith("./:") ? item.slice(2) : item)),
          )
        })

        const drop = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return
          yield* git(
            [
              ...cfg,
              ...args(["rm", "--cached", "-f", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"]),
            ],
            {
              cwd: state.worktree,
              stdin: encodeTopLevelLiteralPathspecs(files),
            },
          )
        })

        const stage = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return
          const result = yield* git(
            [...cfg, ...args(["add", "--all", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul"])],
            {
              cwd: state.worktree,
              stdin: encodeTopLevelLiteralPathspecs(files),
            },
          )
          if (result.code === 0) return
          yield* Effect.logWarning("failed to add snapshot files", {
            exitCode: result.code,
            stderr: result.stderr,
          })
        })

        const exists = (file: string) => fs.exists(file).pipe(Effect.orDie)
        const read = (file: string) => fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")))
        const remove = (file: string) => fs.remove(file).pipe(Effect.catch(() => Effect.void))
        const locked = <A, E, R>(fx: Effect.Effect<A, E, R>) => lock(state.gitdir).withPermits(1)(fx)

        // Bounded size probe for plain folders, started in the background at instance start.
        const walk = prober(state.worktree)
        const availability = Effect.promise(() => walk())

        // Checkpoints run the git binary. On macOS /usr/bin/git is a stub that opens the "install developer
        // tools" dialog when the Command Line Tools are missing, so ask xcode-select (which never prompts) first.
        const installed = yield* Effect.cached(
          Effect.gen(function* () {
            const found = which("git")
            if (!found) return false
            if (process.platform !== "darwin" || found !== "/usr/bin/git") return true
            return yield* appProcess.run(ChildProcess.make("/usr/bin/xcode-select", ["-p"], { extendEnv: true })).pipe(
              Effect.map((result) => result.exitCode === 0),
              Effect.catch(() => Effect.succeed(true)),
            )
          }),
        )

        const disable = Effect.fnUntraced(function* (reason: Unavailable, extra?: Record<string, unknown>) {
          state.off = reason
          yield* Effect.logWarning("checkpoints off for this folder", { worktree: state.worktree, reason, ...extra })
        })

        // Why checkpoints are off right now, or undefined when they are on. A slow size walk is not remembered:
        // the next step walks again once the retry delay has passed.
        const unavailable = Effect.fnUntraced(function* () {
          if (state.off) return state.off
          if (!(yield* installed)) {
            yield* disable("no-git")
            return state.off
          }
          if (state.mode === "git") return undefined
          const result = yield* availability
          if (result.over === "slow") return result.over
          if (result.over) yield* disable(result.over, { files: result.files, bytes: result.bytes })
          return state.off
        })

        const enabled = Effect.fnUntraced(function* () {
          if ((yield* config.get()).snapshot === false) return false
          return !(yield* unavailable())
        })

        const status = Effect.fnUntraced(function* () {
          const disabled = (yield* config.get()).snapshot === false
          const reason = disabled ? undefined : yield* unavailable()
          const result: Status = {
            mode: (disabled ? state.off : reason) ? "off" : state.mode,
            worktree: state.worktree,
            reason: disabled ? "disabled" : reason,
          }
          return result
        })

        // Paths a checkpoint left out (large files, cloud placeholders) are absent from its tree. They are
        // recorded per tree hash so a later patch or revert never mistakes them for files created during the step.
        const blockedPath = (hash: string) => path.join(state.gitdir, "agentcode-blocked", hash)
        const blockedAt = Effect.fnUntraced(function* (hash: string) {
          const result: BlockedAt = new Map()
          if (!/^[0-9a-f]{4,64}$/.test(hash)) return result
          const text = yield* read(blockedPath(hash))
          if (!text) return result
          try {
            const parsed: unknown = JSON.parse(text)
            if (!Array.isArray(parsed)) return result
            for (const item of parsed) {
              if (item && typeof item.rel === "string") result.set(item.rel, item.offline === true)
            }
          } catch {
            // A torn write reads as no record.
          }
          return result
        })
        // Merged with any earlier record: the same tree can be written at different times with different
        // blocked files, and remembering too many only means a file is kept instead of deleted.
        const recordBlocked = Effect.fnUntraced(function* (hash: string, blocked: Blocked[]) {
          if (!blocked.length || !/^[0-9a-f]{4,64}$/.test(hash)) return
          const known = yield* blockedAt(hash)
          const fresh = blocked.filter((item) => known.get(item.rel) !== item.offline)
          if (!fresh.length) return
          for (const item of fresh) known.set(item.rel, item.offline)
          const file = blockedPath(hash)
          yield* fs.ensureDir(path.dirname(file)).pipe(Effect.ignore)
          yield* fs
            .writeFileString(file, JSON.stringify(Array.from(known, ([rel, offline]) => ({ rel, offline }))))
            .pipe(Effect.ignore)
        })

        const excludes = Effect.fnUntraced(function* () {
          if (state.mode !== "git") return
          const result = yield* git(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], {
            cwd: state.worktree,
          })
          const file = result.text.trim()
          if (!file) return
          if (!(yield* exists(file))) return
          return file
        })

        const sync = Effect.fnUntraced(function* (list: string[] = []) {
          const file = yield* excludes()
          const target = path.join(state.gitdir, "info", "exclude")
          const text = [
            ...(state.mode === "git" ? [file ? (yield* read(file)).trimEnd() : ""] : DEFAULT_EXCLUDES),
            ...list.map((item) => `/${item.replaceAll("\\", "/")}`),
          ]
            .filter(Boolean)
            .join("\n")
          yield* fs.ensureDir(path.join(state.gitdir, "info")).pipe(Effect.orDie)
          yield* fs.writeFileString(target, text ? `${text}\n` : "").pipe(Effect.orDie)
        })

        // Reuse the hashes for the git storage between the original repo and snapshot
        // on huge repos like chromium checkout the git add --all rebuilding the
        // hashes can take minutes. By doing this we eliminating this at all
        const seed = Effect.fnUntraced(function* () {
          if (state.mode !== "git") return

          const commonDir = yield* git(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
            cwd: state.worktree,
          })

          if (commonDir.code !== 0) return
          const source = commonDir.text.trim()
          if (!source || !(yield* exists(source))) return

          // Share the source object database (and the source's own alternates,
          // skipping any that no longer exist) so seeded blobs resolve.
          const sourceObjects = path.join(source, "objects")
          const chained = (yield* read(path.join(sourceObjects, "info", "alternates")))
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
          const alternates: string[] = []
          for (const candidate of [sourceObjects, ...chained]) {
            if (yield* exists(candidate)) alternates.push(candidate)
          }
          if (!alternates.length) return

          yield* fs.ensureDir(path.join(state.gitdir, "objects", "info")).pipe(Effect.orDie)
          yield* fs
            .writeFileString(path.join(state.gitdir, "objects", "info", "alternates"), alternates.join("\n") + "\n")
            .pipe(Effect.orDie)

          // Seed the index from the source repo so already-hashed entries are reused.
          // Best-effort: a missing/incompatible index just falls back to a full add.
          const sourceIndex = path.join(source, "index")
          if (yield* exists(sourceIndex)) {
            yield* fs.copyFile(sourceIndex, path.join(state.gitdir, "index")).pipe(Effect.catch(() => Effect.void))
          }
        })

        // Git stores a folder that is its own repository as a single gitlink entry, which captures none of its
        // files. In a plain folder those files are listed through the nested repository instead and seeded into
        // the snapshot index directly; once the index has entries under it, git walks it like any other folder.
        let unlinked = false
        const unlink = Effect.fnUntraced(function* () {
          if (unlinked) return
          unlinked = true
          const list = yield* git([...quote, ...args(["ls-files", "-z", "--stage"])], { cwd: state.worktree })
          const links = list.text
            .split("\0")
            .filter((line) => line.startsWith("160000 "))
            .map((line) => line.slice(line.indexOf("\t") + 1))
          yield* drop(links)
        })

        const nested = Effect.fnUntraced(function* (dirs: string[]) {
          const files: string[] = []
          const queue = [...dirs]
          while (queue.length && files.length <= LIMITS.maxFiles) {
            const dir = queue.shift()!
            const list = yield* git(
              [
                ...quote,
                "-C",
                path.join(state.worktree, dir),
                "ls-files",
                "-z",
                "--cached",
                "--others",
                "--exclude-standard",
                `--exclude-from=${path.join(state.gitdir, "info", "exclude")}`,
                "--",
                ".",
              ],
              { cwd: state.worktree },
            )
            if (list.code !== 0) {
              yield* Effect.logWarning("failed to list nested repository files", { dir, stderr: list.stderr })
              continue
            }
            for (const item of list.text.split("\0").filter(Boolean)) {
              if (item.endsWith("/")) queue.push(`${dir}${item}`)
              else files.push(`${dir}${item}`)
            }
          }
          // Committed paths that are missing, or that are themselves gitlinks, are not files to seed.
          const kept = yield* Effect.all(
            files.map((item) =>
              fs.stat(path.join(state.worktree, item)).pipe(
                Effect.map((stat) => (stat.type === "Directory" ? undefined : item)),
                Effect.catch(() => Effect.void),
              ),
            ),
            { concurrency: 8 },
          )
          return kept.filter((item): item is string => !!item)
        })

        const seedNested = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return
          const result = yield* git([...cfg, ...args(["update-index", "--add", "-z", "--stdin"])], {
            cwd: state.worktree,
            stdin: encodeNulTerminatedPaths(files),
          })
          if (result.code === 0) return
          yield* Effect.logWarning("failed to add nested repository files to snapshot", {
            exitCode: result.code,
            stderr: result.stderr,
          })
        })

        const add = Effect.fnUntraced(function* () {
          const none: { blocked: Blocked[] } = { blocked: [] }
          yield* sync()
          if (state.mode === "folder") yield* unlink()
          const [diff, other] = yield* Effect.all(
            [
              git([...quote, ...args(["diff-files", "--name-only", "-z", "--", "."])], {
                cwd: state.directory,
              }),
              git([...quote, ...args(["ls-files", "--full-name", "--others", "--exclude-standard", "-z", "--", "."])], {
                cwd: state.directory,
              }),
            ],
            { concurrency: 2 },
          )
          if (diff.code !== 0 || other.code !== 0) {
            yield* Effect.logWarning("failed to list snapshot files", {
              diffCode: diff.code,
              diffStderr: diff.stderr,
              otherCode: other.code,
              otherStderr: other.stderr,
            })
            return none
          }

          const tracked = diff.text.split("\0").filter(Boolean)
          const listed = other.text.split("\0").filter(Boolean)
          const repos = state.mode === "folder" ? listed.filter((item) => item.endsWith("/")) : []
          const inner = yield* nested(repos)
          const untracked = [...listed.filter((item) => !item.endsWith("/")), ...inner]
          // A plain folder that grew past the probe's limit after instance start turns checkpoints off
          // instead of hashing every new file.
          if (state.mode === "folder" && untracked.length > LIMITS.maxFiles) {
            yield* disable("too-many-files", { files: untracked.length })
            return none
          }
          const all = Array.from(new Set([...tracked, ...untracked]))
          if (!all.length) return none

          // Resolve source-repo ignore rules against the exact candidate set.
          // --no-index keeps this pattern-based even when a path is already tracked.
          const ignored = yield* ignore(all)

          // Remove newly-ignored files from snapshot index to prevent re-adding
          if (ignored.size > 0) {
            const ignoredFiles = Array.from(ignored)
            yield* Effect.logInfo("removing gitignored files from snapshot", { count: ignoredFiles.length })
            yield* drop(ignoredFiles)
          }

          const allow = all.filter((item) => !ignored.has(item))
          if (!allow.length) return none

          const large = new Map(
            (yield* Effect.all(
              allow.map((item) =>
                fs
                  .stat(path.join(state.worktree, item))
                  .pipe(Effect.catch(() => Effect.void))
                  .pipe(
                    Effect.map((stat): Blocked | undefined => {
                      if (!stat || stat.type !== "File") return
                      const size = typeof stat.size === "bigint" ? Number(stat.size) : stat.size
                      const offline = placeholder(size, stat)
                      if (size <= limit && !offline) return
                      return { rel: item, mtimeMs: Option.getOrUndefined(stat.mtime)?.getTime() ?? 0, offline }
                    }),
                  ),
              ),
              { concurrency: 8 },
            )).flatMap((item) => (item ? [[item.rel, item] as const] : [])),
          )
          // Untracked large files and evicted cloud placeholders are never added: hashing a placeholder
          // would force a download.
          const blocked = untracked.flatMap((item) => large.get(item) ?? [])
          const block = new Set(blocked.map((item) => item.rel))
          yield* sync(Array.from(block))
          const seeded = new Set(inner)
          yield* seedNested(allow.filter((item) => seeded.has(item) && !block.has(item)))
          // Stage only the allowed candidate paths so snapshot updates stay scoped.
          yield* stage(allow.filter((item) => !block.has(item) && !seeded.has(item)))
          return { blocked }
        })

        const cleanup = Effect.fnUntraced(function* () {
          return yield* locked(
            Effect.gen(function* () {
              if (!(yield* enabled())) return
              if (!(yield* exists(state.gitdir))) return
              const result = yield* git(args(["gc", `--prune=${prune}`]), { cwd: state.directory })
              if (result.code !== 0) {
                yield* Effect.logWarning("cleanup failed", {
                  exitCode: result.code,
                  stderr: result.stderr,
                })
                return
              }
              // Blocked-file records follow the snapshot trees, which gc prunes after the same delay.
              const records = path.join(state.gitdir, "agentcode-blocked")
              const cutoff = Date.now() - Duration.toMillis(Duration.days(7))
              for (const entry of yield* fs
                .readDirectoryEntries(records)
                .pipe(Effect.catch(() => Effect.succeed([])))) {
                const file = path.join(records, entry.name)
                const stat = yield* fs.stat(file).pipe(Effect.catch(() => Effect.void))
                const mtime = stat ? Option.getOrUndefined(stat.mtime)?.getTime() : undefined
                if (mtime !== undefined && mtime < cutoff) yield* remove(file)
              }
              yield* Effect.logInfo("cleanup", { prune })
            }),
          )
        })

        const track = Effect.fnUntraced(function* () {
          return yield* locked(
            Effect.gen(function* () {
              if (!(yield* enabled())) return
              const existed = yield* exists(state.gitdir)
              yield* fs.ensureDir(state.gitdir).pipe(Effect.orDie)
              if (!existed) {
                yield* git(["init"], {
                  env: { GIT_DIR: state.gitdir, GIT_WORK_TREE: state.worktree },
                })
                yield* git(["--git-dir", state.gitdir, "config", "core.autocrlf", "false"])
                yield* git(["--git-dir", state.gitdir, "config", "core.longpaths", "true"])
                yield* git(["--git-dir", state.gitdir, "config", "core.symlinks", "true"])
                yield* git(["--git-dir", state.gitdir, "config", "core.fsmonitor", "false"])
                // Tuning for very large worktrees so the first add stays bounded.
                yield* git(["--git-dir", state.gitdir, "config", "feature.manyFiles", "true"])
                yield* git(["--git-dir", state.gitdir, "config", "index.version", "4"])
                yield* git(["--git-dir", state.gitdir, "config", "index.threads", "true"])
                yield* git(["--git-dir", state.gitdir, "config", "core.untrackedCache", "true"])
                yield* seed()
                // Folder snapshots are keyed by a hash of the folder path; record the path so orphaned
                // gitdirs can be found and swept later.
                if (state.mode === "folder") {
                  yield* fs
                    .writeFileString(path.join(state.gitdir, "agentcode-worktree"), `${state.worktree}\n`)
                    .pipe(Effect.ignore)
                }
                yield* Effect.logInfo("initialized")
              }
              const { blocked } = yield* add()
              if (state.off) return
              const result = yield* git(args(["write-tree"]), { cwd: state.directory })
              const hash = result.text.trim()
              yield* recordBlocked(hash, blocked)
              yield* Effect.logInfo("tracking", { hash, cwd: state.directory, git: state.gitdir })
              return hash
            }),
          )
        })

        // Paths in the snapshot index, checked in chunks so long touched lists stay within argv limits.
        const indexed = Effect.fnUntraced(function* (files: string[]) {
          const result = new Set<string>()
          for (let i = 0; i < files.length; i += 100) {
            const list = yield* git(
              [
                ...quote,
                ...args([
                  "ls-files",
                  "-z",
                  "--cached",
                  "--full-name",
                  "--",
                  ...files.slice(i, i + 100).map((file) => `:(top,literal)${file}`),
                ]),
              ],
              { cwd: state.worktree },
            )
            for (const item of list.text.split("\0").filter(Boolean)) result.add(item)
          }
          return result
        })

        // Resolve a touched path to its worktree-relative form, or undefined when it is outside the worktree.
        const relative = Effect.fnUntraced(function* (file: string) {
          const inside = (target: string) => {
            if (!FSUtil.contains(state.worktree, target)) return
            const rel = path.relative(state.worktree, target).replaceAll("\\", "/")
            return rel ? rel : undefined
          }
          const direct = inside(file)
          if (direct !== undefined) return direct
          // The tool may have used a symlinked spelling of the folder (/var vs /private/var).
          const real = yield* fs.realPath(file).pipe(
            Effect.catch(() =>
              fs.realPath(path.dirname(file)).pipe(
                Effect.map((dir) => path.join(dir, path.basename(file))),
                Effect.catch(() => Effect.succeed(file)),
              ),
            ),
          )
          return real === file ? undefined : inside(real)
        })

        // Files the checkpoint did not capture: large or cloud-placeholder files created during the step, files the
        // checkpoint left out that became capturable (a large file that shrank, a placeholder that was downloaded),
        // plus files the agent's file tools touched that were ignored, too large or outside the folder.
        const uncaptured = Effect.fnUntraced(function* (input: {
          blocked: Blocked[]
          // Blocked when the checkpoint was taken.
          before: BlockedAt
          // Left out of the checkpoint, now staged: removed from the patch files.
          lost: string[]
          captured: string[]
          since?: number
          touched: readonly { raw: string; rel: string | undefined }[]
        }) {
          // Values stay undefined until classified; Map keeps the first insertion order, so touched files are
          // reported in the order the tools wrote them.
          const out = new Map<string, Skipped["reason"] | undefined>()
          const list = () =>
            Array.from(out)
              .flatMap(([file, reason]) => (reason ? [{ file, reason }] : []))
              .slice(0, 100)
          const absolute = (rel: string) => path.join(state.worktree, rel).replaceAll("\\", "/")
          const mtime = (stat: FileSystem.File.Info | void) =>
            stat ? (Option.getOrUndefined(stat.mtime)?.getTime() ?? 0) : 0
          if (input.since !== undefined) {
            for (const item of input.blocked) {
              // Already left out when the checkpoint was taken: rewritten by something else, not created here.
              if (item.mtimeMs < input.since || input.before.has(item.rel)) continue
              out.set(absolute(item.rel), item.offline ? "offline" : "large")
            }
          }

          const lost = new Set(input.lost)
          const touchedLost = new Set(
            input.touched.flatMap((item) => (item.rel && lost.has(item.rel) ? [item.rel] : [])),
          )
          const real = yield* fs.realPath(state.worktree).pipe(Effect.catch(() => Effect.succeed(state.worktree)))
          const captured = new Set(input.captured)
          const candidates: { file: string; rel: string; size: number; offline: boolean }[] = []
          for (const { raw, rel } of input.touched) {
            const spelled = raw.replaceAll("\\", "/")
            if (captured.has(spelled) || out.has(spelled)) continue
            if (rel === undefined) {
              if (!FSUtil.contains(state.worktree, raw)) out.set(spelled, "outside")
              continue
            }
            const file = absolute(rel)
            if (captured.has(file) || out.has(file)) continue
            if (touchedLost.has(rel)) {
              out.set(file, input.before.get(rel) ? "offline" : "large")
              continue
            }
            const stat = yield* fs.stat(path.join(state.worktree, rel)).pipe(Effect.catch(() => Effect.void))
            if (!stat || stat.type !== "File") continue
            // A path through a symlinked folder lands outside the checkpoint even though it is spelled inside.
            const parent = yield* fs
              .realPath(path.dirname(path.join(state.worktree, rel)))
              .pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (parent && !FSUtil.contains(real, parent)) {
              out.set(file, "outside")
              continue
            }
            const size = typeof stat.size === "bigint" ? Number(stat.size) : stat.size
            candidates.push({ file, rel, size, offline: placeholder(size, stat) })
            out.set(file, undefined)
          }

          // Left-out files that changed during the step and no tool touched are reported only when their content
          // changed during the step (a download alone restores nothing).
          for (const rel of lost) {
            const file = absolute(rel)
            if (out.has(file)) continue
            if (input.since !== undefined) {
              const stat = yield* fs.stat(path.join(state.worktree, rel)).pipe(Effect.catch(() => Effect.void))
              if (mtime(stat) < input.since) continue
            }
            out.set(file, input.before.get(rel) ? "offline" : "large")
          }
          if (!candidates.length) return list()

          // In the index means captured (unchanged content or a failed edit), so nothing to report.
          const index = yield* indexed(candidates.map((item) => item.rel))
          const rest: typeof candidates = []
          for (const item of candidates) {
            if (index.has(item.rel)) continue
            // Size is classified before ignore rules: blocked files also sit in the snapshot's info/exclude.
            if (item.offline) out.set(item.file, "offline")
            else if (item.size > limit) out.set(item.file, "large")
            else rest.push(item)
          }
          const ignored = yield* ignore(rest.map((item) => item.rel))
          for (const item of rest) {
            if (ignored.has(item.rel)) out.set(item.file, "ignored")
          }
          return list()
        })

        const patch = Effect.fnUntraced(function* (hash: string, input?: PatchInput) {
          return yield* locked(
            Effect.gen(function* () {
              const { blocked } = yield* add()
              const diffNames = (filter: string[]) =>
                git(
                  [
                    ...quote,
                    ...args(["diff", "--cached", "--no-ext-diff", "--name-only", "-z", ...filter, hash, "--", "."]),
                  ],
                  {
                    cwd: state.directory,
                  },
                )
              const result = yield* diffNames([])
              if (result.code !== 0) {
                yield* Effect.logWarning("failed to get diff", { hash, exitCode: result.code })
                return { hash, files: [] }
              }
              const names = result.text.split("\0").filter(Boolean)

              const touched: { raw: string; rel: string | undefined }[] = []
              for (const raw of new Set(input?.touched ?? [])) touched.push({ raw, rel: yield* relative(raw) })
              const tools = new Set(touched.flatMap((item) => (item.rel ? [item.rel] : [])))

              // Left out of the checkpoint (so absent from its tree) and capturable now: never a file created during
              // the step, so it must not be listed where revert would delete it.
              const before = yield* blockedAt(hash)
              const lost = names.filter((item) => before.has(item))
              let files = names.filter((item) => !before.has(item))

              // A plain folder has no git history behind it: only files the agent's file tools created are removed
              // by a revert, never ones another program (the user's editor, a sync client, a shell) added meanwhile.
              if (state.mode === "folder" && files.length) {
                const added = yield* diffNames(["--diff-filter=A"])
                if (added.code === 0) {
                  const created = new Set(added.text.split("\0").filter(Boolean))
                  files = files.filter((item) => !created.has(item) || tools.has(item))
                } else {
                  files = []
                }
              }

              // Hide ignored-file removals from the user-facing patch output.
              const ignored = yield* ignore(files)
              const captured = files
                .filter((item) => !ignored.has(item))
                .map((x) => path.join(state.worktree, x).replaceAll("\\", "/"))

              const skipped = yield* uncaptured({
                blocked,
                before,
                lost,
                captured,
                since: input?.since,
                touched,
              })
              if (!skipped.length) return { hash, files: captured }
              return { hash, files: captured, skipped }
            }),
          )
        })

        const restore = Effect.fnUntraced(function* (snapshot: string) {
          return yield* locked(
            Effect.gen(function* () {
              yield* Effect.logInfo("restore", { commit: snapshot })
              const result = yield* git([...core, ...args(["read-tree", snapshot])], { cwd: state.worktree })
              if (result.code === 0) {
                const checkout = yield* git([...core, ...args(["checkout-index", "-a", "-f"])], {
                  cwd: state.worktree,
                })
                if (checkout.code === 0) return
                yield* Effect.logError("failed to restore snapshot", {
                  snapshot,
                  exitCode: checkout.code,
                  stderr: checkout.stderr,
                })
                return
              }
              yield* Effect.logError("failed to restore snapshot", {
                snapshot,
                exitCode: result.code,
                stderr: result.stderr,
              })
            }),
          )
        })

        const revert = Effect.fnUntraced(function* (patches: Patch[]) {
          return yield* locked(
            Effect.gen(function* () {
              const all: { hash: string; file: string; rel: string }[] = []
              const seen = new Set<string>()
              for (const item of patches) {
                for (const file of item.files) {
                  if (seen.has(file)) continue
                  seen.add(file)
                  all.push({
                    hash: item.hash,
                    file,
                    rel: path.relative(state.worktree, file).replaceAll("\\", "/"),
                  })
                }
              }

              // Never delete a path the checkpoint left out on purpose: it is absent from the tree but existed.
              const records = new Map<string, BlockedAt>()
              const keep = Effect.fnUntraced(function* (op: (typeof all)[number]) {
                const known = records.get(op.hash) ?? (yield* blockedAt(op.hash))
                records.set(op.hash, known)
                if (!known.has(op.rel)) return false
                yield* Effect.logInfo("file was left out of the snapshot, keeping", { file: op.file, hash: op.hash })
                return true
              })

              const single = Effect.fnUntraced(function* (op: (typeof all)[number]) {
                yield* Effect.logInfo("reverting", { file: op.file, hash: op.hash })
                const result = yield* git([...core, ...args(["checkout", op.hash, "--", op.file])], {
                  cwd: state.worktree,
                })
                if (result.code === 0) return
                const tree = yield* git([...core, ...args(["ls-tree", op.hash, "--", op.rel])], {
                  cwd: state.worktree,
                })
                if (tree.code === 0 && tree.text.trim()) {
                  yield* Effect.logInfo("file existed in snapshot but checkout failed, keeping", {
                    file: op.file,
                    hash: op.hash,
                  })
                  return
                }
                if (yield* keep(op)) return
                yield* Effect.logInfo("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
                yield* remove(op.file)
              })

              // A hash that is empty (a checkpoints-off notice) or missing from this gitdir (the gitdir key
              // changed, or objects were lost) must never be read as "file did not exist": skip, never delete.
              const missing = new Set<string>()
              for (const hash of new Set(all.map((op) => op.hash))) {
                if (!hash) {
                  missing.add(hash)
                  continue
                }
                const check = yield* git([...core, ...args(["cat-file", "-e", `${hash}^{tree}`])], {
                  cwd: state.worktree,
                })
                if (check.code !== 0) missing.add(hash)
              }
              const ops = all.filter((op) => !missing.has(op.hash))
              if (ops.length !== all.length) {
                yield* Effect.logWarning("snapshot missing, not reverting", {
                  hashes: Array.from(missing),
                  files: all.length - ops.length,
                })
              }

              const clash = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)

              for (let i = 0; i < ops.length; ) {
                const first = ops[i]!
                const run = [first]
                let j = i + 1
                // Only batch adjacent files when their paths cannot affect each other.
                while (j < ops.length && run.length < 100) {
                  const next = ops[j]!
                  if (next.hash !== first.hash) break
                  if (run.some((item) => clash(item.rel, next.rel))) break
                  run.push(next)
                  j += 1
                }

                if (run.length === 1) {
                  yield* single(first)
                  i = j
                  continue
                }

                const tree = yield* git(
                  [...core, ...args(["ls-tree", "--name-only", first.hash, "--", ...run.map((item) => item.rel)])],
                  {
                    cwd: state.worktree,
                  },
                )

                if (tree.code !== 0) {
                  yield* Effect.logInfo("batched ls-tree failed, falling back to single-file revert", {
                    hash: first.hash,
                    files: run.length,
                  })
                  for (const op of run) {
                    yield* single(op)
                  }
                  i = j
                  continue
                }

                const have = new Set(
                  tree.text
                    .trim()
                    .split("\n")
                    .map((item) => item.trim())
                    .filter(Boolean),
                )
                const list = run.filter((item) => have.has(item.rel))
                if (list.length) {
                  yield* Effect.logInfo("reverting", { hash: first.hash, files: list.length })
                  const result = yield* git(
                    [...core, ...args(["checkout", first.hash, "--", ...list.map((item) => item.file)])],
                    {
                      cwd: state.worktree,
                    },
                  )
                  if (result.code !== 0) {
                    yield* Effect.logInfo("batched checkout failed, falling back to single-file revert", {
                      hash: first.hash,
                      files: list.length,
                    })
                    for (const op of run) {
                      yield* single(op)
                    }
                    i = j
                    continue
                  }
                }

                for (const op of run) {
                  if (have.has(op.rel)) continue
                  if (yield* keep(op)) continue
                  yield* Effect.logInfo("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
                  yield* remove(op.file)
                }

                i = j
              }
            }),
          )
        })

        const diff = Effect.fnUntraced(function* (hash: string) {
          return yield* locked(
            Effect.gen(function* () {
              yield* add()
              const result = yield* git([...quote, ...args(["diff", "--cached", "--no-ext-diff", hash, "--", "."])], {
                cwd: state.worktree,
              })
              if (result.code !== 0) {
                yield* Effect.logWarning("failed to get diff", {
                  hash,
                  exitCode: result.code,
                  stderr: result.stderr,
                })
                return ""
              }
              return result.text.trim()
            }),
          )
        })

        const diffFull = Effect.fnUntraced(function* (from: string, to: string) {
          return yield* locked(
            Effect.gen(function* () {
              type Row = {
                file: string
                status: "added" | "deleted" | "modified"
                binary: boolean
                additions: number
                deletions: number
              }

              type Ref = {
                file: string
                side: "before" | "after"
                ref: string
              }

              const show = Effect.fnUntraced(function* (row: Row) {
                if (row.binary) return ["", ""]
                if (row.status === "added") {
                  return [
                    "",
                    yield* git([...cfg, ...args(["show", `${to}:${row.file}`])]).pipe(Effect.map((item) => item.text)),
                  ]
                }
                if (row.status === "deleted") {
                  return [
                    yield* git([...cfg, ...args(["show", `${from}:${row.file}`])]).pipe(
                      Effect.map((item) => item.text),
                    ),
                    "",
                  ]
                }
                return yield* Effect.all(
                  [
                    git([...cfg, ...args(["show", `${from}:${row.file}`])]).pipe(Effect.map((item) => item.text)),
                    git([...cfg, ...args(["show", `${to}:${row.file}`])]).pipe(Effect.map((item) => item.text)),
                  ],
                  { concurrency: 2 },
                )
              })

              const load = Effect.fnUntraced(
                function* (rows: Row[]) {
                  const refs = rows.flatMap((row) => {
                    if (row.binary) return []
                    if (row.status === "added")
                      return [{ file: row.file, side: "after", ref: `${to}:${row.file}` } satisfies Ref]
                    if (row.status === "deleted") {
                      return [{ file: row.file, side: "before", ref: `${from}:${row.file}` } satisfies Ref]
                    }
                    return [
                      { file: row.file, side: "before", ref: `${from}:${row.file}` } satisfies Ref,
                      { file: row.file, side: "after", ref: `${to}:${row.file}` } satisfies Ref,
                    ]
                  })
                  if (!refs.length) return new Map<string, { before: string; after: string }>()

                  const batch = yield* appProcess.run(
                    ChildProcess.make("git", [...cfg, ...args(["cat-file", "--batch"])], {
                      cwd: state.directory,
                      extendEnv: true,
                    }),
                    { stdin: refs.map((item) => item.ref).join("\n") + "\n" },
                  )
                  if (batch.exitCode !== 0) {
                    yield* Effect.logInfo(
                      "git cat-file --batch failed during snapshot diff, falling back to per-file git show",
                      {
                        stderr: batch.stderr.toString("utf8"),
                        refs: refs.length,
                      },
                    )
                    return
                  }
                  const out = batch.stdout

                  const fail = (msg: string, extra?: Record<string, string>) => {
                    return undefined
                  }

                  const map = new Map<string, { before: string; after: string }>()
                  const dec = new TextDecoder()
                  let i = 0
                  for (const ref of refs) {
                    let end = i
                    while (end < out.length && out[end] !== 10) end += 1
                    if (end >= out.length) {
                      return fail(
                        "git cat-file --batch returned a truncated header during snapshot diff, falling back to per-file git show",
                      )
                    }

                    const head = dec.decode(out.slice(i, end))
                    i = end + 1
                    const hit = map.get(ref.file) ?? { before: "", after: "" }
                    if (head.endsWith(" missing")) {
                      map.set(ref.file, hit)
                      continue
                    }

                    const match = head.match(/^[0-9a-f]+ blob (\d+)$/)
                    if (!match) {
                      return fail(
                        "git cat-file --batch returned an unexpected header during snapshot diff, falling back to per-file git show",
                        { head },
                      )
                    }

                    const size = Number(match[1])
                    if (!Number.isInteger(size) || size < 0 || i + size >= out.length || out[i + size] !== 10) {
                      return fail(
                        "git cat-file --batch returned truncated content during snapshot diff, falling back to per-file git show",
                        { head },
                      )
                    }

                    const text = dec.decode(out.slice(i, i + size))
                    if (ref.side === "before") hit.before = text
                    if (ref.side === "after") hit.after = text
                    map.set(ref.file, hit)
                    i += size + 1
                  }

                  if (i !== out.length) {
                    return fail(
                      "git cat-file --batch returned trailing data during snapshot diff, falling back to per-file git show",
                    )
                  }

                  return map
                },
                Effect.scoped,
                Effect.catch(() =>
                  Effect.succeed<Map<string, { before: string; after: string }> | undefined>(undefined),
                ),
              )

              const result: FileDiff[] = []
              const status = new Map<string, "added" | "deleted" | "modified">()

              const statuses = yield* git(
                [...quote, ...args(["diff", "--no-ext-diff", "--name-status", "--no-renames", from, to, "--", "."])],
                { cwd: state.directory },
              )

              for (const line of statuses.text.trim().split("\n")) {
                if (!line) continue
                const [code, file] = line.split("\t")
                if (!code || !file) continue
                status.set(file, code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified")
              }

              const numstat = yield* git(
                [...quote, ...args(["diff", "--no-ext-diff", "--no-renames", "--numstat", from, to, "--", "."])],
                {
                  cwd: state.directory,
                },
              )

              const rows = numstat.text
                .trim()
                .split("\n")
                .filter(Boolean)
                .flatMap((line) => {
                  const [adds, dels, file] = line.split("\t")
                  if (!file) return []
                  const binary = adds === "-" && dels === "-"
                  const additions = binary ? 0 : parseInt(adds)
                  const deletions = binary ? 0 : parseInt(dels)
                  return [
                    {
                      file,
                      status: status.get(file) ?? "modified",
                      binary,
                      additions: Number.isFinite(additions) ? additions : 0,
                      deletions: Number.isFinite(deletions) ? deletions : 0,
                    } satisfies Row,
                  ]
                })

              // Hide ignored-file removals from the user-facing diff output.
              const ignored = yield* ignore(rows.map((r) => r.file))
              if (ignored.size > 0) {
                const filtered = rows.filter((r) => !ignored.has(r.file))
                rows.length = 0
                rows.push(...filtered)
              }

              const step = 100
              const patch = (file: string, before: string, after: string) =>
                formatPatch(structuredPatch(file, file, before, after, "", "", { context: Number.MAX_SAFE_INTEGER }))

              for (let i = 0; i < rows.length; i += step) {
                const run = rows.slice(i, i + step)
                const text = yield* load(run)

                for (const row of run) {
                  const hit = text?.get(row.file) ?? { before: "", after: "" }
                  const [before, after] = row.binary ? ["", ""] : text ? [hit.before, hit.after] : yield* show(row)
                  result.push({
                    file: row.file,
                    patch: row.binary ? "" : patch(row.file, before, after),
                    additions: row.additions,
                    deletions: row.deletions,
                    status: row.status,
                  })
                }
              }

              return result
            }),
          )
        })

        yield* cleanup().pipe(
          Effect.catchCause((cause) => Effect.logError("cleanup loop failed", { cause: Cause.pretty(cause) })),
          Effect.repeat(Schedule.spaced(Duration.hours(1))),
          Effect.delay(Duration.minutes(1)),
          Effect.forkScoped,
        )

        // Start the folder probe now so the first prompt does not pay for the walk.
        if (state.mode === "folder") {
          yield* Effect.gen(function* () {
            if ((yield* config.get()).snapshot === false) return
            yield* availability
          }).pipe(Effect.ignore, Effect.forkScoped)
        }

        return { cleanup, track, status, patch, restore, revert, diff, diffFull }
      }),
    )

    return Service.of({
      init: Effect.fn("Snapshot.init")(function* () {
        yield* InstanceState.get(state)
      }),
      cleanup: Effect.fn("Snapshot.cleanup")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.cleanup())
      }),
      track: Effect.fn("Snapshot.track")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.track())
      }),
      status: Effect.fn("Snapshot.status")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.status())
      }),
      patch: Effect.fn("Snapshot.patch")(function* (hash: string, input?: PatchInput) {
        return yield* InstanceState.useEffect(state, (s) => s.patch(hash, input))
      }),
      restore: Effect.fn("Snapshot.restore")(function* (snapshot: string) {
        return yield* InstanceState.useEffect(state, (s) => s.restore(snapshot))
      }),
      revert: Effect.fn("Snapshot.revert")(function* (patches: Patch[]) {
        return yield* InstanceState.useEffect(state, (s) => s.revert(patches))
      }),
      diff: Effect.fn("Snapshot.diff")(function* (hash: string) {
        return yield* InstanceState.useEffect(state, (s) => s.diff(hash))
      }),
      diffFull: Effect.fn("Snapshot.diffFull")(function* (from: string, to: string) {
        return yield* InstanceState.useEffect(state, (s) => s.diffFull(from, to))
      }),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, AppProcess.node, Config.node],
})

export * as Snapshot from "."
