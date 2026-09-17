export * as WorkspaceTrustRestrict from "./restrict"

import path from "path"
import { createHash } from "crypto"
import { Schema } from "effect"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import type { ConfigCommandV1 } from "@opencode-ai/core/v1/config/command"
import type { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import type { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import type { ConfigPluginV1 } from "@opencode-ai/core/v1/config/plugin"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { WorkspaceTrustLocationConfig } from "@opencode-ai/core/trust/location-config"
import { isRecord } from "@/util/record"
import { ConfigMarkdown } from "@/config/markdown"

/**
 * What project configuration may apply before a folder is trusted, and what is held until it is.
 *
 * `restricted` is an allowlist: a config key added later is held until someone decides it is safe. Everything held
 * either runs an executable the repository chooses or sends data somewhere the repository chooses. Deny and ask rules,
 * instruction files and skills inside the project, and themes always apply.
 *
 * `headless` is Claude Code `-p` parity: only project allow rules (top level and per agent) and
 * `default_permission_mode: acceptEdits` are held.
 */

export type Mode = "restricted" | "headless"

export const McpReason = Schema.Literals(["untrusted", "pending", "changed", "rejected"])
export type McpReason = Schema.Schema.Type<typeof McpReason>

export const HeldPlugin = Schema.Struct({
  kind: Schema.Literal("plugin"),
  spec: Schema.String,
  source: Schema.String,
}).annotate({ identifier: "TrustHeldPlugin" })

export const HeldTool = Schema.Struct({
  kind: Schema.Literal("tool"),
  file: Schema.String,
}).annotate({ identifier: "TrustHeldTool" })

export const HeldMcp = Schema.Struct({
  kind: Schema.Literal("mcp"),
  name: Schema.String,
  type: Schema.Literals(["local", "remote"]),
  command: Schema.optional(Schema.Array(Schema.String)),
  url: Schema.optional(Schema.String),
  source: Schema.String,
  reason: McpReason,
  fingerprint: Schema.String,
}).annotate({ identifier: "TrustHeldMcp" })

export const HeldPermission = Schema.Struct({
  kind: Schema.Literal("permission"),
  permission: Schema.String,
  pattern: Schema.String,
  source: Schema.String,
  agent: Schema.optional(Schema.String),
}).annotate({ identifier: "TrustHeldPermission" })

export const HeldCommand = Schema.Struct({
  kind: Schema.Literal("command"),
  name: Schema.String,
  source: Schema.String,
}).annotate({ identifier: "TrustHeldCommand" })

export const HeldSetting = Schema.Struct({
  kind: Schema.Literal("setting"),
  key: Schema.String,
  source: Schema.String,
  detail: Schema.optional(Schema.String),
}).annotate({ identifier: "TrustHeldSetting" })

export const HeldItem = Schema.Union([
  HeldPlugin,
  HeldTool,
  HeldMcp,
  HeldPermission,
  HeldCommand,
  HeldSetting,
]).annotate({
  identifier: "TrustHeldItem",
  discriminator: "kind",
})
export type HeldItem = Schema.Schema.Type<typeof HeldItem>
export type HeldMcp = Schema.Schema.Type<typeof HeldMcp>

/** Where the project is, so path-valued settings can be checked against it. */
export interface Scope {
  /** The trust root, the instance directory and the worktree. */
  readonly roots: ReadonlyArray<string>
  readonly directory: string
  readonly home: string
  /** Where a relative instructions entry stops searching upward (the instance worktree; `/` outside a repository). */
  readonly worktree?: string
}

// Project keys that never run anything or send data anywhere.
const KEEP = new Set([
  "$schema",
  "model",
  "small_model",
  "default_agent",
  "username",
  "subagent_depth",
  "enabled_providers",
  "disabled_providers",
  "compaction",
  "tool_output",
  "attachment",
  "watcher",
  "snapshot",
  "disable_bypass_permissions",
])

const SAFE_MODES = new Set(["default", "plan", "dontAsk"])
const SAFE_EXPERIMENTAL = ["disable_paste_summary", "primary_tools"] as const

function isUrl(value: string) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
}

function specifier(spec: ConfigPluginV1.Spec) {
  return Array.isArray(spec) ? String(spec[0]) : String(spec)
}

/**
 * Removes allow rules, keeping deny and ask rules in their original order. A string "allow" drops the key; an object
 * loses its allow patterns and is dropped when nothing is left.
 */
export function stripAllows(permission: ConfigPermissionV1.Info | string | undefined) {
  const removed: { permission: string; pattern: string }[] = []
  if (permission === undefined) return { permission: undefined, removed }
  const input: Record<string, unknown> = typeof permission === "string" ? { "*": permission } : permission
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue
    if (typeof value === "string") {
      if (value === "allow") removed.push({ permission: key, pattern: "*" })
      else next[key] = value
      continue
    }
    if (!isRecord(value)) continue
    const kept: Record<string, unknown> = {}
    for (const [pattern, action] of Object.entries(value)) {
      if (action === "allow") removed.push({ permission: key, pattern })
      else kept[pattern] = action
    }
    if (Object.keys(kept).length) next[key] = kept
  }
  return { permission: next as ConfigPermissionV1.Info, removed }
}

function permissionItems(
  removed: ReturnType<typeof stripAllows>["removed"],
  source: string,
  agent?: string,
): HeldItem[] {
  return removed.map((item) => ({ kind: "permission" as const, ...item, source, ...(agent ? { agent } : {}) }))
}

/** Agents (config `agent`/`mode` entries, or markdown agents) with their allow rules removed. */
export function restrictAgents<T extends Record<string, ConfigAgentV1.Info | undefined>>(agents: T, source: string) {
  const held: HeldItem[] = []
  const next: Record<string, ConfigAgentV1.Info | undefined> = {}
  for (const [name, agent] of Object.entries(agents)) {
    if (!agent || agent.permission === undefined) {
      next[name] = agent
      continue
    }
    const stripped = stripAllows(agent.permission)
    held.push(...permissionItems(stripped.removed, source, name))
    const copy = { ...agent }
    if (stripped.permission) copy.permission = stripped.permission
    else delete copy.permission
    next[name] = copy
  }
  return { agents: next as T, held }
}

/** Commands whose template runs shell (`!\`cmd\``) are held; the rest apply. */
export function restrictCommands(commands: Record<string, ConfigCommandV1.Info>, source: string) {
  const held: HeldItem[] = []
  const next: Record<string, ConfigCommandV1.Info> = {}
  for (const [name, command] of Object.entries(commands)) {
    if (ConfigMarkdown.shell(command.template).length) {
      held.push({ kind: "command", name, source })
      continue
    }
    next[name] = command
  }
  return { commands: next, held }
}

function setting(key: string, source: string, detail?: string): HeldItem {
  return { kind: "setting", key, source, ...(detail ? { detail } : {}) }
}

export function isMcpConfigured(entry: unknown): entry is ConfigMCPV1.Info {
  return isRecord(entry) && (entry.type === "local" || entry.type === "remote")
}

export function heldMcp(name: string, entry: ConfigMCPV1.Info, source: string, reason: McpReason): HeldMcp {
  return {
    kind: "mcp",
    name,
    type: entry.type,
    ...(entry.type === "local" ? { command: [...entry.command] } : { url: entry.url }),
    source,
    reason,
    fingerprint: mcpFingerprint(entry),
  }
}

function insideProject(item: string, scope: Scope) {
  const expanded = item.startsWith("~/") ? path.join(scope.home, item.slice(2)) : item
  const resolved = path.resolve(scope.directory, expanded)
  const home = path.resolve(scope.home)
  return scope.roots.some((root) => root !== "/" && path.resolve(root) !== home && FSUtil.contains(root, resolved))
}

export function restrictSource(
  info: ConfigV1.Info,
  mode: Mode,
  source: string,
  scope: Scope,
): { info: ConfigV1.Info; held: HeldItem[] } {
  const held: HeldItem[] = []
  const next: Record<string, unknown> = {}

  const strip = (key: "permission", value: ConfigPermissionV1.Info) => {
    const stripped = stripAllows(value)
    held.push(...permissionItems(stripped.removed, source))
    if (stripped.permission && Object.keys(stripped.permission).length) next[key] = stripped.permission
  }
  const agents = (key: "agent" | "mode", value: NonNullable<ConfigV1.Info["agent"]>) => {
    const restricted = restrictAgents(value as Record<string, ConfigAgentV1.Info>, source)
    held.push(...restricted.held)
    next[key] = restricted.agents
  }

  if (mode === "headless") {
    for (const [key, value] of Object.entries(info)) {
      if (value === undefined) continue
      if (key === "permission") strip(key, value as ConfigPermissionV1.Info)
      else if (key === "agent" || key === "mode") agents(key, value as NonNullable<ConfigV1.Info["agent"]>)
      else if (key === "default_permission_mode" && value === "acceptEdits") held.push(setting(key, source, value))
      else next[key] = value
    }
    return { info: next as ConfigV1.Info, held }
  }

  for (const [key, value] of Object.entries(info)) {
    if (value === undefined) continue
    if (KEEP.has(key)) {
      next[key] = value
      continue
    }
    switch (key) {
      case "instructions": {
        // Only files inside the project: an untrusted config naming `~/.ssh/id_rsa` must not put it in the prompt.
        const list = value as string[]
        const local = list.filter((item) => WorkspaceTrustLocationConfig.instructionInside(item, scope))
        for (const item of list) if (!local.includes(item)) held.push(setting(key, source, item))
        if (local.length) next[key] = local
        break
      }
      case "skills": {
        const skills = value as NonNullable<ConfigV1.Info["skills"]>
        const paths = (skills.paths ?? []).filter((item) => insideProject(item, scope))
        for (const item of skills.paths ?? [])
          if (!paths.includes(item)) held.push(setting("skills.paths", source, item))
        for (const item of skills.urls ?? []) held.push(setting("skills.urls", source, item))
        if (paths.length) next[key] = { paths }
        break
      }
      case "tools": {
        const disabled = Object.fromEntries(Object.entries(value as Record<string, boolean>).filter((item) => !item[1]))
        if (Object.keys(disabled).length) next[key] = disabled
        break
      }
      case "formatter":
      case "lsp": {
        if (value === false) next[key] = value
        else held.push(setting(key, source))
        break
      }
      case "default_permission_mode": {
        if (SAFE_MODES.has(value as string)) next[key] = value
        else held.push(setting(key, source, value as string))
        break
      }
      case "permission":
        strip(key, value as ConfigPermissionV1.Info)
        break
      case "agent":
      case "mode":
        agents(key, value as NonNullable<ConfigV1.Info["agent"]>)
        break
      case "command": {
        const restricted = restrictCommands(value as Record<string, ConfigCommandV1.Info>, source)
        held.push(...restricted.held)
        if (Object.keys(restricted.commands).length) next[key] = restricted.commands
        break
      }
      case "experimental": {
        const experimental = value as Record<string, unknown>
        const kept = Object.fromEntries(
          SAFE_EXPERIMENTAL.filter((name) => experimental[name] !== undefined).map((name) => [
            name,
            experimental[name],
          ]),
        )
        for (const name of Object.keys(experimental)) {
          if (experimental[name] === undefined || name in kept) continue
          held.push(setting(`experimental.${name}`, source))
        }
        if (Object.keys(kept).length) next[key] = kept
        break
      }
      case "plugin": {
        for (const spec of value as ConfigPluginV1.Spec[]) held.push({ kind: "plugin", spec: specifier(spec), source })
        break
      }
      case "mcp": {
        for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
          if (isMcpConfigured(entry)) held.push(heldMcp(name, entry, source, "untrusted"))
        }
        break
      }
      default:
        held.push(setting(key, source))
    }
  }
  return { info: next as ConfigV1.Info, held }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value ?? null)
}

/**
 * Identifies what an approval covers: for a local server its command, cwd and environment names; for a remote server
 * its url, header names and whether OAuth is configured. Values are left out, so rotating a token does not ask again,
 * while a new command, url or variable does.
 */
export function mcpFingerprint(entry: ConfigMCPV1.Info) {
  const shape =
    entry.type === "local"
      ? {
          type: entry.type,
          command: entry.command,
          cwd: entry.cwd,
          environment: Object.keys(entry.environment ?? {}).sort(),
        }
      : {
          type: entry.type,
          url: entry.url,
          headers: Object.keys(entry.headers ?? {})
            .map((name) => name.toLowerCase())
            .sort(),
          oauth: entry.oauth === undefined ? "default" : entry.oauth === false ? "disabled" : "configured",
        }
  return createHash("sha256").update(canonical(shape)).digest("hex")
}

const LABELS: Record<HeldItem["kind"], string> = {
  plugin: "plugins",
  tool: "custom tools",
  mcp: "MCP servers",
  permission: "allow rules",
  command: "shell commands",
  setting: "settings",
}

/** One line, for a terminal: "2 plugins, 1 MCP server, 3 allow rules". */
export function summarize(held: ReadonlyArray<HeldItem>) {
  const counts = new Map<HeldItem["kind"], number>()
  for (const item of held) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1)
  return [...counts.entries()].map(([kind, count]) => `${count} ${LABELS[kind]}`).join(", ")
}
