import type { GlobalHealthResponse, TrustHeldItem, TrustInfo } from "@opencode-ai/sdk/v2/client"
import type { ServerProtocol } from "@/utils/server-protocol"

/**
 * Workspace trust in the app. The engine enforces it (an untrusted folder loads restricted until a decision is
 * recorded); the app only asks, once per launch per folder, and posts the answer. A decision reloads the folder's
 * instance, which emits server.instance.disposed, and the trust state is fetched again.
 */

type Health = Partial<GlobalHealthResponse> | undefined

/** True when a `/global/health` body advertises engine-side workspace trust. */
export function advertisesWorkspaceTrust(health: Health) {
  return health?.workspaceTrust === true
}

/** Whether to ask about a folder: an engine that enforces trust, a folder nobody decided on, not asked this launch. */
export function shouldAskTrust(input: {
  supported: boolean
  info?: Pick<TrustInfo, "status" | "policy">
  asked: boolean
}) {
  return input.supported && !input.asked && input.info?.status === "unknown" && input.info.policy === "prompt"
}

/**
 * Whether a queued dialog still has a question, from the trust state fetched right before it opens. Worktrees of one
 * repository share its decision, so answering an earlier dialog can settle a later one, and a dialog built from the
 * state at enqueue time would overwrite that answer. An automatic ask needs the folder still undecided; one the user
 * opened from the restricted notice needs it still restricted.
 */
export function queuedTrustDialogApplies(input: {
  automatic: boolean
  fresh?: Pick<TrustInfo, "status" | "policy" | "effective">
}) {
  if (!input.fresh) return false
  if (input.automatic) return input.fresh.status === "unknown" && input.fresh.policy === "prompt"
  return input.fresh.effective === "restricted"
}

// Trust roots (TrustInfo.path) with a dialog queued or open: folders sharing one decision queue a single dialog.
const pendingDialogs = new Set<string>()

export const trustDialogs = {
  /** True when no dialog for `root` is queued or open; the caller then owns it until `release`. */
  claim: (root: string) => {
    if (pendingDialogs.has(root)) return false
    pendingDialogs.add(root)
    return true
  },
  release: (root: string) => void pendingDialogs.delete(root),
}

/** Whether the folder runs restricted on an engine that enforces trust. */
export function isRestricted(input: { supported: boolean; info?: Pick<TrustInfo, "effective"> }) {
  return input.supported && input.info?.effective === "restricted"
}

export type TrustPayload = {
  trusted: boolean
  remember: boolean
  mcp?: { approve: string[]; reject: string[] }
}

/**
 * The POST /trust body for a dialog answer. Trusting approves the held MCP servers left checked and rejects the ones
 * unchecked; restricted mode records only the decision. The home folder is trusted for the session, never saved.
 */
export function trustPayload(input: {
  trusted: boolean
  sessionOnly: boolean
  held: ReadonlyArray<TrustHeldItem>
  unchecked: ReadonlySet<string>
}): TrustPayload {
  const remember = !input.sessionOnly
  if (!input.trusted) return { trusted: false, remember }
  const names = heldMcp(input.held).map((item) => item.name)
  return {
    trusted: true,
    remember,
    mcp: {
      approve: names.filter((name) => !input.unchecked.has(name)),
      reject: names.filter((name) => input.unchecked.has(name)),
    },
  }
}

export function heldMcp(held: ReadonlyArray<TrustHeldItem>) {
  return held.flatMap((item) => (item.kind === "mcp" ? [item] : []))
}

export type HeldGroups = {
  code: TrustHeldItem[]
  mcp: Extract<TrustHeldItem, { kind: "mcp" }>[]
  permission: Extract<TrustHeldItem, { kind: "permission" }>[]
  command: Extract<TrustHeldItem, { kind: "command" }>[]
  setting: Extract<TrustHeldItem, { kind: "setting" }>[]
}

/** Held items grouped the way the dialog lists them. */
export function groupHeld(held: ReadonlyArray<TrustHeldItem>): HeldGroups {
  return {
    code: held.filter((item) => item.kind === "plugin" || item.kind === "tool"),
    mcp: heldMcp(held),
    permission: held.flatMap((item) => (item.kind === "permission" ? [item] : [])),
    command: held.flatMap((item) => (item.kind === "command" ? [item] : [])),
    setting: held.flatMap((item) => (item.kind === "setting" ? [item] : [])),
  }
}

// Folders already asked about in this app launch, by server scope and directory.
const asked = new Set<string>()

export const trustPrompts = {
  key: (scope: string, directory: string) => `${scope}\0${directory}`,
  has: (key: string) => asked.has(key),
  add: (key: string) => void asked.add(key),
}

type TrustServer = {
  protocol: Promise<ServerProtocol>
  client: { global: { health: (options: { throwOnError: true }) => Promise<{ data?: GlobalHealthResponse }> } }
}

const detected = new WeakMap<object, Promise<boolean>>()

/** The cached workspace-trust capability of one server SDK context (legacy engines never advertise it). */
export function serverWorkspaceTrust(sdk: TrustServer) {
  const existing = detected.get(sdk)
  if (existing) return existing
  const result = (async () => {
    if ((await sdk.protocol.catch(() => undefined)) !== "v1") return false
    for (let attempt = 1; attempt <= 3; attempt++) {
      const health = await sdk.client.global.health({ throwOnError: true }).then(
        (response) => ({ ok: true as const, value: response.data }),
        () => ({ ok: false as const }),
      )
      if (health.ok) return advertisesWorkspaceTrust(health.value)
      if (attempt < 3) await new Promise<void>((resolve) => setTimeout(resolve, 500 * attempt))
    }
    return false
  })()
  detected.set(sdk, result)
  return result
}
