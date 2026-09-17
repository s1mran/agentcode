import fs from "fs/promises"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"

// Checkpoints for folders that are not git repositories. These helpers stay pure (no Effect services)
// so the scope and size rules can be unit tested without an instance.

// Written as gitignore lines into the snapshot repo's own info/exclude when running in folder mode.
// A .gitignore in the folder can still re-include any of these (for example `!build/`).
export const DEFAULT_EXCLUDES: readonly string[] = [
  // Version control
  ".git/",
  ".hg/",
  ".svn/",
  ".jj/",
  // Dependencies
  "node_modules/",
  "bower_components/",
  "jspm_packages/",
  ".pnpm-store/",
  ".yarn/cache/",
  ".yarn/unplugged/",
  "vendor/bundle/",
  "Pods/",
  ".venv/",
  "venv/",
  "__pypackages__/",
  // Build output and caches
  "dist/",
  "build/",
  "out/",
  "target/",
  ".next/",
  ".nuxt/",
  ".svelte-kit/",
  ".output/",
  ".turbo/",
  ".parcel-cache/",
  ".vite/",
  ".cache/",
  "coverage/",
  ".gradle/",
  "DerivedData/",
  ".dart_tool/",
  "__pycache__/",
  "*.pyc",
  ".pytest_cache/",
  ".mypy_cache/",
  ".ruff_cache/",
  ".tox/",
  ".terraform/",
  // OS and editor junk
  ".DS_Store",
  "._*",
  ".Spotlight-V100/",
  ".Trashes/",
  ".fseventsd/",
  ".TemporaryItems/",
  "Thumbs.db",
  "ehthumbs.db",
  "desktop.ini",
  "$RECYCLE.BIN/",
  "*.swp",
  // AgentCode local state: a revert must never delete saved "Allow always" rules.
  ".opencode/settings.local.json",
]

// Directory entries from DEFAULT_EXCLUDES, used by the size probe. Single names match at any depth;
// entries with an inner slash (".yarn/cache") are anchored to the folder root, as in gitignore.
export const SKIP_DIRS = new Set(
  DEFAULT_EXCLUDES.filter((line) => line.endsWith("/") && !line.includes("*")).map((line) => line.slice(0, -1)),
)

export const LIMITS = {
  maxFileBytes: 2 * 1024 * 1024,
  maxFiles: 20_000,
  maxBytes: 512 * 1024 * 1024,
  probeMs: 5_000,
  // Extra time before a walk stuck on a single filesystem call (an iCloud stall) is abandoned.
  probeGraceMs: 1_000,
  // A walk that ran out of time is tried again after this long instead of turning checkpoints off for good.
  retryMs: 60_000,
}

export type Limits = typeof LIMITS

export type Unavailable = "root" | "home" | "data-dir" | "too-many-files" | "too-large" | "slow" | "no-git"

export type ProbeResult = { files: number; bytes: number; over?: "too-many-files" | "too-large" | "slow" }

export type Scope =
  | { mode: "git" | "folder"; worktree: string }
  | { mode: "off"; worktree: string; reason: Unavailable }

// Folders checkpoints must never capture: a filesystem root, the home folder or any of its
// ancestors, and anything overlapping AgentCode's own data directory. Callers pass realpaths.
export function refuse(dir: string, input: { home: string; data: string }): Unavailable | undefined {
  if (path.parse(dir).root === dir) return "root"
  if (input.home && FSUtil.contains(dir, input.home)) return "home"
  if (input.data && (FSUtil.contains(dir, input.data) || FSUtil.contains(input.data, dir))) return "data-dir"
  return undefined
}

export function resolveScope(input: {
  vcs?: string
  worktree: string
  directory: string
  home: string
  data: string
}): Scope {
  if (
    input.vcs === "git" &&
    path.parse(input.worktree).root !== input.worktree &&
    refuse(input.worktree, input) === undefined
  ) {
    return { mode: "git", worktree: input.worktree }
  }
  // Plain folders, OPENCODE_FAKE_VCS with a "/" worktree and a dotfiles repo at ~ opened from a
  // subfolder all checkpoint the opened directory on its own.
  const reason = refuse(input.directory, input)
  if (reason) return { mode: "off", worktree: input.directory, reason }
  return { mode: "folder", worktree: input.directory }
}

export async function probe(dir: string, limits: Limits = LIMITS): Promise<ProbeResult> {
  const started = Date.now()
  const late = () => Date.now() - started > limits.probeMs
  let files = 0
  let bytes = 0
  const queue = [""]
  const pending: string[] = []

  const measure = async () => {
    const sizes = await Promise.all(
      pending.splice(0).map((file) =>
        fs.lstat(path.join(dir, file)).then(
          (stat) => stat.size,
          () => 0,
        ),
      ),
    )
    for (const size of sizes) {
      files += 1
      bytes += size > limits.maxFileBytes ? 0 : size
    }
    if (files > limits.maxFiles) return "too-many-files" as const
    if (bytes > limits.maxBytes) return "too-large" as const
    // A walk that cannot finish in time says so: the folder may just sit on a slow or cold disk.
    if (late()) return "slow" as const
    return undefined
  }

  for (let next = 0; next < queue.length; next++) {
    const rel = queue[next]!
    const handle = await fs.opendir(path.join(dir, rel)).catch(() => undefined)
    if (!handle) continue
    try {
      for await (const entry of handle) {
        if (late()) return { files, bytes, over: "slow" }
        const child = rel ? `${rel}/${entry.name}` : entry.name
        // Never follow symlinks: a link to a large folder elsewhere must not turn checkpoints off.
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name) && !SKIP_DIRS.has(child)) queue.push(child)
          continue
        }
        if (!entry.isFile()) continue
        pending.push(child)
        if (pending.length < 64) continue
        const over = await measure()
        if (over) return { files, bytes, over }
      }
    } catch {
      // Unreadable or vanished directories are skipped.
    }
    const over = await measure()
    if (over) return { files, bytes, over }
  }
  return { files, bytes }
}

// The probe as the snapshot service uses it: bounded even when one filesystem call never returns, cached
// once it finishes, and walked again after a slow result so a cold disk does not turn checkpoints off for good.
export function prober(dir: string, limits: Limits = LIMITS, walk = probe) {
  let done: { result: ProbeResult; at: number } | undefined
  let pending: Promise<ProbeResult> | undefined
  return (): Promise<ProbeResult> => {
    if (done && (done.result.over !== "slow" || Date.now() - done.at < limits.retryMs)) {
      return Promise.resolve(done.result)
    }
    if (pending) return pending
    let timer: ReturnType<typeof setTimeout> | undefined
    const slow = new Promise<ProbeResult>((resolve) => {
      timer = setTimeout(() => resolve({ files: 0, bytes: 0, over: "slow" }), limits.probeMs + limits.probeGraceMs)
      timer.unref?.()
    })
    const current = Promise.race([walk(dir, limits).catch((): ProbeResult => ({ files: 0, bytes: 0 })), slow]).then(
      (result) => {
        clearTimeout(timer)
        done = { result, at: Date.now() }
        pending = undefined
        return result
      },
    )
    pending = current
    return current
  }
}
