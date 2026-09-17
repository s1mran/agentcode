import { Effect, Stream } from "effect"
import os from "os"
import { createWriteStream } from "node:fs"
import fsp from "node:fs/promises"
import * as Tool from "./tool"
import path from "path"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { PermissionLaunchMode } from "@opencode-ai/core/permission/launch-mode"
import { fileURLToPath } from "url"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@opencode-ai/core/shell"
import { ShellID } from "./shell/id"

import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { BashClassify } from "@/permission/bash-classify"
import { ProtectedPath } from "@/permission/protected"
import { SecretScan } from "@/permission/secret-scan"

export { Parameters } from "./shell/prompt"

const MAX_METADATA_LENGTH = 30_000
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
])
// PowerShell cmdlets that write their path arguments. The classifier reads bash commands, so these are checked here.
const PS_WRITERS = new Set([
  "set-content",
  "add-content",
  "clear-content",
  "out-file",
  "tee-object",
  "new-item",
  "copy-item",
  "move-item",
  "rename-item",
  "invoke-webrequest",
  "invoke-restmethod",
  "expand-archive",
  "export-csv",
  "export-clixml",
])
// PowerShell aliases (and Windows PowerShell's Unix-style ones) of file cmdlets, normalized in one place so the floor
// and the classifier see the cmdlet whatever name the model used.
const PS_ALIASES = new Map([
  ["sc", "set-content"],
  ["ac", "add-content"],
  ["clc", "clear-content"],
  ["ni", "new-item"],
  ["md", "new-item"],
  ["mkdir", "new-item"],
  ["cpi", "copy-item"],
  ["copy", "copy-item"],
  ["cp", "copy-item"],
  ["mi", "move-item"],
  ["move", "move-item"],
  ["mv", "move-item"],
  ["rni", "rename-item"],
  ["ren", "rename-item"],
  ["ri", "remove-item"],
  ["del", "remove-item"],
  ["erase", "remove-item"],
  ["rd", "remove-item"],
  ["rm", "remove-item"],
  ["rmdir", "remove-item"],
  ["tee", "tee-object"],
  ["iwr", "invoke-webrequest"],
  ["curl", "invoke-webrequest"],
  ["wget", "invoke-webrequest"],
  ["irm", "invoke-restmethod"],
  ["gc", "get-content"],
  ["type", "get-content"],
  ["cat", "get-content"],
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
// PowerShell parameters whose value is never a path (content, encodings, URLs, filters).
const VALUES = new Set(
  "-value -encoding -itemtype -type -stream -filter -include -exclude -credential -delimiter -uri -method -body -headers -contenttype -useragent".split(
    " ",
  ),
)
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

// Bash nodes whose commands run in a child shell, so a cd inside them never moves later commands.
const SUBSHELL = new Set(["subshell", "command_substitution", "process_substitution", "function_definition"])
const REDIRECT = new Set(["file_redirect", "heredoc_redirect", "herestring_redirect"])
const NESTED_DEPTH = 2
const SECRET_METADATA_LIMIT = 20
// Names a wildcard write target may expand to that the safety floor protects (permission/protected.ts).
const PROTECTED_NAMES = [
  ".git",
  ".opencode",
  ".agentcode",
  ".claude",
  ".vscode",
  ".idea",
  ".husky",
  ".devcontainer",
  ".ssh",
  ".gnupg",
  ".aws",
  ".config",
  "opencode",
  "agentcode",
  "fish",
  "Library",
  "LaunchAgents",
  "etc",
  "opencode.json",
  "opencode.jsonc",
  "agentcode.json",
  "agentcode.jsonc",
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
]
// Names that make a write whose target is only known at run time (or relative to an unknown folder) suspicious. The
// generic folder names of PROTECTED_NAMES (etc, Library, opencode...) are left out: they appear in ordinary commands.
const GENERIC_NAMES = new Set(["opencode", "agentcode", "fish", "Library", "etc", ".config"])
const STRONG_NAMES = new Set(
  PROTECTED_NAMES.filter((name) => !GENERIC_NAMES.has(name)).map((name) => name.toLowerCase()),
)
// A substitution or variable that names the git directory: `$(git rev-parse --git-dir)`, `$GIT_DIR`.
const GIT_DIR_DYNAMIC =
  /\bgit\b[^;&|)`]*\brev-parse\b[^;&|)`]*--(?:git-dir|git-path|git-common-dir|absolute-git-dir)|\$\{?GIT_(?:DIR|COMMON_DIR)\b/
const GUARD_RANK = { floor: 2, guard: 1 } as const
const UNPARSED_RM: PermissionV1.Guard = {
  level: "floor",
  category: "critical_rm",
  reason: "removes a critical path (the command could not be fully parsed)",
}

type Part = {
  type: string
  text: string
}

type Cwd = {
  path: string
  /** False after a cd whose target is only known at run time; `path` then holds the last known folder. */
  known: boolean
}

/** Redirects of a redirected_statement, keyed to the command (or group) they apply to. */
type Attached = {
  redirects: BashClassify.Redirect[]
  extra: string[]
  raw?: string
  group: boolean
}

type Sub = {
  parts: Part[]
  input: BashClassify.SubcommandInput
  c: BashClassify.Classified
  cwd: Cwd
}

type Commit = {
  plan: SecretScan.CommitPlan
  cwd: string
  /** The repository folder (git -C, a cd, an add in an unknown folder) is only known at run time. */
  unknown: boolean
}

/** What one sub-command (with any nested `sh -c` scripts) means for the permission decision. */
type Entry = {
  /** Source text asked about. Undefined for cd-only sub-commands, which never get a bash pattern. */
  pattern?: string
  strict: string
  loose: string
  readOnly: boolean
  projectWrite: boolean
  withholdAlways: boolean
  always?: string
  guard?: PermissionV1.Guard
  writes: string[]
  commits: Commit[]
}

type Env = {
  ps: boolean
  cmd: boolean
  shell: string
  instance: InstanceContext
  paths: ProtectedPath.PathContext
  /** External directories, with the floor guard of a protected target that caused one. */
  dirs: Map<string, PermissionV1.Guard | undefined>
  /**
   * Absolute paths (or `:/`) staged by `git add` sub-commands seen so far, for the commit secret scan. `path` is
   * undefined for an add in a folder only known at run time. Shared with nested scripts.
   */
  adds: { path?: string; force: boolean }[]
  /** Links created earlier in the command (absolute link path to its absolute target, undefined when unknown). */
  links: Map<string, string | undefined>
  /** The whole top-level command, for writes whose target is only known at run time. */
  command: string
}

type Scan = {
  dirs: Map<string, PermissionV1.Guard | undefined>
  entries: Entry[]
  secrets: SecretScan.Finding[]
}

type Chunk = {
  text: string
  size: number
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function expandBash(text: string, cwd: string) {
  return home(text)
    .replace(/^\$(?:HOME|\{HOME\})(?=$|[\\/])/, () => os.homedir())
    .replace(/^\$(?:PWD|\{PWD\})(?=$|[\\/])/, () => cwd)
}

/** Bash redirect operators and targets. `echo a >f b` parses `b` as a second destination; it is really an argument. */
function redirectsOf(nodes: Node[]) {
  const redirects: BashClassify.Redirect[] = []
  const extra: string[] = []
  for (const node of nodes) {
    if (node.type === "heredoc_redirect") {
      const inner = redirectsOf(node.namedChildren.filter((child): child is Node => child?.type === "file_redirect"))
      redirects.push(...inner.redirects)
      extra.push(...inner.extra)
      continue
    }
    if (node.type !== "file_redirect") continue
    const targets = node.namedChildren.filter((child): child is Node => !!child && child.type !== "file_descriptor")
    const op = node.children
      .filter((child): child is Node => !!child && (child.type === "file_descriptor" || !child.isNamed))
      .map((child) => child.text)
      .join("")
    if (!targets[0]) continue
    redirects.push({ op, target: targets[0].text })
    extra.push(...targets.slice(1).map((child) => child.text))
  }
  return { redirects, extra }
}

/** Splits one command node into the pieces the classifier expects, keeping source quoting. */
function subcommand(node: Node, ps: boolean): BashClassify.SubcommandInput {
  const words: string[] = []
  const assignments: string[] = []
  const redirects: BashClassify.Redirect[] = []
  for (const child of node.children) {
    if (!child) continue
    if (ps) {
      if (child.type === "command_name" || child.type === "command_name_expr") words.push(child.text)
      if (child.type !== "command_elements") continue
      for (const item of child.children) {
        if (!item || item.type === "command_argument_sep") continue
        if (item.type !== "redirection") {
          words.push(item.text)
          continue
        }
        const op = item.children.find((part) => part?.type === "file_redirection_operator")
        const file = item.children.find((part) => part?.type === "redirected_file_name")
        if (op && file) redirects.push({ op: op.text, target: file.text.trim() })
      }
      continue
    }
    if (child.type === "variable_assignment") {
      assignments.push(child.text)
      continue
    }
    if (REDIRECT.has(child.type)) {
      const found = redirectsOf([child])
      redirects.push(...found.redirects)
      words.push(...found.extra)
      continue
    }
    if (child.isNamed && child.type !== "comment") words.push(child.text)
  }
  return { words, assignments, redirects, raw: source(node) }
}

/** The node a redirected_statement's redirects belong to: tree-sitter hangs `a && b > f` on the whole list. */
function redirectOwner(body: Node): Node {
  if (body.type !== "list" && body.type !== "pipeline") return body
  const last = body.lastNamedChild
  return last ? redirectOwner(last) : body
}

function worse(current?: PermissionV1.Guard, next?: PermissionV1.Guard) {
  if (!next) return current
  if (!current) return next
  return GUARD_RANK[next.level] > GUARD_RANK[current.level] ? next : current
}

function globRegex(segment: string, caseInsensitive: boolean) {
  const parts: string[] = []
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]
    const end = c === "[" ? segment.indexOf("]", i + 2) : -1
    if (c === "*") parts.push("[^/]*")
    else if (c === "?") parts.push("[^/]")
    else if (end !== -1) {
      const body = segment.slice(i + 1, end)
      parts.push("[" + (body.startsWith("!") ? "^" + body.slice(1) : body).replaceAll("\\", "\\\\") + "]")
      i = end
    } else parts.push(c.replace(/[.+^${}()|\\[\]]/g, "\\$&"))
  }
  try {
    return new RegExp(`^${parts.join("")}$`, caseInsensitive ? "i" : "")
  } catch {
    return
  }
}

/**
 * A wildcard write target plus, for each wildcard segment, the path with that segment replaced by every protected
 * name it could match. A glob only expands to existing names, and without dotglob a leading `*` skips dot files.
 */
function globCandidates(file: string, caseInsensitive: boolean) {
  const segments = file.split(/[\\/]/)
  return [
    file,
    ...segments.flatMap((segment, index) => {
      if (!/[*?[]/.test(segment)) return []
      const pattern = globRegex(segment, caseInsensitive)
      return PROTECTED_NAMES.filter(
        (name) => (segment.startsWith(".") || !name.startsWith(".")) && (!pattern || pattern.test(name)),
      ).map((name) => [...segments.slice(0, index), name, ...segments.slice(index + 1)].join("/"))
    }),
  ]
}

function pathContext(instance: InstanceContext): ProtectedPath.PathContext {
  return {
    worktree: instance.worktree,
    directory: instance.directory,
    home: os.homedir(),
    configDirs: [Global.Path.config],
    caseInsensitive: process.platform === "darwin" || process.platform === "win32",
  }
}

function hintsOf(entries: Entry[]) {
  const hints = new Map<string, PermissionV1.Hint>()
  for (const entry of entries) {
    if (entry.pattern === undefined) continue
    const prev = hints.get(entry.pattern)
    const guard = worse(prev?.guard, entry.guard)
    hints.set(entry.pattern, {
      pattern: entry.pattern,
      readOnly: (prev?.readOnly ?? true) && entry.readOnly,
      projectWrite: (prev?.projectWrite ?? true) && entry.projectWrite,
      strict: prev?.strict ?? entry.strict,
      loose: prev?.loose ?? entry.loose,
      withholdAlways: (prev?.withholdAlways ?? false) || entry.withholdAlways,
      ...(guard ? { guard } : {}),
    })
  }
  return Array.from(hints.values())
}

/** "Allow always" rules: one per sub-command that needs approval, or none when any of them cannot be saved safely. */
function alwaysRules(entries: Entry[]) {
  const asked = entries.filter((entry) => entry.pattern !== undefined)
  if (asked.some((entry) => entry.guard)) return []
  const rules = new Set<string>()
  for (const entry of asked) {
    // Read-only commands run silently by default; their narrow rule only matters under a user's own ask rule.
    if (entry.readOnly) {
      if (entry.always !== undefined) rules.add(entry.always)
      continue
    }
    if (entry.withholdAlways || entry.always === undefined) return []
    rules.add(entry.always)
  }
  if (rules.size > BashClassify.LIMITS.maxAlways) return []
  return Array.from(rules)
}

function secretGuard(result: { findings: SecretScan.Finding[]; incomplete: boolean }): PermissionV1.Guard | undefined {
  const first = result.findings[0]
  if (!first) {
    if (!result.incomplete) return
    return { level: "guard", category: "secret", reason: "secret scan could not complete" }
  }
  const where = first.line > 0 ? `${first.file}:${first.line}` : first.file
  const more = result.findings.length > 1 ? ` (+${result.findings.length - 1} more)` : ""
  return {
    level: "guard",
    category: "secret",
    reason: `possible secret in ${where} (${first.rule})${more}`,
    paths: Array.from(new Set(result.findings.map((finding) => finding.file))),
  }
}

/** First bytes of a regular file (never a FIFO or device, which could block), or undefined. */
async function readHead(file: string) {
  const stat = await fsp.lstat(file).catch(() => undefined)
  if (!stat?.isFile()) return
  const handle = await fsp.open(file, "r").catch(() => undefined)
  if (!handle) return
  const buffer = Buffer.alloc(256 * 1024)
  const read = await handle.read(buffer, 0, buffer.length, 0).catch(() => undefined)
  await handle.close().catch(() => undefined)
  return read ? buffer.subarray(0, read.bytesRead).toString("utf-8") : undefined
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

/**
 * A PowerShell word in the form the (bash-quoting) classifier reads: known variables expanded like `expand`, and
 * backslashes, which PowerShell never treats as escapes, turned into slashes.
 */
/**
 * A cmd.exe word in the form the classifier reads: `^` escapes removed, %USERPROFILE%/%HOMEDRIVE%%HOMEPATH%/%CD%
 * expanded, any other %VAR% left as a run-time `$VAR`, and backslashes turned into slashes.
 */
function cmdWord(text: string, cwd: string) {
  return text
    .replace(/\^(.)/g, "$1")
    .replace(/%HOMEDRIVE%%HOMEPATH%|%USERPROFILE%/gi, () => os.homedir())
    .replace(/%CD%/gi, () => cwd)
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, key: string) => "$" + key)
    .replaceAll("\\", "/")
}

/** A sensitive environment file the read tool asks for (`*.env`, `*.env.*`, but not `*.env.example`). */
function sensitive(file: string | undefined) {
  const name = file?.split(/[\\/]/).at(-1)?.toLowerCase()
  if (!name) return false
  return (name.endsWith(".env") || name.includes(".env.")) && !name.endsWith(".env.example")
}

/** Why a write whose place is only known at run time could reach a protected path, from its text. */
function suspicious(text: string, hooks: boolean) {
  if (GIT_DIR_DYNAMIC.test(text)) return "names the git directory"
  const found = text
    .split(/[\s/\\'"=:;&|()`${}<>]+/)
    .find((part) => STRONG_NAMES.has(part.toLowerCase()) || (hooks && part.toLowerCase() === "hooks"))
  return found ? `mentions ${found}` : undefined
}

function psWord(text: string, cwd: string, shell: string) {
  return text
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/"'])/gi, (_, key: string) => auto(key, cwd, shell) || "")
    .replaceAll("\\", "/")
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  let skip = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (skip) {
      skip = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      skip = VALUES.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

const ask = Effect.fn("ShellTool.ask")(function* (
  ctx: Tool.Context,
  scan: Scan,
  input: { command: string },
  instance: InstanceContext,
) {
  if (scan.dirs.size > 0) {
    const directories = Array.from(scan.dirs.keys())
    const globs = directories.map((dir) => {
      if (process.platform === "win32") return FSUtil.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    const hints = directories.flatMap((dir, index) => {
      const guard = scan.dirs.get(dir)
      return guard ? [{ pattern: globs[index], guard }] : []
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      ...(hints.length > 0 ? { hints } : {}),
      metadata: {
        command: input.command,
        directories,
        patterns: globs,
      },
    })
  }

  // Read-only commands still go through ask: the engine allows them silently unless a user rule says otherwise.
  const hints = hintsOf(scan.entries)
  if (hints.length === 0) return
  const base = instance.worktree === "/" ? instance.directory : instance.worktree
  const writes = Array.from(new Set(scan.entries.flatMap((entry) => entry.writes)), (file) =>
    containsPath(file, instance) ? path.relative(base, file).replaceAll("\\", "/") || "." : file,
  )
  yield* ctx.ask({
    permission: ShellID.ToolID,
    patterns: hints.map((hint) => hint.pattern),
    always: alwaysRules(scan.entries),
    hints,
    metadata: {
      command: input.command,
      writes,
      ...(scan.secrets.length > 0 ? { secrets: scan.secrets.slice(0, SECRET_METADATA_LIMIT) } : {}),
    },
  })
})

function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}
const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FSUtil.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const flags = yield* RuntimeFlags.Service
    const defaultTimeoutMs = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000

    const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return FSUtil.normalizePath(file)
    })

    const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && FSUtil.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return FSUtil.normalizePath(path.resolve(root, FSUtil.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("ShellTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : expandBash(unquote(arg), cwd)
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    /**
     * Resolves a classifier path value. `abs` is the folder part before any wildcard (for containment), `full` the
     * whole wildcard path. Undefined when the path is only known at run time.
     */
    const target = Effect.fn("ShellTool.target")(function* (
      value: string | undefined,
      cwd: Cwd,
      ps: boolean,
      shell: string,
    ) {
      if (value === undefined) return
      const text = ps ? expand(value, cwd.path, shell) : expandBash(value, cwd.path)
      if (!text || dynamic(text, ps) || (!ps && /^~[^\\/]/.test(text))) return
      const file = ps ? provider(text) : text
      if (!file) return
      const glob = /[?*[]/.exec(file)
      if (glob && /(^|[\\/])\.\.([\\/]|$)/.test(file.slice(glob.index))) return
      return {
        abs: yield* resolvePath(glob ? file.slice(0, glob.index) || "." : file, cwd.path, shell),
        full: glob ? yield* resolvePath(file, cwd.path, shell) : undefined,
        relative: !path.isAbsolute(file) && !/^[a-z]:[\\/]/i.test(file),
      }
    })

    const addDir = Effect.fn("ShellTool.addDir")(function* (env: Env, file: string, guard?: PermissionV1.Guard) {
      const dir = (yield* fs.isDir(file)) ? file : path.dirname(file)
      env.dirs.set(dir, worse(env.dirs.get(dir), guard?.level === "floor" ? guard : undefined))
    })

    /** The lexical path plus its real location when the nearest existing ancestor is a symlink. */
    const realCandidates = Effect.fn("ShellTool.realCandidates")(function* (lexical: string) {
      const rest: string[] = []
      for (let dir = lexical; ; dir = path.dirname(dir)) {
        const real = yield* fs.realPath(dir).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (real !== undefined) return ProtectedPath.candidates(lexical, real, rest)
        if (path.dirname(dir) === dir) return [lexical]
        rest.unshift(path.basename(dir))
      }
    })

    const protect = Effect.fn("ShellTool.protect")(function* (
      file: string,
      glob: boolean,
      paths: ProtectedPath.PathContext,
    ) {
      for (const candidate of glob ? globCandidates(file, paths.caseInsensitive) : [file]) {
        for (const item of yield* realCandidates(candidate)) {
          const hit = ProtectedPath.protectedWrite(item, paths)
          if (hit) return hit
        }
      }
    })

    const moveTo = Effect.fn("ShellTool.moveTo")(function* (cwd: Cwd, cd: string, ps: boolean, shell: string) {
      const found = cd === "dynamic" ? undefined : yield* target(cd, cwd, ps, shell)
      if (!found || found.full) return { path: cwd.path, known: false }
      return { path: found.abs, known: cwd.known || !found.relative }
    })

    /** Sub-commands in execution order, each with the working directory it runs in. */
    const subcommands = Effect.fn("ShellTool.subcommands")(function* (
      root: Node,
      cwd: Cwd,
      ps: boolean,
      shell: string,
      cmdShell: boolean,
    ) {
      const subs: Sub[] = []
      const attached = new Map<number, Attached>()

      const isolated = Effect.fnUntraced(function* (node: Node, cwd: Cwd, group: ReadonlyArray<BashClassify.Redirect>) {
        const inner = { ...cwd }
        yield* walk(node, inner, group)
        return inner.path !== cwd.path || inner.known !== cwd.known
      })

      const walk = (node: Node, cwd: Cwd, inherited: ReadonlyArray<BashClassify.Redirect>): Effect.Effect<void> =>
        Effect.gen(function* () {
          const pending = attached.get(node.id)
          const group = pending?.group ? [...inherited, ...pending.redirects] : inherited
          if (node.type === "command") {
            const input = subcommand(node, ps)
            const own = pending && !pending.group ? pending : undefined
            const word = (text: string) =>
              ps ? psWord(text, cwd.path, shell) : cmdShell ? cmdWord(text, cwd.path) : text
            const full: BashClassify.SubcommandInput = {
              words: [...input.words, ...(own?.extra ?? [])].map(word),
              assignments: input.assignments,
              redirects: [...input.redirects, ...(own?.redirects ?? []), ...group].map((item) => ({
                op: item.op,
                target: word(item.target),
              })),
              raw: own?.raw ?? input.raw,
            }
            const classified = BashClassify.classify(full)
            // PowerShell aliases of Remove-Item (ri, del, rd, rm...) take its options, so their removals are read as it.
            const alias = ps ? PS_ALIASES.get(full.words[0]?.toLowerCase() ?? "") : undefined
            const c =
              alias === "remove-item"
                ? {
                    ...classified,
                    removes: BashClassify.classify({ ...full, words: ["Remove-Item", ...full.words.slice(1)] }).removes,
                  }
                : classified
            subs.push({ parts: parts(node), input: full, c, cwd: { ...cwd } })
            // Substitutions in the arguments run in a child shell and write to a pipe, not to the command's targets.
            for (const child of node.children) if (child) yield* ps ? walk(child, cwd, []) : isolated(child, cwd, [])
            if (c.cd !== undefined) Object.assign(cwd, yield* moveTo(cwd, c.cd, ps, shell))
            return
          }
          // PowerShell runs pipelines, script blocks and subexpressions in the same session location.
          if (ps) {
            for (const child of node.children) if (child) yield* walk(child, cwd, group)
            return
          }
          if (node.type === "redirected_statement") {
            const redirects = node.children.filter((child): child is Node => !!child && REDIRECT.has(child.type))
            for (const child of redirects) yield* isolated(child, cwd, [])
            const body = node.childForFieldName("body")
            if (!body) return
            const found = redirectsOf(redirects)
            const owner = redirectOwner(body)
            const prev = attached.get(owner.id)
            attached.set(owner.id, {
              redirects: [...(prev?.redirects ?? []), ...found.redirects],
              extra: owner.type === "command" ? [...(prev?.extra ?? []), ...found.extra] : [],
              raw:
                owner.type !== "command"
                  ? undefined
                  : owner.id === body.id
                    ? node.text.trim()
                    : [owner.text, ...redirects.map((child) => child.text)].join(" ").trim(),
              group: owner.type !== "command",
            })
            yield* walk(body, cwd, group)
            return
          }
          if (SUBSHELL.has(node.type)) {
            for (const child of node.children) if (child) yield* isolated(child, cwd, group)
            return
          }
          // Bash runs each pipeline element (and a backgrounded command) in a child shell. zsh keeps the last element
          // in the current shell, so a cd there leaves the directory unknown rather than unchanged.
          if (node.type === "pipeline") {
            const moved = yield* Effect.forEach(
              node.children.filter((child): child is Node => !!child),
              (child) => isolated(child, cwd, group),
            )
            if (moved.some(Boolean)) cwd.known = false
            return
          }
          for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i)
            if (!child) continue
            if (node.child(i + 1)?.type !== "&") {
              yield* walk(child, cwd, group)
              continue
            }
            if (yield* isolated(child, cwd, group)) cwd.known = false
          }
        })

      yield* walk(root, { ...cwd }, [])
      return subs
    })

    /** Where writing `file` lands through a link created earlier in the command, or null when that is unknown. */
    const throughLink = (env: Env, file: string) => {
      for (const [link, dest] of env.links) {
        const rel = path.relative(link, file)
        if (rel.startsWith("..") || path.isAbsolute(rel)) continue
        return dest === undefined ? null : path.join(dest, rel)
      }
    }

    /** protect() plus links created earlier in the same command, which are not on disk yet when this runs. */
    const protectWrite = Effect.fn("ShellTool.protectWrite")(function* (env: Env, file: string, glob: boolean) {
      const hit = yield* protect(file, glob, env.paths)
      if (hit) return hit
      const linked = throughLink(env, file)
      if (linked === null)
        return { reason: `writes through a link whose target is only known when the command runs (${file})` }
      if (linked !== undefined) return yield* protect(linked, glob, env.paths)
    })

    const inspect = Effect.fn("ShellTool.inspect")(function* (sub: Sub, env: Env, depth: number) {
      const { c, cwd } = sub
      const command = sub.parts
      const raw = env.ps || env.cmd ? command[0]?.text.toLowerCase() : command[0]?.text
      const name = env.ps && raw ? (PS_ALIASES.get(raw) ?? raw) : raw
      if (name && (FILES.has(name) || (raw && FILES.has(raw)) || (env.cmd && CMD_FILES.has(name)))) {
        for (const arg of pathArgs(command, env.ps, env.cmd)) {
          const resolved = yield* argPath(arg, cwd.path, env.ps, env.shell)
          yield* Effect.logInfo("resolved path", { arg, resolved })
          if (!resolved || containsPath(resolved, env.instance)) continue
          yield* addDir(env, resolved)
        }
      }

      const words = sub.input.words
      const head = env.ps || env.cmd ? words[0]?.toLowerCase() : words[0]
      const entry: Entry = {
        pattern: words.length > 0 && (!head || !CWD.has(head) || c.writes.length > 0) ? sub.input.raw : undefined,
        strict: c.strict,
        loose: c.loose,
        // After a cd to a folder only known at run time, even a read-only command could read anywhere.
        readOnly: c.readOnly && cwd.known,
        projectWrite: c.fsSafeCandidate && cwd.known,
        withholdAlways: false,
        writes: [],
        commits: [],
      }

      // Every path argument of a PowerShell writer is checked against the floor (sources included, to stay safe).
      if (env.ps && name && PS_WRITERS.has(name)) {
        for (const arg of pathArgs(command, true)) {
          const resolved = yield* argPath(arg, cwd.path, true, env.shell)
          if (!resolved) continue
          entry.writes.push(resolved)
          const hit = yield* protectWrite(env, resolved, false)
          if (!hit) continue
          const guard: PermissionV1.Guard = {
            level: "floor",
            category: "protected_path",
            reason: hit.reason,
            paths: [resolved],
          }
          entry.guard = worse(entry.guard, guard)
          entry.projectWrite = false
          if (!containsPath(resolved, env.instance)) yield* addDir(env, resolved, guard)
        }
      }

      for (const read of c.reads) {
        // Sensitive environment files ask like the read tool does, instead of running as a silent read-only command.
        if (sensitive(read.path)) {
          entry.readOnly = false
          entry.projectWrite = false
        }
        const found = yield* target(read.path, cwd, env.ps, env.shell)
        if (!found) {
          entry.readOnly = false
          entry.projectWrite = false
          continue
        }
        if (containsPath(found.abs, env.instance)) continue
        entry.projectWrite = false
        yield* addDir(env, found.abs)
      }

      for (const write of c.writes) {
        const found = yield* target(write.path, cwd, env.ps, env.shell)
        // Only known at run time, or relative to a folder only known at run time: judge it by what the command says.
        if (!found || (!cwd.known && found.relative)) {
          entry.projectWrite = false
          const why = suspicious(write.text ?? write.path ?? "", true) ?? (suspicious(env.command, false) || undefined)
          if (why)
            entry.guard = worse(entry.guard, {
              level: "floor",
              category: "protected_path",
              reason: `writes to a path only known when the command runs, and the command ${why}`,
            })
          if (!found) continue
        }
        const file = found.full ?? found.abs
        entry.writes.push(file)
        const hit = yield* protectWrite(env, file, !!found.full)
        // chmod/chown -R over the root, home or the project is as destructive as removing it.
        const critical = write.recursive
          ? ProtectedPath.criticalRemoval(cwd.known ? write.path : undefined, {
              recursive: true,
              glob: !!found.full,
              cwd: cwd.path,
              ctx: env.paths,
            })
          : undefined
        const guard: PermissionV1.Guard | undefined = hit
          ? { level: "floor", category: "protected_path", reason: hit.reason, paths: [file] }
          : critical
            ? {
                level: "floor",
                category: "critical_rm",
                reason: critical.reason.replace(/^removes/, "changes permissions or ownership of"),
                paths: [file],
              }
            : undefined
        entry.guard = worse(entry.guard, guard)
        if (guard || found.full) entry.projectWrite = false
        if (containsPath(found.abs, env.instance)) continue
        entry.projectWrite = false
        yield* addDir(env, found.abs, guard)
      }

      // Links, after this command's own writes (creating a link never writes its target): later writes in the command
      // through the link land in its target, which is not on disk yet when this check runs.
      for (const link of c.links) {
        const at = yield* target(link.path, cwd, env.ps, env.shell)
        if (!at || at.full) continue
        const dest =
          link.target === undefined
            ? undefined
            : link.symbolic && !/^[/~$]/.test(link.target) && !/^[a-z]:[\\/]/i.test(link.target)
              ? yield* target(link.target, { path: path.dirname(at.abs), known: cwd.known }, env.ps, env.shell)
              : yield* target(link.target, cwd, env.ps, env.shell)
        env.links.set(at.abs, dest && !dest.full && cwd.known ? dest.abs : undefined)
      }

      for (const remove of c.removes) {
        const critical = ProtectedPath.criticalRemoval(cwd.known ? remove.path : undefined, {
          recursive: remove.recursive,
          glob: remove.glob,
          within: remove.within,
          cwd: cwd.path,
          ctx: env.paths,
        })
        const found = yield* target(remove.path, cwd, env.ps, env.shell)
        const file = found ? (found.full ?? found.abs) : undefined
        const hit =
          critical || file === undefined || c.name === "git"
            ? undefined
            : yield* protect(file, !!found?.full, env.paths)
        const guard: PermissionV1.Guard | undefined = critical
          ? { level: "floor", category: "critical_rm", reason: critical.reason, ...(file ? { paths: [file] } : {}) }
          : hit
            ? { level: "floor", category: "protected_path", reason: hit.reason, paths: [file!] }
            : undefined
        entry.guard = worse(entry.guard, guard)
        if (!found || guard || found.full) entry.projectWrite = false
        if (!found || containsPath(found.abs, env.instance)) continue
        entry.projectWrite = false
        yield* addDir(env, found.abs, guard)
      }

      for (const script of c.nested) {
        if (depth >= NESTED_DEPTH) {
          entry.readOnly = false
          if (BashClassify.fallbackCriticalRm(script)) entry.guard = worse(entry.guard, UNPARSED_RM)
          continue
        }
        const nested = yield* Effect.scoped(
          Effect.gen(function* () {
            const tree = yield* Effect.acquireRelease(parse(script, false), (tree) => Effect.sync(() => tree.delete()))
            return yield* collect(tree.rootNode, script, cwd, { ...env, ps: false, cmd: false }, depth + 1)
          }),
        )
        for (const item of nested) {
          entry.readOnly = entry.readOnly && item.readOnly
          entry.projectWrite = entry.projectWrite && item.projectWrite
          entry.guard = worse(entry.guard, item.guard)
          entry.writes.push(...item.writes)
          entry.commits.push(...item.commits)
        }
      }

      if (c.destructiveGit)
        entry.guard = worse(entry.guard, { level: "guard", category: "destructive_git", reason: c.destructiveGit })
      if (entry.guard?.level === "floor") entry.projectWrite = false
      // Rules match `*` and `?` as wildcards, so a saved rule may only end in the " *" of a command prefix.
      const broad =
        c.always !== undefined && /[*?]/.test(c.always === c.strict ? c.always : c.always.replace(/ \*$/, ""))
      // Saved rules match the command without its redirects, so "Allow always" on `echo x > file` would approve every
      // later file write through echo. A redirect to a file counts as an edit: approve it once.
      const redirectWrite = c.writes.some((write) => write.kind === "redirect")
      entry.always = broad || redirectWrite || (c.readOnly && !entry.readOnly) ? undefined : c.always
      entry.withholdAlways = !entry.readOnly && entry.always === undefined
      return entry
    })

    const collect = Effect.fn("ShellTool.collect")(function* (
      root: Node,
      command: string,
      cwd: Cwd,
      env: Env,
      depth: number,
    ): Effect.fn.Return<Entry[]> {
      const subs = yield* subcommands(root, cwd, env.ps, env.shell, env.cmd)
      const entries: Entry[] = []
      // The folder git runs in: the sub-command's folder moved by each `git -C`.
      const gitFolder = (cwd: Cwd, dirs: (string | undefined)[] = []) =>
        dirs.reduce<Cwd>(
          (dir, next) =>
            next === undefined || dynamic(next, false) || /^~[^\\/]/.test(next)
              ? { path: dir.path, known: false }
              : { path: path.resolve(dir.path, expandBash(next, dir.path)), known: dir.known },
          cwd,
        )
      for (const sub of subs) {
        const entry = yield* inspect(sub, env, depth)
        if (sub.c.gitCommit) {
          const { dirs, ...plan } = sub.c.gitCommit
          const dir = gitFolder(sub.cwd, dirs)
          // Paths staged earlier are stored absolute, so they stay right when the commit runs in another folder.
          const relative = (file: string) => (file.startsWith(":") ? file : path.relative(dir.path, file) || ".")
          entry.commits.push({
            plan: {
              ...plan,
              addPaths: env.adds.flatMap((item) => (item.path === undefined ? [] : [relative(item.path)])),
              forcePaths: env.adds.flatMap((item) =>
                item.force && item.path !== undefined ? [relative(item.path)] : [],
              ),
            },
            cwd: dir.path,
            unknown: !dir.known || env.adds.some((item) => item.path === undefined),
          })
        }
        if (sub.c.gitAdd) {
          const dir = gitFolder(sub.cwd, sub.c.gitAdd.dirs)
          const force = sub.c.gitAdd.force === true
          if (!dir.known) env.adds.push({ force })
          for (const file of sub.c.gitAdd.paths)
            env.adds.push({ path: file.startsWith(":") ? file : path.resolve(dir.path, file), force })
        }
        entries.push(entry)
      }

      const failed =
        root.hasError ||
        command.length > BashClassify.LIMITS.maxChars ||
        subs.length > BashClassify.LIMITS.maxSubcommands
      if (!failed) return entries

      // A command the parser could not fully read is never read-only and never saved as "Allow always".
      const floor = BashClassify.fallbackCriticalRm(command) ? UNPARSED_RM : undefined
      const asked = entries.some((entry) => entry.pattern !== undefined)
        ? entries
        : [
            ...entries,
            {
              pattern: command.trim(),
              strict: command.trim(),
              loose: command.trim(),
              readOnly: false,
              projectWrite: false,
              withholdAlways: true,
              writes: [],
              commits: [],
            },
          ]
      return asked.map((entry) => ({
        ...entry,
        readOnly: false,
        projectWrite: false,
        withholdAlways: true,
        always: undefined,
        guard: worse(entry.guard, floor),
      }))
    })

    const gitOutput = (args: string[], cwd: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make("git", ["-c", "core.fsmonitor=false", ...args], {
              cwd,
              env: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
              extendEnv: true,
              stdin: "ignore",
              stderr: "ignore",
            }),
          )
          const out = { text: "", bytes: 0 }
          // Stop reading past the scan limit; the scan then reports itself incomplete and the process is killed.
          yield* Stream.runForEachWhile(Stream.decodeText(handle.stdout), (chunk) =>
            Effect.sync(() => {
              out.text += chunk
              out.bytes += Buffer.byteLength(chunk, "utf-8")
              return out.bytes <= SecretScan.LIMITS.maxBytes
            }),
          )
          if (out.bytes > SecretScan.LIMITS.maxBytes) return { code: 0, stdout: out.text }
          return { code: yield* handle.exitCode, stdout: out.text }
        }),
      )

    /** Commit secret scan (fail closed): an error or a timeout reports the scan as incomplete. */
    const scanSecrets = Effect.fn("ShellTool.scanSecrets")(function* (commit: Commit) {
      if (commit.unknown) return { findings: [] as SecretScan.Finding[], incomplete: true }
      const services = yield* Effect.context<never>()
      const controller = new AbortController()
      const run = Effect.runPromiseWith(services)
      const git: SecretScan.GitRunner = (args) => run(gitOutput(args, commit.cwd), { signal: controller.signal })
      return yield* Effect.tryPromise(() =>
        SecretScan.scanCommit(git, commit.plan, SecretScan.LIMITS, (file) => readHead(path.resolve(commit.cwd, file))),
      ).pipe(
        Effect.timeout("5 seconds"),
        Effect.catch(() => Effect.succeed({ findings: [] as SecretScan.Finding[], incomplete: true })),
        Effect.ensuring(Effect.sync(() => controller.abort())),
      )
    })

    const scanCommits = Effect.fn("ShellTool.scanCommits")(function* (entries: Entry[]) {
      const secrets: SecretScan.Finding[] = []
      for (const entry of entries) {
        for (const commit of entry.commits) {
          if (entry.guard) break
          const result = yield* scanSecrets(commit)
          secrets.push(...result.findings)
          entry.guard = secretGuard(result)
        }
      }
      return secrets
    })

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      // The launch mode is the parent's setting: a nested agent started from the shell must not inherit it.
      return {
        ...PermissionLaunchMode.inherited(),
        ...extra.env,
      }
    })

    const run = Effect.fn("ShellTool.run")(function* (
      input: {
        shell: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
      },
      ctx: Tool.Context,
    ) {
      const limits = yield* trunc.limits()
      const keep = limits.maxBytes * 2
      let full = ""
      let last = ""
      const list: Chunk[] = []
      let used = 0
      let file = ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let cut = false
      let expired = false
      let aborted = false

      const closeSink = Effect.fnUntraced(function* () {
        const stream = sink
        if (!stream) return
        sink = undefined
        if (stream.destroyed || stream.closed) return
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              let settled = false
              const done = () => {
                if (settled) return
                settled = true
                stream.off("close", done)
                stream.off("error", done)
                stream.off("finish", done)
                resolve()
              }
              stream.once("close", done)
              stream.once("error", done)
              stream.once("finish", done)
              stream.end(done)
            }),
        ).pipe(Effect.catch(() => Effect.void))
      })

      yield* ctx.metadata({
        metadata: {
          output: "",
        },
      })

      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(closeSink)
          const handle = yield* spawner.spawn(cmd(input.shell, input.command, input.cwd, input.env))

          yield* Effect.forkScoped(
            Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
              const size = Buffer.byteLength(chunk, "utf-8")
              list.push({ text: chunk, size })
              used += size
              while (used > keep && list.length > 1) {
                const item = list.shift()
                if (!item) break
                used -= item.size
                cut = true
              }

              last = preview(last + chunk)

              if (file) {
                sink?.write(chunk)
              } else {
                full += chunk
                if (Buffer.byteLength(full, "utf-8") > limits.maxBytes) {
                  return trunc.write(full).pipe(
                    Effect.andThen((next) =>
                      Effect.sync(() => {
                        file = next
                        cut = true
                        sink = createWriteStream(next, { flags: "a" })
                        full = ""
                      }),
                    ),
                    Effect.andThen(
                      ctx.metadata({
                        metadata: {
                          output: last,
                        },
                      }),
                    ),
                  )
                }
              }

              return ctx.metadata({
                metadata: {
                  output: last,
                },
              })
            }),
          )

          const abort = Effect.callback<void>((resume) => {
            if (ctx.abort.aborted) return resume(Effect.void)
            const handler = () => resume(Effect.void)
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })

          const timeout = Effect.sleep(`${input.timeout + 100} millis`)

          const exit = yield* Effect.raceAll([
            handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
            abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
            timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
          ])

          if (exit.kind === "abort") {
            aborted = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }
          if (exit.kind === "timeout") {
            expired = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }

          return exit.kind === "exit" ? exit.code : null
        }),
      ).pipe(Effect.orDie)

      const meta: string[] = []
      if (expired) {
        meta.push(
          `shell tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
        )
      }
      if (aborted) meta.push("User aborted the command")
      const raw = list.map((item) => item.text).join("")
      const end = tail(raw, limits.maxLines, limits.maxBytes)
      if (end.cut) cut = true
      if (!file && end.cut) {
        file = yield* trunc.write(raw)
      }

      let output = end.text
      if (!output) output = "(no output)"

      if (cut && file) {
        output = `...output truncated...\n\nFull output saved to: ${file}\n\n` + output
      }

      if (meta.length > 0) {
        output += "\n\n<shell_metadata>\n" + meta.join("\n") + "\n</shell_metadata>"
      }
      return {
        title: input.command,
        metadata: {
          output: last || preview(output),
          exit: code,
          truncated: cut,
          ...(cut && file ? { outputPath: file } : {}),
        },
        output,
      }
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = yield* trunc.limits()
        const prompt = ShellPrompt.render(name, process.platform, limits, defaultTimeoutMs)
        yield* Effect.logInfo("shell tool using shell", { shell })

        return {
          description: prompt.description,
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const instanceCtx = yield* InstanceState.context
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, instanceCtx.directory, shell)
                : instanceCtx.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = params.timeout ?? defaultTimeoutMs
              const ps = Shell.ps(shell)
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  const env: Env = {
                    ps,
                    cmd: ShellID.toKind(name) === "cmd",
                    shell,
                    instance: instanceCtx,
                    paths: pathContext(instanceCtx),
                    dirs: new Map(),
                    adds: [],
                    links: new Map(),
                    command: params.command,
                  }
                  const entries = yield* collect(tree.rootNode, params.command, { path: cwd, known: true }, env, 0)
                  if (!containsPath(cwd, instanceCtx) && !env.dirs.has(cwd)) env.dirs.set(cwd, undefined)
                  const secrets = yield* scanCommits(entries)
                  yield* ask(ctx, { dirs: env.dirs, entries, secrets }, params, instanceCtx)
                }),
              )

              return yield* run(
                {
                  shell,
                  command: params.command,
                  cwd,
                  env: yield* shellEnv(ctx, cwd),
                  timeout,
                },
                ctx,
              )
            }),
        }
      })
  }),
)
