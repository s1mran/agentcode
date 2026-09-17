import type { TrustHeldItem, TrustInfo } from "@opencode-ai/sdk/v2"

/**
 * Workspace trust in the TUI. The engine enforces it; the TUI asks once at startup about a folder nobody has decided
 * on, and posts the answer. Until then (and after Escape) the folder simply runs restricted.
 */

/** Whether to ask at startup: a folder nobody decided on, on an engine that asks (the prompt policy). */
export function shouldAskTrust(info: Pick<TrustInfo, "status" | "policy"> | undefined) {
  return info?.status === "unknown" && info.policy === "prompt"
}

const LABELS: Record<TrustHeldItem["kind"], [string, string]> = {
  plugin: ["plugin", "plugins"],
  tool: ["custom tool", "custom tools"],
  mcp: ["MCP server", "MCP servers"],
  permission: ["allow rule", "allow rules"],
  command: ["shell command", "shell commands"],
  setting: ["other setting", "other settings"],
}

/** One line per kind of held item, for the dialog: "2 plugins", "1 MCP server: github (npx server)". */
export function trustSummary(held: ReadonlyArray<TrustHeldItem>) {
  const order: TrustHeldItem["kind"][] = ["plugin", "tool", "mcp", "permission", "command", "setting"]
  return order.flatMap((kind) => {
    const items = held.filter((item) => item.kind === kind)
    if (!items.length) return []
    const [one, many] = LABELS[kind]
    const count = `${items.length} ${items.length === 1 ? one : many}`
    if (kind !== "mcp") return [count]
    const names = items.flatMap((item) => (item.kind === "mcp" ? [item.name] : []))
    return [`${count}: ${names.join(", ")}`]
  })
}

export type TrustChoice = "trust" | "restricted"

/** The POST /trust body: trusting approves every held MCP server; the home folder is trusted for the session. */
export function trustPayload(choice: TrustChoice, info: Pick<TrustInfo, "held" | "sessionOnly">) {
  const remember = !info.sessionOnly
  if (choice === "restricted") return { trusted: false, remember }
  return {
    trusted: true,
    remember,
    mcp: { approve: info.held.flatMap((item) => (item.kind === "mcp" ? [item.name] : [])) },
  }
}

/** MCP statuses that only an approval changes; toggling must never connect them. */
export function isHeldMcpStatus(status: string | undefined) {
  return status === "pending_approval" || status === "rejected"
}
