import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Agent } from "./agent"

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent session's deny rules, explicit ask rules and external_directory
 *    rules. Parent agent restrictions only govern that agent; the subagent's own
 *    permissions determine its capabilities, but it keeps every deny and prompt
 *    the parent session was given.
 * 2. Default `todowrite` and `task` denies if the subagent's own ruleset
 *    doesn't explicitly configure them. The built-in defaults allow both for
 *    every agent, so built-in rules do not count as the subagent opting in.
 *
 * The permission mode (default, acceptEdits, plan, bypassPermissions, dontAsk)
 * is not carried through rules: Permission resolves it through the session
 * parent chain, so a subagent inherits its parent's mode and cannot loosen it.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  subagent: Agent.Info
}): PermissionV1.Ruleset {
  const configured = (permission: string) =>
    input.subagent.permission.some((rule) => rule.permission === permission && rule.source !== "builtin")
  const canTask = configured("task")
  const canTodo = configured("todowrite")
  return [
    ...input.parentSessionPermission
      .filter((rule) => rule.permission === "external_directory" || rule.action === "deny" || rule.action === "ask")
      .map(({ source: _source, ...rule }) => rule),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}
