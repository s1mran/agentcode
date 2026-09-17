export * as WorkspaceTrustLocationConfig from "./location-config"

import path from "path"
import { existsSync, realpathSync } from "fs"
import type { Effective } from "./state"

/**
 * Workspace trust for core's location config (`Config.entries()`), the second config system in the process: its
 * plugin host imports `{plugin,plugins}/*` and `plugins` entries, and its commands, agents, providers, MCP servers,
 * shell and references come from the same project files the engine's instance config restricts.
 *
 * - `restricted`: a project document keeps an allowlist of keys (allow rules removed, instructions and skills inside the
 *   project only, formatter/lsp only when disabled, commands without `!\`cmd\``), and project `.opencode` directories are left
 *   out entirely, so nothing under them is scanned or imported.
 * - `headless`: only allow rules are removed (top level and per agent).
 * - `full`: unchanged.
 */

type Rule = { readonly action: string; readonly resource: string; readonly effect: string }

const KEEP = new Set([
  "$schema",
  "model",
  "default_agent",
  "username",
  "snapshots",
  "watcher",
  "attachments",
  "tool_output",
  "compaction",
])

const SHELL = /!`([^`]+)`/

function isUrl(value: string) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
}

/** Where a project's path-valued settings are checked against. */
export interface InstructionScope {
  readonly directory: string
  /** The trust root, the instance directory and the worktree. */
  readonly roots: ReadonlyArray<string>
  readonly home: string
  /** Relative entries are searched for from `directory` up to here. Defaults to `directory`. */
  readonly worktree?: string
}

// The real path of `target`, resolving the longest prefix that exists, so a glob or a missing file still resolves the
// symlinked folders above it.
function realPrefix(target: string) {
  let current = target
  const rest: string[] = []
  for (;;) {
    if (existsSync(current)) {
      try {
        return path.join(realpathSync.native(current), ...rest)
      } catch {
        return target
      }
    }
    const parent = path.dirname(current)
    if (parent === current) return target
    rest.unshift(path.basename(current))
    current = parent
  }
}

function within(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/**
 * Whether a project `instructions` entry can only name files inside the project. Until a folder is trusted its config
 * must not pull files from elsewhere on disk (`~/.ssh/id_rsa`, `/etc/...`) into the system prompt. URLs, entries with a
 * `..` segment, absolute and `~/` paths outside the project, paths through a symlink that leaves it, and relative
 * entries in a folder with no repository to bound the upward search (which would reach home and `/`) all fail. The home
 * folder and `/` never count as the project, so a dotfiles repository in home does not make home the project.
 */
export function instructionInside(item: string, scope: InstructionScope) {
  if (isUrl(item)) return false
  const home = path.resolve(scope.home)
  const broad = (target: string) => target === home || path.parse(target).root === target
  const roots = [
    ...new Set(
      scope.roots
        .map((root) => path.resolve(root))
        .filter((root) => !broad(root))
        .flatMap((root) => [root, realPrefix(root)]),
    ),
  ]
  const inside = (target: string) =>
    roots.some((root) => within(root, target)) && roots.some((root) => within(root, realPrefix(target)))
  const expanded = item.startsWith("~/") ? path.join(home, item.slice(2)) : item
  if (expanded.split(/[\\/]/).includes("..")) return false
  if (path.isAbsolute(expanded)) return inside(path.resolve(expanded))
  const directory = path.resolve(scope.directory)
  const top = path.resolve(scope.worktree ?? scope.directory)
  if (broad(top) || !within(top, directory)) return false
  for (let current = directory; ; current = path.dirname(current)) {
    if (!inside(path.resolve(current, expanded))) return false
    if (current === top) return true
  }
}

function withoutAllows(rules: unknown) {
  return Array.isArray(rules) ? (rules as Rule[]).filter((rule) => rule.effect !== "allow") : rules
}

function agents(value: unknown, restricted: boolean) {
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value as Record<string, Record<string, unknown>>).map(([name, agent]) => {
      const next: Record<string, unknown> = { ...agent }
      if (next.permissions !== undefined) next.permissions = withoutAllows(next.permissions)
      // Per-agent request options can carry headers and a base URL.
      if (restricted) delete next.request
      return [name, next]
    }),
  )
}

/** The fields of a project config document that may apply in `mode`. */
export function restrictDocument(
  info: Record<string, unknown>,
  mode: Exclude<Effective, "full">,
  scope: InstructionScope,
): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(info)) {
    if (value === undefined) continue
    if (mode === "headless") {
      if (key === "permissions") next[key] = withoutAllows(value)
      else if (key === "agents") next[key] = agents(value, false)
      else next[key] = value
      continue
    }
    if (KEEP.has(key)) {
      next[key] = value
      continue
    }
    switch (key) {
      case "permissions":
        next[key] = withoutAllows(value)
        break
      case "agents":
        next[key] = agents(value, true)
        break
      case "instructions":
      case "skills": {
        const list = (value as string[]).filter((item) => {
          if (key === "instructions") return instructionInside(item, scope)
          if (isUrl(item)) return false
          const resolved = path.resolve(scope.directory, item)
          return scope.roots.some((root) => {
            const relative = path.relative(root, resolved)
            return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
          })
        })
        if (list.length) next[key] = list
        break
      }
      case "formatter":
      case "lsp":
        if (value === false) next[key] = value
        break
      case "commands": {
        const commands = Object.fromEntries(
          Object.entries(value as Record<string, { template: string }>).filter(
            ([, command]) => !SHELL.test(command.template),
          ),
        )
        if (Object.keys(commands).length) next[key] = commands
        break
      }
      default:
        // plugins, mcp, providers, shell, share, enterprise, references, autoupdate, experimental and any key added
        // later wait for trust.
        break
    }
  }
  return next
}
