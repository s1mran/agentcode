// Pure state machine for the permission UI.
//
// Lives outside the JSX component so it can be tested independently. The
// machine has three stages:
//
//   permission → initial view with Allow once / Always / Reject options
//   always     → confirmation step (Confirm / Cancel)
//   reject     → text input for rejection message
//
// permissionRun() is the main transition: given the current state and the
// selected option, it returns a new state and optionally a PermissionReply
// to send to the SDK. The component calls this on enter/click.
//
// permissionInfo() extracts display info (icon, title, lines, diff) from
// the request, delegating to tool.ts for tool-specific formatting.
//
// Floor and guard requests (protected paths, critical removals, destructive
// git, likely secrets) and requests without always patterns never offer the
// always stage: the engine would only treat that answer as once.
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import type { PermissionReply } from "./types"
import { toolPath, toolPermissionInfo } from "./tool"

type Dict = Record<string, unknown>

// guard and alwaysScope are optional on the wire: older servers never send them.
export type PermissionRequestInput = PermissionRequest & {
  guard?: PermissionV1.Guard
  alwaysScope?: PermissionV1.AlwaysScope
}

export type PermissionStage = "permission" | "always" | "reject"
export type PermissionOption = "once" | "always" | "reject" | "confirm" | "cancel"

export type PermissionBodyState = {
  requestID: string
  stage: PermissionStage
  selected: PermissionOption
  message: string
  submitting: boolean
}

export type PermissionInfo = {
  icon: string
  title: string
  lines: string[]
  diff?: string
  file?: string
}

export type PermissionStep = {
  state: PermissionBodyState
  reply?: PermissionReply
}

function dict(v: unknown): Dict {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return {}
  }

  return { ...v }
}

function text(v: unknown): string {
  return typeof v === "string" ? v : ""
}

function data(request: PermissionRequestInput): Dict {
  const meta = dict(request.metadata)
  return {
    ...meta,
    ...dict(meta.input),
  }
}

function patterns(request: PermissionRequestInput): string[] {
  return request.patterns.filter((item): item is string => typeof item === "string")
}

export function createPermissionBodyState(requestID: string): PermissionBodyState {
  return {
    requestID,
    stage: "permission",
    selected: "once",
    message: "",
    submitting: false,
  }
}

/** Whether "Allow always" may be offered: the request has always patterns and no floor or guard. */
export function permissionAlwaysAvailable(request: PermissionRequestInput): boolean {
  return request.always.length > 0 && !request.guard
}

export function permissionOptions(stage: PermissionStage, request?: PermissionRequestInput): PermissionOption[] {
  if (stage === "permission") {
    if (request && !permissionAlwaysAvailable(request)) {
      return ["once", "reject"]
    }

    return ["once", "always", "reject"]
  }

  if (stage === "always") {
    return ["confirm", "cancel"]
  }

  return []
}

export function permissionInfo(request: PermissionRequestInput): PermissionInfo {
  const info = baseInfo(request)
  if (!request.guard) {
    return info
  }

  // The guard reason explains why this prompt cannot be pre-approved, so it leads. A diff view hides the lines, so
  // the title carries it too.
  const line = permissionGuardLine(request.guard)
  return {
    ...info,
    ...(info.diff ? { title: `${line} · ${info.title}` } : {}),
    lines: [line, ...info.lines],
  }
}

export function permissionGuardLine(guard: PermissionV1.Guard): string {
  return `${guard.level === "floor" ? "Protected" : "Needs review"}: ${guard.reason}`
}

function baseInfo(request: PermissionRequestInput): PermissionInfo {
  const pats = patterns(request)
  const input = data(request)
  const info = toolPermissionInfo(request.permission, input, dict(request.metadata), pats)
  if (info) {
    return info
  }

  if (request.permission === "external_directory") {
    const meta = dict(request.metadata)
    const raw = text(meta.parentDir) || text(meta.filepath) || pats[0] || ""
    const dir = raw.includes("*") ? raw.slice(0, raw.indexOf("*")).replace(/[\\/]+$/, "") : raw
    return {
      icon: "←",
      title: `Access external directory ${toolPath(dir, { home: true })}`,
      lines: pats.map((item) => `- ${item}`),
    }
  }

  if (request.permission === "doom_loop") {
    return {
      icon: "⟳",
      title: "Continue after repeated failures",
      lines: ["This keeps the session running despite repeated failures."],
    }
  }

  return {
    icon: "⚙",
    title: `Call tool ${request.permission}`,
    lines: [`Tool: ${request.permission}`],
  }
}

function alwaysScopeText(scope: PermissionV1.AlwaysScope | undefined): string {
  if (scope === "project") return "saved for this project"
  if (scope === "acceptEdits") return "switches this session to Accept edits"
  return "for this session"
}

export function permissionAlwaysLines(request: PermissionRequestInput): string[] {
  const scope = alwaysScopeText(request.alwaysScope)
  if (request.alwaysScope === "acceptEdits") {
    return [`This allows all edits inside the project and ${scope}.`]
  }

  if (request.always.length === 1 && request.always[0] === "*") {
    return [`This will allow ${request.permission} (${scope}).`]
  }

  return [`This will allow the following patterns (${scope}).`, ...request.always.map((item) => `- ${item}`)]
}

export function permissionLabel(option: PermissionOption): string {
  if (option === "once") return "Allow once"
  if (option === "always") return "Allow always"
  if (option === "reject") return "Reject"
  if (option === "confirm") return "Confirm"
  return "Cancel"
}

export function permissionReply(requestID: string, reply: PermissionReply["reply"], message?: string): PermissionReply {
  return {
    requestID,
    reply,
    ...(message && message.trim() ? { message: message.trim() } : {}),
  }
}

export function permissionShift(
  state: PermissionBodyState,
  dir: -1 | 1,
  request?: PermissionRequestInput,
): PermissionBodyState {
  const list = permissionOptions(state.stage, request)
  if (list.length === 0) {
    return state
  }

  const idx = Math.max(0, list.indexOf(state.selected))
  const selected = list[(idx + dir + list.length) % list.length]
  return {
    ...state,
    selected,
  }
}

export function permissionHover(state: PermissionBodyState, option: PermissionOption): PermissionBodyState {
  return {
    ...state,
    selected: option,
  }
}

export function permissionRun(
  state: PermissionBodyState,
  requestID: string,
  option: PermissionOption,
  request?: PermissionRequestInput,
): PermissionStep {
  if (state.submitting) {
    return { state }
  }

  const alwaysAvailable = !request || permissionAlwaysAvailable(request)
  if (state.stage === "permission") {
    if (option === "always") {
      if (!alwaysAvailable) {
        return { state }
      }

      return {
        state: {
          ...state,
          stage: "always",
          selected: "confirm",
        },
      }
    }

    if (option === "reject") {
      return {
        state: {
          ...state,
          stage: "reject",
          selected: "reject",
        },
      }
    }

    return {
      state,
      reply: permissionReply(requestID, "once"),
    }
  }

  if (state.stage !== "always") {
    return { state }
  }

  if (option === "cancel" || !alwaysAvailable) {
    return {
      state: {
        ...state,
        stage: "permission",
        selected: alwaysAvailable ? "always" : "once",
      },
    }
  }

  return {
    state,
    reply: permissionReply(requestID, "always"),
  }
}

export function permissionReject(state: PermissionBodyState, requestID: string): PermissionReply | undefined {
  if (state.submitting) {
    return undefined
  }

  return permissionReply(requestID, "reject", state.message)
}

export function permissionCancel(state: PermissionBodyState): PermissionBodyState {
  return {
    ...state,
    stage: "permission",
    selected: "reject",
  }
}

export function permissionEscape(state: PermissionBodyState, request?: PermissionRequestInput): PermissionBodyState {
  if (state.stage === "always") {
    return {
      ...state,
      stage: "permission",
      selected: !request || permissionAlwaysAvailable(request) ? "always" : "once",
    }
  }

  return {
    ...state,
    stage: "reject",
    selected: "reject",
  }
}
