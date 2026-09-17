import type { PermissionAlwaysScope, PermissionMode } from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/core/util/encode"

export type { PermissionMode }

export const MODES = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
] as const satisfies readonly PermissionMode[]

/** The modes Shift+Tab cycles through, in order. */
export const CYCLE_MODES = ["default", "acceptEdits", "plan"] as const satisfies readonly PermissionMode[]

export function isMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value)
}

/** default -> acceptEdits -> plan -> default. bypassPermissions and dontAsk leave the cycle back to default. */
export function nextCycleMode(mode: PermissionMode | undefined): PermissionMode {
  const index = (CYCLE_MODES as readonly string[]).indexOf(mode ?? "default")
  if (index === -1) return "default"
  return CYCLE_MODES[(index + 1) % CYCLE_MODES.length]!
}

/** A folder default can never grant bypassPermissions (it needs the confirmation dialog) or silently deny with dontAsk. */
export function folderDefaultAllowed(mode: PermissionMode) {
  return mode !== "bypassPermissions" && mode !== "dontAsk"
}

export const FOLDER_MODES = MODES.filter(folderDefaultAllowed)

/** The folder-default choices in settings; a config default outside them (dontAsk, bypass) is listed while it applies. */
export function folderModeOptions(current: PermissionMode): PermissionMode[] {
  if ((FOLDER_MODES as readonly PermissionMode[]).includes(current)) return [...FOLDER_MODES]
  return [...FOLDER_MODES, current]
}

export function folderKey(directory: string) {
  return base64Encode(directory)
}

/**
 * The old client auto-accept store keyed `<b64dir>/*` for a folder and `<b64dir>/<sessionID>` or `<sessionID>` for a
 * session. Only folders that were auto-accepting become Accept edits; session keys and disabled folders are dropped.
 * It never produces bypassPermissions, which needs an explicit confirmation.
 */
export function migrateAutoAccept(old: Record<string, boolean> | undefined) {
  const result: Record<string, PermissionMode> = {}
  if (!old) return result
  for (const [key, value] of Object.entries(old)) {
    if (value !== true) continue
    if (!key.endsWith("/*")) continue
    const dir = key.slice(0, -2)
    if (!dir || dir.includes("/")) continue
    result[dir] = "acceptEdits"
  }
  return result
}

/** Whether the old client auto-accept store had anything switched on, at folder or session level. */
export function hadAutoAccept(old: Record<string, boolean> | undefined) {
  return Object.values(old ?? {}).some((value) => value === true)
}

// How much each non-narrowing mode approves on its own, as the engine ranks them.
const LOOSENESS: Partial<Record<PermissionMode, number>> = { default: 1, acceptEdits: 2, bypassPermissions: 3 }

/**
 * The effective mode for a session chain (self first), mirroring the engine's PermissionMode.pick: plan or dontAsk
 * anywhere on the chain carry down to subagents; otherwise the outermost stored mode (else the config default, else
 * `default`), which a descendant's stored mode may narrow but never loosen.
 */
export function resolveChainMode(
  chain: ReadonlyArray<{ permissionMode?: PermissionMode }>,
  configDefault?: PermissionMode,
): PermissionMode {
  const modes = chain.map((item) => item.permissionMode)
  if (modes.includes("plan")) return "plan"
  if (modes.includes("dontAsk")) return "dontAsk"
  const rank = (mode: PermissionMode) => LOOSENESS[mode] ?? 1
  let chosen: PermissionMode = modes.at(-1) ?? configDefault ?? "default"
  for (const mode of modes.slice(0, -1).reverse()) {
    if (mode !== undefined && rank(mode) <= rank(chosen)) chosen = mode
  }
  return chosen
}

/**
 * The folder a directory's default mode is stored under: sandboxes and worktrees resolve to their project's worktree,
 * so a session running in a worktree and a new-session draft in the project share one default.
 */
export function projectRoot(directory: string, projects: ReadonlyArray<{ worktree: string; sandboxes?: string[] }>) {
  const parents = new Map<string, string>()
  for (const project of projects) {
    for (const sandbox of project.sandboxes ?? []) {
      if (sandbox !== project.worktree) parents.set(sandbox, project.worktree)
    }
  }
  let current = directory
  const seen = new Set<string>([current])
  for (let next = parents.get(current); next !== undefined; next = parents.get(current)) {
    if (seen.has(next)) return directory
    seen.add(next)
    current = next
  }
  return current
}

/**
 * Serialises permission mode changes per session so the engine applies them in the order the user made them, and
 * skips a change that a newer one replaced before it was sent. `onPending` reports the newest requested mode while
 * any change for that session is outstanding, and undefined once the last one settles.
 */
export function createSessionModeQueue(input: {
  apply: (sessionID: string, directory: string, mode: PermissionMode) => Promise<boolean>
  onPending: (sessionID: string, mode: PermissionMode | undefined) => void
}) {
  const tails = new Map<string, Promise<unknown>>()
  const latest = new Map<string, object>()

  return (sessionID: string, directory: string, mode: PermissionMode): Promise<boolean> => {
    const token = {}
    latest.set(sessionID, token)
    input.onPending(sessionID, mode)
    const previous = tails.get(sessionID) ?? Promise.resolve()
    const run = previous
      .then(() => (latest.get(sessionID) === token ? input.apply(sessionID, directory, mode) : false))
      .catch(() => false)
    tails.set(sessionID, run)
    return run.then((applied) => {
      if (latest.get(sessionID) === token) {
        latest.delete(sessionID)
        tails.delete(sessionID)
        input.onPending(sessionID, undefined)
      }
      return applied
    })
  }
}

export function modeLabelKey(mode: PermissionMode) {
  return `prompt.permissionMode.${mode}` as const
}

export function modeDescriptionKey(mode: PermissionMode) {
  return `prompt.permissionMode.${mode}.description` as const
}

export function alwaysLabelKey(scope: PermissionAlwaysScope | undefined) {
  if (!scope) return "ui.permission.allowAlways" as const
  return `ui.permission.always.${scope}` as const
}

/** What "Always allow" grants, for display: undefined when nothing, `everything` for '*', else up to 3 patterns. */
export function alwaysPatternsLabel(always: readonly string[] | undefined, everything = "everything") {
  if (!always || always.length === 0) return undefined
  if (always.length === 1 && always[0] === "*") return everything
  const shown = always.slice(0, 3).join(", ")
  if (always.length <= 3) return shown
  return `${shown} +${always.length - 3}`
}

export function isGuarded(request: { guard?: unknown } | undefined) {
  return !!request?.guard
}

/** Choosing bypassPermissions must go through the confirmation dialog; every other mode applies directly. */
export function resolveModeSelection(mode: PermissionMode): "confirm" | "apply" {
  if (mode === "bypassPermissions") return "confirm"
  return "apply"
}
