import path from "path"
import { createHash, randomBytes } from "crypto"
import { lstat } from "fs/promises"
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser"
import { Effect, Option, Schema, Semaphore, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { Flag } from "@opencode-ai/core/flag/flag"
import type { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { InstanceState } from "@/effect/instance-state"
import { isRecord } from "@/util/record"
import { fromConfig } from "./evaluate"

// Per-project "Allow always" answers (D16), like Claude Code's .claude/settings.local.json. VCS projects keep them in
// <worktree>/.opencode/settings.local.json, which is excluded from git on first write; other projects keep them in
// global data, one file per directory. The file is ignored when git tracks it in any letter case or through a
// .opencode submodule (a repo cannot ship pre-approvals), when git cannot answer, when it or .opencode is a symlink,
// or when it does not parse (and is then never overwritten).

export const FILE = "settings.local.json"
export const EXCLUDE_LINE = "/.opencode/settings.local.json"
const GIT_TIMEOUT = "2 seconds"

const FileSchema = Schema.Struct({ permission: Schema.optional(ConfigPermissionV1.Info) })
const decodeFile = Schema.decodeUnknownExit(FileSchema)

/** The global-data file for a directory outside version control. Every such directory has project id "global". */
export function globalFile(directory: string) {
  const key = path.resolve(directory).normalize("NFC")
  const hash = createHash("sha256")
    .update(process.platform === "darwin" || process.platform === "win32" ? key.toLowerCase() : key)
    .digest("hex")
  return path.join(Global.Path.data, "permission", `${hash.slice(0, 32)}.json`)
}

/**
 * Whether `git ls-files -s -- ':(icase).opencode'` output shows the settings file tracked (in any letter case, which
 * a case-insensitive checkout serves at the lowercase path) or .opencode as a submodule.
 */
export function trackedIn(output: string) {
  return output.split("\n").some((line) => {
    const tab = line.indexOf("\t")
    if (tab === -1) return false
    const file = line
      .slice(tab + 1)
      .replace(/^"|"$/g, "")
      .toLowerCase()
    const mode = line.slice(0, line.indexOf(" "))
    return file === `.opencode/${FILE}` || (mode === "160000" && file === ".opencode")
  })
}

type Inspected = { kind: "missing" } | { kind: "unsafe"; reason: string } | { kind: "file"; key: string }

type State = {
  file: string
  vcs: boolean
  worktree: string
  cache?: { key: string; rules: PermissionV1.Rule[] }
  warned?: string
  tracked?: boolean
  excluded: boolean
}

export interface Interface {
  /** Rules saved for this project, or [] when the file is missing, unsafe or does not parse. */
  readonly rules: () => Effect.Effect<PermissionV1.Rule[]>
  /** Merges allow rules into the file. False when nothing could be saved (callers fall back to the session). */
  readonly add: (rules: ReadonlyArray<PermissionV1.Rule>) => Effect.Effect<boolean>
  readonly file: () => Effect.Effect<string>
}

/** Parses the file text into rules, or undefined when it is not valid. */
export function parse(text: string): { data: Record<string, unknown>; rules: PermissionV1.Rule[] } | undefined {
  if (!text.trim()) return { data: {}, rules: [] }
  const errors: ParseError[] = []
  const data = parseJsonc(text, errors, { allowTrailingComma: true })
  if (errors.length || !isRecord(data)) return
  const decoded = decodeFile(data, { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" })
  if (decoded._tag === "Failure") return
  return { data, rules: fromConfig(decoded.value.permission ?? {}) }
}

/** The file text with `rules` merged in as allow entries, keeping every existing entry (denies are never replaced). */
export function merge(text: string, rules: ReadonlyArray<PermissionV1.Rule>) {
  const parsed = parse(text)
  if (!parsed) return
  const current = parsed.data.permission
  const permission: Record<string, unknown> =
    typeof current === "string" ? { "*": current } : isRecord(current) ? { ...current } : {}
  let changed = false
  for (const rule of rules) {
    const value = permission[rule.permission]
    const entries: Record<string, unknown> =
      typeof value === "string" ? { "*": value } : isRecord(value) ? { ...value } : {}
    if (entries[rule.pattern] !== undefined) continue
    entries[rule.pattern] = rule.action
    permission[rule.permission] = entries
    changed = true
  }
  if (!changed) return { text, changed }
  const base = text.trim() ? text : "{}\n"
  const edits = modify(base, ["permission"], permission, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  })
  const next = applyEdits(base, edits)
  return { text: next.endsWith("\n") ? next : next + "\n", changed }
}

export const make = Effect.fnUntraced(function* (deps: {
  fs: FSUtil.Interface
  spawner: ChildProcessSpawner["Service"]
}) {
  const { fs, spawner } = deps
  const state = yield* InstanceState.make<State>((ctx) =>
    Effect.succeed({
      file: ctx.project.vcs ? path.join(ctx.worktree, ".opencode", FILE) : globalFile(ctx.directory),
      vcs: !!ctx.project.vcs,
      worktree: ctx.worktree,
      excluded: false,
    }),
  )

  const git = (args: string[], cwd: string) =>
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("git", args, {
          cwd,
          extendEnv: true,
          env: { GIT_OPTIONAL_LOCKS: "0" },
          stdin: "ignore",
        }),
      )
      const [text] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr))],
        { concurrency: 2 },
      )
      return { code: Number(yield* handle.exitCode), text }
    }).pipe(
      Effect.scoped,
      Effect.timeout(GIT_TIMEOUT),
      Effect.catchCause(() => Effect.succeed({ code: -1, text: "" })),
    )

  const warn = (s: State, reason: string) => {
    if (s.warned === reason) return Effect.void
    s.warned = reason
    return Effect.logWarning(reason, { file: s.file })
  }

  const inspect = (s: State) =>
    Effect.promise(async (): Promise<Inspected> => {
      if (s.vcs) {
        const dir = await lstat(path.dirname(s.file)).catch(() => undefined)
        if (dir?.isSymbolicLink())
          return { kind: "unsafe", reason: "symlinked .opencode ignored for settings.local.json" }
      }
      const info = await lstat(s.file).catch(() => undefined)
      if (!info) return { kind: "missing" }
      if (info.isSymbolicLink()) return { kind: "unsafe", reason: "symlinked settings.local.json ignored" }
      if (!info.isFile()) return { kind: "unsafe", reason: "settings.local.json is not a regular file" }
      return { kind: "file", key: `${info.mtimeMs}:${info.size}:${info.ino}` }
    })

  /** True when git tracks the file, or cannot tell (a failure or timeout is unsafe and is asked again next time). */
  const tracked = Effect.fnUntraced(function* (s: State) {
    if (!s.vcs) return false
    if (s.tracked !== undefined) return s.tracked
    const result = yield* git(["ls-files", "-s", "--", ":(icase).opencode"], s.worktree)
    if (result.code !== 0) return true
    s.tracked = trackedIn(result.text)
    return s.tracked
  })

  const rules: Interface["rules"] = Effect.fn("PermissionLocal.rules")(function* () {
    if (Flag.OPENCODE_DISABLE_PROJECT_CONFIG) return []
    const s = yield* InstanceState.get(state)
    const info = yield* inspect(s)
    if (info.kind === "missing") {
      s.cache = undefined
      return []
    }
    if (info.kind === "unsafe") {
      yield* warn(s, info.reason)
      return []
    }
    if (yield* tracked(s)) {
      yield* warn(s, "tracked settings.local.json ignored")
      return []
    }
    if (s.cache?.key === info.key) return s.cache.rules
    const text = yield* fs.readFileString(s.file).pipe(Effect.option)
    const parsed = Option.isSome(text) ? parse(text.value) : undefined
    if (!parsed) yield* warn(s, "settings.local.json could not be parsed; its rules are ignored")
    s.cache = { key: info.key, rules: parsed?.rules ?? [] }
    return s.cache.rules
  })

  const exclude = Effect.fnUntraced(function* (s: State) {
    const resolved = yield* git(["rev-parse", "--git-path", "info/exclude"], s.worktree)
    const target = resolved.code === 0 && resolved.text.trim() ? path.resolve(s.worktree, resolved.text.trim()) : ""
    const appended = target
      ? yield* appendLine(target, EXCLUDE_LINE).pipe(
          Effect.as(true),
          Effect.catchCause(() => Effect.succeed(false)),
        )
      : false
    if (appended) return
    yield* appendLine(path.join(path.dirname(s.file), ".gitignore"), FILE)
  })

  const appendLine = Effect.fnUntraced(function* (file: string, line: string) {
    const existing = yield* fs.readFileStringSafe(file)
    if (existing?.split(/\r?\n/).some((item) => item.trim() === line)) return
    yield* fs.ensureDir(path.dirname(file))
    const prefix = existing && !existing.endsWith("\n") ? "\n" : ""
    yield* fs.writeFileString(file, (existing ?? "") + prefix + line + "\n")
  })

  const write = Effect.fnUntraced(function* (file: string, text: string) {
    const dir = path.dirname(file)
    yield* fs.ensureDir(dir)
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`)
    yield* Effect.gen(function* () {
      yield* fs.writeFileString(tmp, text, { mode: 0o600 })
      yield* fs.chmod(tmp, 0o600)
      yield* fs.rename(tmp, file)
    }).pipe(Effect.onError(() => fs.remove(tmp, { force: true }).pipe(Effect.ignore)))
  })

  // Serializes read-merge-write so concurrent "Allow always" answers never drop each other.
  const lock = Semaphore.makeUnsafe(1)

  const add: Interface["add"] = Effect.fn("PermissionLocal.add")(function* (items) {
    if (Flag.OPENCODE_DISABLE_PROJECT_CONFIG || items.length === 0) return false
    const s = yield* InstanceState.get(state)
    return yield* Effect.gen(function* () {
      const info = yield* inspect(s)
      if (info.kind === "unsafe") {
        yield* warn(s, info.reason)
        return false
      }
      if (info.kind === "file" && (yield* tracked(s))) {
        yield* warn(s, "tracked settings.local.json ignored")
        return false
      }
      const text = info.kind === "file" ? yield* fs.readFileString(s.file) : ""
      const next = merge(text, items)
      if (!next) {
        yield* warn(s, "settings.local.json could not be parsed; it was not overwritten")
        return false
      }
      if (next.changed) yield* write(s.file, next.text)
      s.cache = undefined
      if (s.vcs && !s.excluded) {
        yield* exclude(s).pipe(Effect.catchCause((cause) => Effect.logWarning("git exclude failed", { cause })))
        s.excluded = true
      }
      return true
    }).pipe(
      lock.withPermits(1),
      Effect.catchCause((cause) =>
        Effect.logWarning("saving permission approvals failed", { file: s.file, cause }).pipe(Effect.as(false)),
      ),
    )
  })

  const file: Interface["file"] = () => InstanceState.use(state, (s) => s.file)

  return { rules, add, file } satisfies Interface
})

export * as PermissionLocalStore from "./local-store"
