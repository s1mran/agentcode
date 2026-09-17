import path from "path"

// Pure path checks for the permission safety floor. No filesystem access: callers
// resolve symlinks themselves and pass every candidate through `candidates`.

export type PathContext = {
  worktree: string
  directory: string
  home: string
  configDirs: string[]
  caseInsensitive: boolean
}

export type Hit = { reason: string }

const WINDOWS = /^[a-zA-Z]:(?:[\\/]|$)|^\\\\/
const AGENT_DIRS = [".opencode", ".agentcode", ".claude"]
const EDITOR_DIRS = [".vscode", ".idea", ".husky", ".devcontainer"]
const HOME_DIRS = [
  ".config/opencode",
  ".config/agentcode",
  ".config/fish",
  ".ssh",
  ".gnupg",
  ".aws",
  "Library/LaunchAgents",
]
const ROOT_CONFIG = ["opencode.json", "opencode.jsonc", "agentcode.json", "agentcode.jsonc"]
const BASENAMES = new Set([
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_logout",
  ".profile",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".zlogin",
  ".zlogout",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".envrc",
  ".mcp.json",
  ".claude.json",
  ".ripgreprc",
])

/** Absolute, '/'-separated, NFC form of a path; lowercased when the filesystem is case-insensitive. */
export function normalize(input: string, caseInsensitive = false) {
  const drive = /^[a-zA-Z]:$/.test(input) ? input + "\\" : input
  const resolved =
    WINDOWS.test(drive) || process.platform === "win32" ? path.win32.resolve(drive) : path.posix.resolve(drive)
  const slashed = resolved.replaceAll("\\", "/").normalize("NFC")
  const trimmed =
    slashed.length > 1 && slashed.endsWith("/") && !/^[a-zA-Z]:\/$/.test(slashed) ? slashed.slice(0, -1) : slashed
  return caseInsensitive ? trimmed.toLowerCase() : trimmed
}

function segments(normalized: string) {
  return normalized.split("/").filter(Boolean)
}

/** Segments of `child` below `parent` (both normalized), or undefined when it is not inside. */
function relative(child: string, parent: string) {
  if (child === parent) return []
  if (!child.startsWith(parent.endsWith("/") ? parent : parent + "/")) return
  return segments(child.slice(parent.length))
}

function rebuild(normalized: string, parts: string[]) {
  if (/^[a-zA-Z]:$/.test(parts[0] ?? "")) return parts.length === 1 ? parts[0] + "/" : parts.join("/")
  return (normalized.startsWith("//") ? "//" : "/") + parts.join("/")
}

function label(target: string, shown: string, ctx: PathContext) {
  const ci = ctx.caseInsensitive
  const shownParts = segments(shown)
  const project = [ctx.worktree, ctx.directory]
    .map((base) => normalize(base, ci))
    .filter((base) => base !== "/")
    .map((base) => relative(target, base))
    .find((rel) => rel !== undefined && rel.length > 0)
  if (project) return shownParts.slice(-project.length).join("/")
  const home = relative(target, normalize(ctx.home, ci))
  if (home) return ["~", ...shownParts.slice(shownParts.length - home.length)].join("/")
  return shown
}

/** Folders whose `.opencode`/`.agentcode`/`.claude` children hold agent configuration. */
function configBases(ctx: PathContext) {
  const ci = ctx.caseInsensitive
  const worktree = normalize(ctx.worktree, ci)
  const directory = normalize(ctx.directory, ci)
  const between = worktree === "/" ? undefined : relative(directory, worktree)
  const chain = between
    ? between.map((_, i) => rebuild(worktree, [...segments(worktree), ...between.slice(0, i + 1)]))
    : []
  return [...new Set([worktree, directory, ...chain, normalize(ctx.home, ci)])].filter((base) => base !== "/")
}

/** Why writing `abs` must always ask (safety floor), or undefined when the path is not protected. */
export function protectedWrite(abs: string, ctx: PathContext): Hit | undefined {
  const ci = ctx.caseInsensitive
  const target = normalize(abs, ci)
  const shown = normalize(abs)
  const parts = segments(target)
  const where = () => label(target, shown, ctx)

  if (parts.includes(".git")) return { reason: `writes inside .git (${where()})` }

  const agent = configBases(ctx).some((base) => {
    const rel = relative(target, base)
    if (!rel || rel.length === 0 || !AGENT_DIRS.includes(rel[0])) return false
    return !(rel[0] === ".opencode" && rel.length === 3 && rel[1] === "plans" && rel[2].endsWith(".md"))
  })
  if (agent) return { reason: `writes agent configuration (${where()})` }

  if (parts.some((part) => EDITOR_DIRS.includes(part)))
    return { reason: `writes editor or git hook configuration (${where()})` }

  if (BASENAMES.has(parts.at(-1) ?? "")) return { reason: `writes a shell or tool startup file (${where()})` }

  const root = [ctx.worktree, ctx.directory]
    .map((base) => normalize(base, ci))
    .some((base) => relative(target, base)?.length === 1 && ROOT_CONFIG.includes(parts.at(-1) ?? ""))
  if (root) return { reason: `writes project configuration (${where()})` }

  const dirs = [
    ...ctx.configDirs.map((dir) => ({ dir: normalize(dir, ci), name: normalize(dir) })),
    ...HOME_DIRS.map((dir) => ({ dir: normalize(path.join(ctx.home, dir), ci), name: "~/" + dir })),
  ]
  const inside = dirs.find((item) => relative(target, item.dir) !== undefined)
  if (inside) return { reason: `writes inside ${inside.name} (${where()})` }

  if (relative(target, "/etc") !== undefined || relative(target, "/private/etc") !== undefined)
    return { reason: `writes system configuration (${shown})` }
}

/** The lexical path plus, when a parent resolves elsewhere, the real parent joined with the remaining segments. */
export function candidates(lexical: string, realParent?: string, rest: string[] = []) {
  if (realParent === undefined) return [lexical]
  const real = WINDOWS.test(realParent) ? path.win32.join(realParent, ...rest) : path.join(realParent, ...rest)
  return real === lexical ? [lexical] : [lexical, real]
}

function expand(target: string, home: string, cwd: string) {
  if (target === "~") return home
  if (/^~[\\/]/.test(target)) return home + "/" + target.slice(2)
  return target
    .replace(/^\$(?:HOME|\{HOME\})(?=$|[\\/])/, () => home)
    .replace(/^\$(?:PWD|\{PWD\})(?=$|[\\/])/, () => cwd)
}

/** Segments that form the drive or UNC share of a normalized path (they never count as depth). */
function rootSegments(normalized: string) {
  const parts = segments(normalized)
  return /^[a-zA-Z]:$/.test(parts[0] ?? "") ? 1 : normalized.startsWith("//") ? 2 : 0
}

/** `within`: only entries inside `full` are removed, so the project folder itself is not critical (its parents are). */
function critical(full: string, shown: string, ctx: PathContext, within = false): Hit | undefined {
  const ci = ctx.caseInsensitive
  const parts = segments(full)
  const depth = parts.length - rootSegments(full)
  if (depth <= 0) return { reason: `removes the filesystem root (${shown})` }
  if (depth === 1) return { reason: `removes the top-level folder ${shown}` }
  const contains = (base: string, strict = false) => {
    const normalized = normalize(base, ci)
    if (normalized === full) return !strict
    return relative(normalized, full) !== undefined
  }
  if (contains(ctx.home)) return { reason: `removes the home folder or a folder that contains it (${shown})` }
  if (contains(ctx.worktree, within) || contains(ctx.directory, within))
    return { reason: `removes the project folder or a folder that contains it (${shown})` }
}

/** Glob segment matcher. Bracket expressions match any one character, so a class can never hide a match. */
function globSegment(segment: string, caseInsensitive: boolean) {
  const source = segment
    .replace(/\[(?:\[:[a-z]+:\]|[^\]])+\]/g, "\u0000")
    .replace(/[.+^${}()|\\[\]]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".")
    .replaceAll("\u0000", ".")
  return new RegExp(`^${source}$`, caseInsensitive ? "is" : "s")
}

/** A wildcard path that can expand to the filesystem root's children, home, the project or a folder containing them. */
function criticalGlob(full: string, shown: string, ctx: PathContext): Hit | undefined {
  const parts = segments(full)
  const skip = rootSegments(full)
  const first = parts.findIndex((part, index) => index >= skip && /[*?[]/.test(part))
  if (first === skip) return { reason: `removes top-level folders matching ${shown}` }
  const match = (part: string, name: string) =>
    /[*?[]/.test(part) ? globSegment(part, ctx.caseInsensitive).test(name) : part === name
  const folders = [ctx.home, ctx.worktree, ctx.directory].map((base) => normalize(base, ctx.caseInsensitive))
  const hit = folders.find((folder) => {
    const names = segments(folder)
    return parts.length <= names.length && parts.every((part, index) => match(part, names[index]))
  })
  if (hit)
    return {
      reason: `removes folders matching ${shown}, which include ${hit === folders[0] ? "the home folder" : "the project folder"} or a folder that contains it`,
    }
}

/**
 * Why removing `target` must always ask (safety floor). `target` undefined means the path is only known at
 * run time. `~`, `$HOME` and `$PWD` prefixes are expanded here; relative targets resolve against `cwd`.
 */
export function criticalRemoval(
  target: string | undefined,
  opts: { recursive: boolean; glob: boolean; cwd: string; ctx: PathContext; within?: boolean },
): Hit | undefined {
  // `~+` is the current folder; `~-` (previous folder) and `~user` (another home) are only known at run time.
  const known = target !== undefined && /^~[^/\\]/.test(target) && !/^~\+(?:$|[/\\])/.test(target) ? undefined : target
  if (known === undefined) {
    if (!opts.recursive && !opts.glob) return
    return { reason: "removes a path that is only known when the command runs" }
  }
  const expanded = expand(
    known.replace(/^~\+(?=$|[/\\])/, () => opts.cwd),
    opts.ctx.home,
    opts.cwd,
  )
  const joined =
    path.posix.isAbsolute(expanded) || WINDOWS.test(expanded)
      ? expanded
      : WINDOWS.test(opts.cwd)
        ? path.win32.resolve(opts.cwd, expanded)
        : path.posix.resolve(opts.cwd, expanded)
  const full = normalize(joined, opts.ctx.caseInsensitive)
  const shown = normalize(joined)
  const parts = segments(full)
  const wildcard = parts.findIndex((part) => /[*?[]/.test(part))
  if (wildcard === -1) return critical(full, shown, opts.ctx, opts.within)
  const matched = criticalGlob(full, shown, opts.ctx)
  if (matched) return matched
  // A segment with no literal characters (`*`, `.*`, `[a-z]*`) matches nearly everything inside its folder.
  if (!/^[.*?]+$/.test(parts[wildcard].replace(/\[(?:\[:[a-z]+:\]|[^\]])+\]/g, "?"))) return
  const folder = rebuild(shown, segments(shown).slice(0, wildcard))
  if (!critical(rebuild(full, parts.slice(0, wildcard)), folder, opts.ctx)) return
  return { reason: `removes everything inside ${folder} (${shown})` }
}

export * as ProtectedPath from "./protected"
