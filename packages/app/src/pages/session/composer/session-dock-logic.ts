import type { Part, PermissionRequest, QuestionInfo, QuestionRequest, ToolPart } from "@opencode-ai/sdk/v2/client"
import { alwaysLabelKey, alwaysPatternsLabel } from "@/context/permission-mode"

/** Commands longer than this many lines start collapsed in the permission dock. */
export const COMMAND_MAX_LINES = 6

/** "Always allow" is offered only when the engine sent rules to save and the request is not a floor or guard prompt. */
export function showAlways(request: Pick<PermissionRequest, "always" | "guard">) {
  return !request.guard && request.always.length > 0
}

/**
 * What the "Always allow" button says and grants. `key` names the scope (legacy servers without alwaysScope get the old
 * label), `summary` is a short pattern list, and `patterns` lists every rule that would be saved. Accept edits switches
 * the whole session, so it lists no patterns.
 */
export function alwaysLabel(request: Pick<PermissionRequest, "always" | "alwaysScope">, everything?: string) {
  const key = alwaysLabelKey(request.alwaysScope)
  if (request.alwaysScope === "acceptEdits") return { key, summary: undefined, patterns: [] as string[] }
  const patterns = request.always.length === 1 && request.always[0] === "*" ? [] : [...request.always]
  return { key, summary: alwaysPatternsLabel(request.always, everything), patterns }
}

export function guardTitleKey(request: Pick<PermissionRequest, "guard">) {
  if (!request.guard) return undefined
  if (request.guard.level === "floor") return "ui.permission.guard.floor.title" as const
  return "ui.permission.guard.guard.title" as const
}

/**
 * The full shell command behind a request, when the engine sent one. Not only bash: the shell tool's
 * external_directory ask carries it too, and access outside the project must never be granted without seeing it.
 */
export function permissionCommand(request: Pick<PermissionRequest, "metadata">) {
  const command = request.metadata?.command
  if (typeof command !== "string" || command.trim() === "") return undefined
  return command
}

/** Files a bash command writes to (redirects, tee, cp/mv destinations), as the engine reported them. */
export function permissionWrites(request: Pick<PermissionRequest, "metadata">) {
  const writes = request.metadata?.writes
  if (!Array.isArray(writes)) return []
  return writes.filter((item): item is string => typeof item === "string" && item !== "")
}

/** Secret-scan findings as `file:line rule` (just `file rule` for a risky filename with no line). */
export function secretFindings(request: Pick<PermissionRequest, "guard" | "metadata">) {
  if (request.guard?.category !== "secret") return []
  const secrets = request.metadata?.secrets
  if (!Array.isArray(secrets)) return []
  return secrets.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const finding = item as { file?: unknown; line?: unknown; rule?: unknown }
    if (typeof finding.file !== "string" || typeof finding.rule !== "string") return []
    const line = typeof finding.line === "number" && finding.line > 0 ? `:${finding.line}` : ""
    return [`${finding.file}${line} ${finding.rule}`]
  })
}

/** The asking patterns listed under a command: every pattern that does more than repeat the whole command. */
export function commandPatterns(request: Pick<PermissionRequest, "patterns">, command: string | undefined) {
  if (!command) return [...request.patterns]
  const full = command.trim()
  return request.patterns.filter((pattern) => pattern.trim() !== full)
}

/**
 * Whether a long command starts collapsed. Floor and guard prompts always show it whole, so the sub-command that
 * triggered them can never sit behind "Show more".
 */
export function collapseCommand(request: Pick<PermissionRequest, "guard">) {
  return !request.guard
}

export function commandLineCount(command: string) {
  return command.split(/\r?\n/).length
}

/** The free-text row is shown unless the question explicitly disallows custom answers. */
export function showCustomRow(question: Pick<QuestionInfo, "custom"> | undefined) {
  return question?.custom !== false
}

/** Answers that may be sent for a question: without a custom row only offered option labels survive. */
export function allowedAnswers(question: Pick<QuestionInfo, "custom" | "options"> | undefined, answers: string[]) {
  if (!question || showCustomRow(question)) return answers
  return answers.filter((answer) => question.options.some((option) => option.label === answer))
}

/** The tool part that asked a question, found by the request's messageID/callID. */
export function findToolPart(parts: readonly Part[] | undefined, tool: QuestionRequest["tool"]) {
  if (!parts || !tool) return undefined
  return parts.find((part): part is ToolPart => part.type === "tool" && part.callID === tool.callID)
}

/** plan_exit's option for rejecting the plan; the user types what to change instead of just picking it. */
export const PLAN_KEEP_PLANNING = "No, keep planning"

/** Picking "No, keep planning" on a plan approval opens the feedback field rather than selecting the bare label. */
export function opensPlanFeedback(planApproval: boolean, label: string) {
  return planApproval && label === PLAN_KEEP_PLANNING
}

export function isPlanApproval(
  request: Pick<QuestionRequest, "tool"> | undefined,
  toolPart: Pick<ToolPart, "tool" | "callID"> | undefined,
) {
  if (toolPart?.tool !== "plan_exit") return false
  if (request?.tool && toolPart.callID && toolPart.callID !== request.tool.callID) return false
  return true
}

/** The plan file plan_exit recorded in its tool metadata before asking. */
export function planPath(toolPart: Pick<ToolPart, "state" | "metadata"> | undefined) {
  if (!toolPart) return undefined
  const state = toolPart.state as { metadata?: Record<string, unknown> } | undefined
  const value = state?.metadata?.planPath ?? toolPart.metadata?.planPath
  if (typeof value !== "string" || value.trim() === "") return undefined
  return value
}
