export * as WorkspaceTrustState from "./state"

import * as Key from "./key"
import * as Store from "./store"
import * as Launch from "./launch"

/**
 * The trust state of a folder from its key, the stored decisions, this process's session-only decisions and the launch
 * policy. Pure apart from the synchronous store read in `resolve`, so every config system in the process (the
 * engine's instance config and core's location config) reaches the same answer.
 */

export type Status = "trusted" | "untrusted" | "unknown"
export type Effective = "full" | "headless" | "restricted"
export type Source = "stored" | "parent" | "session" | "launch"

export interface TrustState {
  readonly key: string
  readonly path: string
  readonly kind: Key.Kind
  readonly sessionOnly: boolean
  readonly status: Status
  readonly source?: Source
  readonly policy: Launch.Policy
  readonly effective: Effective
  readonly mcp: Store.McpChoices
}

export type SessionEntry = { path: string; kind: Key.Kind; trusted: boolean; mcp: Store.McpChoices }

// Decisions kept for this process only (the home folder, `/`, or `remember: false`), by key.
const session = new Map<string, SessionEntry>()

export const sessionDecisions = {
  get: (key: string) => session.get(key),
  set: (key: string, entry: SessionEntry) => void session.set(key, entry),
  delete: (key: string) => session.delete(key),
  entries: () => [...session.entries()],
}

export function emptyMcp(): Store.McpChoices {
  return { approved: {}, rejected: [] }
}

/** The effective mode for a policy and a decision status. */
export function effectiveFor(policy: Launch.Policy, status: Status): Effective {
  if (policy === "trusted") return "full"
  if (policy === "untrusted") return "restricted"
  if (status === "trusted") return "full"
  if (policy === "headless") return "headless"
  return "restricted"
}

export function compute(input: {
  info: Key.Info
  data: Store.Data
  session?: SessionEntry
  policy: Launch.Policy
}): TrustState {
  const { info, policy } = input
  const stored = input.session ? undefined : Store.lookupIn(input.data, info)
  const decision = input.session
    ? { trusted: input.session.trusted, mcp: input.session.mcp, source: "session" as const }
    : stored
      ? { trusted: stored.entry.trusted, mcp: stored.entry.mcp, source: stored.source }
      : undefined
  const status: Status = decision ? (decision.trusted ? "trusted" : "untrusted") : "unknown"
  const launch = policy === "trusted" || policy === "untrusted" || (!decision && policy === "headless")
  return {
    key: info.key,
    path: info.path,
    kind: info.kind,
    sessionOnly: info.sessionOnly,
    status,
    ...(launch ? { source: "launch" as const } : decision ? { source: decision.source } : {}),
    policy,
    effective: effectiveFor(policy, status),
    mcp: decision?.mcp ?? emptyMcp(),
  }
}

/** The trust state of `directory` now, reading the store synchronously. */
export function resolve(directory: string): TrustState {
  const info = Key.resolve(directory)
  return compute({
    info,
    data: Store.readSync().data,
    session: session.get(info.key),
    policy: Launch.read(),
  })
}
