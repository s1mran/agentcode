import type { McpServer } from "@opencode-ai/client/promise"

/**
 * MCP statuses a server can report. `pending_approval` and `rejected` come from engines that enforce workspace trust:
 * a server from a folder's own configuration that waits for trust or approval, or that the user rejected.
 */
export type McpStatus = McpServer["status"]["status"] | "pending_approval" | "rejected"

/** Whether toggling this status would start or stop anything. Held and rejected servers are only approved. */
export function isHeldMcp(status: McpStatus | undefined) {
  return status === "pending_approval" || status === "rejected"
}

export async function toggleMcp(input: {
  status: McpStatus
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  authenticate: () => Promise<void>
  refresh: () => Promise<void>
  /** Opens the approval flow for a held server; toggling never connects one. */
  approve?: () => Promise<void>
}) {
  if (input.status === "pending") return
  if (isHeldMcp(input.status)) {
    await input.approve?.()
    return
  }
  await {
    connected: input.disconnect,
    needs_auth: input.authenticate,
    disabled: input.connect,
    failed: input.connect,
    needs_client_registration: input.connect,
  }[input.status]()
  await input.refresh()
}
