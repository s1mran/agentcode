import type { PermissionMode } from "@opencode-ai/sdk/v2/client"
import { nextCycleMode, resolveModeSelection } from "@/context/permission-mode"

export type PermissionModeTone = "neutral" | "success" | "info" | "critical" | "warning"

const TONES: Record<PermissionMode, PermissionModeTone> = {
  default: "neutral",
  acceptEdits: "success",
  plan: "info",
  bypassPermissions: "critical",
  dontAsk: "warning",
}

export function permissionModeTone(mode: PermissionMode): PermissionModeTone {
  return TONES[mode] ?? "neutral"
}

const TONE_CLASSES: Record<PermissionModeTone, string> = {
  neutral: "bg-icon-weak-base",
  success: "bg-icon-success-base",
  info: "bg-icon-info-base",
  critical: "bg-icon-critical-base",
  warning: "bg-icon-warning-base",
}

export function permissionModeToneClass(tone: PermissionModeTone) {
  return TONE_CLASSES[tone]
}

/** The pill offers the four selectable modes; dontAsk comes from config or the CLI and is only listed while active. */
export function permissionModeOptions(current: PermissionMode): PermissionMode[] {
  const options: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"]
  if (current === "dontAsk") options.push("dontAsk")
  return options
}

export type PermissionModeSelectorInput = {
  sessionID: () => string | undefined
  directory: () => string
  setSessionMode: (sessionID: string, directory: string, mode: PermissionMode) => Promise<boolean> | boolean
  setDraftMode: (directory: string, mode: PermissionMode) => void
  /** Shows the bypass confirmation; `apply` runs only when the user confirms. */
  confirm: (apply: () => Promise<boolean>) => void
}

/**
 * Selecting a mode: an existing session is updated on the engine right away, a draft keeps it locally until the session
 * is created. Neither rewrites the folder default, which only the settings page changes (like Claude Code, where
 * Shift+Tab is per session and defaultMode comes from settings). bypassPermissions always goes through the
 * confirmation first. The target is captured when the user selects, so confirming after navigating away still applies
 * to the session the choice was made in.
 */
export function createPermissionModeSelector(input: PermissionModeSelectorInput) {
  const apply = async (target: { sessionID?: string; directory: string }, mode: PermissionMode) => {
    if (target.sessionID) return input.setSessionMode(target.sessionID, target.directory, mode)
    input.setDraftMode(target.directory, mode)
    return true
  }

  const select = (mode: PermissionMode): Promise<boolean> => {
    const target = { sessionID: input.sessionID(), directory: input.directory() }
    if (resolveModeSelection(mode) === "confirm") {
      input.confirm(() => apply(target, mode))
      return Promise.resolve(false)
    }
    return apply(target, mode)
  }

  return {
    select,
    cycle: (current: PermissionMode) => select(nextCycleMode(current)),
  }
}

/**
 * The mode the composer shows (`current`) and sends (`submit`).
 * - A session shows the mode being applied, else the engine's effective mode for its chain; it sends only what is
 *   pending or stored on the session, so a session without a stored mode keeps whatever the engine resolves.
 * - A draft shows the explicit choice, else the folder default from settings, else the engine's config default; it
 *   sends only an explicit choice or folder default, so a config default_permission_mode still applies on create.
 */
export function resolveComposerMode(input: {
  sessionID?: string
  pending?: PermissionMode
  effective?: PermissionMode
  stored?: PermissionMode
  draft?: PermissionMode
  folder?: PermissionMode
  config?: PermissionMode
}): { current: PermissionMode; submit: PermissionMode | undefined } {
  if (input.sessionID) {
    return {
      current: input.pending ?? input.effective ?? input.stored ?? "default",
      submit: input.pending ?? input.stored,
    }
  }
  const explicit = input.draft ?? input.folder
  return { current: explicit ?? input.config ?? "default", submit: explicit }
}

type CycleKeyEvent = Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey" | "isComposing">

/** Shift+Tab in the composer cycles the mode unless a slash/mention popover is open or an IME is composing. */
export function shouldCycleModeOnKey(event: CycleKeyEvent, state: { popoverOpen: boolean; composing?: boolean }) {
  if (event.key !== "Tab" || !event.shiftKey) return false
  if (event.ctrlKey || event.metaKey || event.altKey) return false
  if (event.isComposing || state.composing) return false
  return !state.popoverOpen
}

/** The engine's built-in /plan command (a user command named plan replaces it and is not matched). */
export function isBuiltinPlanCommand(command: { name: string; agent?: string; template?: string }) {
  return command.name === "plan" && command.agent === "plan" && command.template?.trim() === "$ARGUMENTS"
}

/** The text after `/plan`, or undefined when the prompt is not a /plan command. Bare `/plan` returns "". */
export function planCommandArguments(text: string) {
  const match = /^\/plan(?:\s+([\s\S]*))?$/.exec(text)
  if (!match) return
  return (match[1] ?? "").trim()
}
