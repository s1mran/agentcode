import type { Message, PermissionRequest } from "@opencode-ai/sdk/v2"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"

export type AutoPermissionRequest = Pick<PermissionRequest, "sessionID" | "tool" | "guard">

/**
 * Whether the TUI's --auto reply may approve a request once without showing it. Floor requests (protected paths,
 * critical removals) always need a person, and so does a request raised in plan mode: --auto must not turn plan
 * mode's read-only guarantee into approvals. The mode is read from the asking assistant message, which records the
 * mode it resolved (parents and agent included): first from the synced store, then from the server. A request whose
 * message cannot be read is shown to the user.
 */
export async function autoReplyAllowed(
  request: AutoPermissionRequest,
  lookup: {
    cached: (sessionID: string, messageID: string) => Message | undefined
    fetch: (sessionID: string, messageID: string) => Promise<Message | undefined>
  },
): Promise<boolean> {
  if (request.guard?.level === "floor") return false
  if (!request.tool) return true
  const info =
    lookup.cached(request.sessionID, request.tool.messageID) ??
    (await lookup.fetch(request.sessionID, request.tool.messageID).catch(() => undefined))
  if (info?.role !== "assistant") return false
  return info.permissionMode !== "plan" && info.agent !== "plan"
}

/**
 * Tracks the --auto decisions still waiting on a message lookup. A request answered elsewhere in the meantime (another
 * client, or the server re-deciding it after a mode change) is forgotten, so its late decision neither queues a stale
 * request nor replies to one that is gone.
 */
export function autoReplyTracker() {
  const waiting = new Set<string>()
  return {
    /** Runs `apply` with the decision, unless the request was answered while the decision was pending. */
    decide(requestID: string, decision: Promise<boolean>, apply: (allowed: boolean) => void) {
      waiting.add(requestID)
      return decision
        .catch(() => false)
        .then((allowed) => {
          if (waiting.delete(requestID)) apply(allowed)
        })
    },
    replied(requestID: string) {
      waiting.delete(requestID)
    },
  }
}

/**
 * Stores the launch --permission-mode on the session the TUI opens from --session, --continue or --fork. The config
 * default the worker gets from the flag only reaches sessions without a stored mode, so a resumed session needs it
 * set explicitly. Returns the server's refusal message, if any.
 */
export async function applyLaunchPermissionMode(
  update: (input: {
    sessionID: string
    permissionMode: PermissionV1.Mode
  }) => Promise<{ error?: unknown; data?: unknown }>,
  sessionID: string,
  mode: PermissionV1.Mode | undefined,
): Promise<string | undefined> {
  if (!mode) return
  const result = await update({ sessionID, permissionMode: mode }).catch((error: unknown) => ({ error }))
  if (!result.error) return
  const error = result.error
  if (error && typeof error === "object" && "data" in error) {
    const data = error.data
    if (data && typeof data === "object" && "message" in data && typeof data.message === "string") return data.message
  }
  if (error instanceof Error) return error.message
  return `permission mode ${mode} was not applied`
}
