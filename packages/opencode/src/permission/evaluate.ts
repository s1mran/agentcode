import os from "os"
import path from "path"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import type { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { TRUNCATION_DIR } from "@/tool/truncation-dir"
import { ProtectedPath } from "./protected"

// Pure permission decision (D3). Rules fall in three tiers:
// - explicit: every rule that is neither built-in nor a user catch-all (config at every scope, per-agent config,
//   session rules, the local settings file and "Allow always" approvals);
// - built-in: agent defaults tagged `source: "builtin"`;
// - catch-all: user rules for permission "*".
// Explicit denies always win, specific asks beat specific allows, and a specific pattern only refines a tool-level
// ask or allow. Built-in asks are the only answers that modes and read-only commands may loosen.

export type Via =
  | "explicit-deny"
  | "plan"
  | "floor"
  | "guard"
  | "spec-ask"
  | "spec-allow"
  | "tool-ask"
  | "tool-allow"
  | "builtin"
  | "catchall"
  | "readonly"
  | "mode"
  | "none"

export type Decision = {
  action: PermissionV1.Action
  rule?: PermissionV1.Rule
  guard?: PermissionV1.Guard
  via: Via
  withholdAlways?: boolean
  reason?: string
}

/** A resolved edit or external_directory target: absolute path, whether it is inside the project, and its floor. */
export type Target = {
  abs: string
  inProject: boolean
  floor?: { reason: string; category: PermissionV1.Guard["category"] }
}

export type DecideInput = {
  permission: string
  pattern: string
  hint?: PermissionV1.Hint
  rules: PermissionV1.Ruleset
  mode: PermissionV1.Mode
  planFile?: string
  edit?: Target
}

export const DONT_ASK_REASON = "Denied in Don't ask mode: this action would need approval"

export function planReason(planFile?: string) {
  if (!planFile) return "Plan mode is active: file edits are blocked. Call plan_exit when the plan is ready."
  return `Plan mode is active: only the plan file ${planFile} may be edited. Call plan_exit when the plan is ready.`
}

const caseInsensitive = () => process.platform === "darwin" || process.platform === "win32"

export function samePath(a: string, b: string) {
  const ci = caseInsensitive()
  return ProtectedPath.normalize(a, ci) === ProtectedPath.normalize(b, ci)
}

export function isExplicit(rule: PermissionV1.Rule) {
  return rule.source !== "builtin" && rule.permission !== "*"
}

/** Built-in rules followed by user catch-all rules, the tier that step 10 reads last-match-wins. */
function fallbackTier(rules: PermissionV1.Rule[]) {
  return [
    ...rules.filter((rule) => rule.source === "builtin"),
    ...rules.filter((rule) => rule.source !== "builtin" && rule.permission === "*"),
  ]
}

const TRUNCATION_GLOB = path.join(TRUNCATION_DIR, "*")

/**
 * The engine's own truncated tool output. Tools tell the model to read it there, so while the agent's built-in allow
 * for it is present it stays readable even under a user's tool-level external_directory deny or ask; only an explicit
 * deny naming that exact folder glob still applies.
 */
function truncationOutput(pattern: string, rules: PermissionV1.Rule[]): Decision | undefined {
  if (!samePath(pattern, TRUNCATION_GLOB)) return
  const named = (rule: PermissionV1.Rule) => samePath(rule.pattern, TRUNCATION_GLOB)
  const deny = rules.find((rule) => isExplicit(rule) && rule.action === "deny" && named(rule))
  if (deny) return { action: "deny", via: "explicit-deny", rule: deny }
  const allow = rules.find((rule) => rule.source === "builtin" && rule.action === "allow" && named(rule))
  if (allow) return { action: "allow", via: "builtin", rule: allow }
}

const RANK = { floor: 2, guard: 1 } as const

function worst(guards: Array<PermissionV1.Guard | undefined>) {
  return guards.reduce<PermissionV1.Guard | undefined>((acc, item) => {
    if (!item) return acc
    if (!acc) return item
    return RANK[item.level] > RANK[acc.level] ? item : acc
  }, undefined)
}

function guardOf(input: DecideInput): PermissionV1.Guard | undefined {
  const edit = input.edit
  const floor = edit?.floor
    ? ({ level: "floor", category: edit.floor.category, reason: edit.floor.reason, paths: [edit.abs] } as const)
    : undefined
  return worst([floor, input.hint?.guard])
}

export function decide(input: DecideInput): Decision {
  const { permission, pattern, hint, mode } = input
  const forms = [...new Set([pattern, hint?.strict, hint?.loose].filter((item): item is string => !!item))]
  // Allows match the strict form when the tool gives one (bash: the command without wrappers). Without one, the
  // loose form is the exact target too (webfetch: rules keyed by host, and older rules keyed by URL).
  const allowForms =
    hint?.strict !== undefined
      ? [hint.strict]
      : [...new Set([pattern, hint?.loose].filter((item): item is string => !!item))]
  const matchesAny = (rule: PermissionV1.Rule) => forms.some((form) => Wildcard.match(form, rule.pattern))
  const matchesAllow = (rule: PermissionV1.Rule) => allowForms.some((form) => Wildcard.match(form, rule.pattern))
  const relevant = input.rules.filter((rule) => Wildcard.match(permission, rule.permission))
  const explicit = relevant.filter(isExplicit)
  const spec = explicit.filter((rule) => rule.pattern !== "*")
  const tool = explicit.filter((rule) => rule.pattern === "*")
  const guard = guardOf(input)
  const result = (decision: Decision): Decision => ({
    ...decision,
    ...(guard ? { guard } : {}),
    ...(guard || decision.via === "spec-ask" ? { withholdAlways: true } : {}),
  })
  const asking = (via: Via, rule?: PermissionV1.Rule): Decision =>
    mode === "dontAsk"
      ? result({ action: "deny", via, rule, reason: DONT_ASK_REASON })
      : result({ action: "ask", via, rule })

  // 0. Truncated tool output (not a protected path, so it has no floor or guard).
  const truncation = permission === "external_directory" && !guard ? truncationOutput(pattern, relevant) : undefined
  if (truncation) return truncation

  // 1. Explicit denies can never be weakened by a mode, an approval or a later allow.
  const deny = explicit.find((rule) => rule.action === "deny" && matchesAny(rule))
  if (deny) return result({ action: "deny", via: "explicit-deny", rule: deny })

  // 2. Plan mode blocks every edit except the root session's plan file.
  if (mode === "plan" && permission === "edit") {
    if (input.planFile && input.edit && samePath(input.edit.abs, input.planFile))
      return { action: "allow", via: "plan" }
    return result({ action: "deny", via: "plan", reason: planReason(input.planFile) })
  }

  // 3. Safety floor: always asks, whatever rules or mode say.
  if (guard?.level === "floor") return asking("floor")

  // 4. Guard (destructive git, commit secrets): only bypassPermissions skips it.
  if (guard?.level === "guard") {
    if (mode === "bypassPermissions") return result({ action: "allow", via: "guard" })
    return asking("guard")
  }

  // 5. Specific asks beat specific allows and survive acceptEdits and bypassPermissions.
  const specAsk = spec.find((rule) => rule.action === "ask" && matchesAny(rule))
  if (specAsk) return asking("spec-ask", specAsk)

  // 6. Plan mode: commands that are not read-only ask even when an allow rule matches.
  if (mode === "plan" && permission === "bash" && !hint?.readOnly) return result({ action: "ask", via: "plan" })

  // 7. Specific allows (saved approvals included) match the stripped command only.
  const specAllow = spec.find((rule) => rule.action === "allow" && matchesAllow(rule))
  if (specAllow) return result({ action: "allow", via: "spec-allow", rule: specAllow })

  // 8-9. Tool-level ask, then tool-level allow.
  const toolAsk = tool.find((rule) => rule.action === "ask")
  if (toolAsk) return asking("tool-ask", toolAsk)
  const toolAllow = tool.find((rule) => rule.action === "allow")
  if (toolAllow) return result({ action: "allow", via: "tool-allow", rule: toolAllow })

  // 10. Built-in defaults and the user catch-all, last match wins.
  const fallback = fallbackTier(relevant).findLast((rule) =>
    rule.action === "allow" ? matchesAllow(rule) : matchesAny(rule),
  )
  const via: Via = !fallback ? "none" : fallback.source === "builtin" ? "builtin" : "catchall"
  if (fallback?.action === "deny") return result({ action: "deny", via, rule: fallback })
  if (fallback?.action === "allow") return result({ action: "allow", via, rule: fallback })
  if (via === "catchall") return asking(via, fallback)

  // A built-in ask, or no rule at all: the only answer that modes and read-only commands may loosen.
  if (hint?.readOnly) return result({ action: "allow", via: "readonly", rule: fallback })
  if (mode === "acceptEdits") {
    if (permission === "edit" && input.edit?.inProject && !input.edit.floor)
      return result({ action: "allow", via: "mode", rule: fallback })
    if (hint?.projectWrite) return result({ action: "allow", via: "mode", rule: fallback })
  }
  if (mode === "bypassPermissions") return result({ action: "allow", via: "mode", rule: fallback })
  return asking(via, fallback)
}

/** Combines per-pattern decisions: any deny denies, any ask asks (with the most severe guard), otherwise allow. */
export function combine(decisions: Decision[]): Decision {
  const deny = decisions.find((item) => item.action === "deny")
  if (deny) return deny
  const asks = decisions.filter((item) => item.action === "ask")
  if (asks.length === 0) return decisions[0] ?? { action: "allow", via: "none" }
  const guard = worst(asks.map((item) => item.guard))
  return {
    ...asks[0],
    ...(guard ? { guard } : {}),
    ...(asks.some((item) => item.withholdAlways) ? { withholdAlways: true } : {}),
  }
}

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

/** Legacy single-rule view of `decide` in default mode, without hints or plan, for callers that only need an action. */
export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  const decision = decide({ permission, pattern, rules: rulesets.flat(), mode: "default" })
  return decision.rule ?? { permission, pattern: "*", action: decision.action }
}

const EDIT_TOOLS = ["edit", "write", "apply_patch"]
const READ_TOOLS = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]

/**
 * Tools to hide from the model: an explicit tool-level deny matches the tool, or no explicit rule mentions it and the
 * last built-in or catch-all rule for it is a "*" deny.
 */
export function disabled(tools: string[], ruleset: PermissionV1.Ruleset): Set<string> {
  return new Set(
    tools.filter((tool) => {
      const permission = EDIT_TOOLS.includes(tool) ? "edit" : READ_TOOLS.includes(tool) ? "read" : tool
      const relevant = ruleset.filter((rule) => Wildcard.match(permission, rule.permission))
      const explicit = relevant.filter(isExplicit)
      if (explicit.some((rule) => rule.pattern === "*" && rule.action === "deny")) return true
      if (explicit.length > 0) return false
      const rule = fallbackTier(relevant).at(-1)
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}

export function visibleTools<T>(tools: Record<string, T>, ruleset: PermissionV1.Ruleset): Record<string, T> {
  const hidden = disabled(Object.keys(tools), ruleset)
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !hidden.has(name)))
}
