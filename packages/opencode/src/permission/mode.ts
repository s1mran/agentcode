import { Effect, Option, Schema } from "effect"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { InstanceState } from "@/effect/instance-state"
import type { Config } from "@/config/config"
import type { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"

// Permission mode as session state (D2). The effective mode is resolved on every ask by walking the parent chain, so
// subagents inherit their parent's mode and can never loosen it, whatever mode a client stores on them.

export type Mode = PermissionV1.Mode

export class ModeError extends Schema.TaggedErrorClass<ModeError>()("PermissionModeError", {
  reason: Schema.String,
}) {
  override get message() {
    return `Permission mode not changed: ${this.reason}`
  }
}

export const MAX_DEPTH = 16

/** Why bypassPermissions is unavailable, or undefined when it may be used. */
export function gate(cfg: { disable_bypass_permissions?: boolean }): string | undefined {
  if (cfg.disable_bypass_permissions === true) return "bypassPermissions is disabled by configuration"
  if (process.getuid?.() === 0 && process.env.IS_SANDBOX !== "1")
    return "bypassPermissions is refused when running as root"
}

// How much each non-narrowing mode approves on its own; plan and dontAsk are resolved before these are compared.
const LOOSENESS: Partial<Record<Mode, number>> = { default: 1, acceptEdits: 2, bypassPermissions: 3 }

/**
 * The effective mode for a session chain (self first): plan when the asking agent is `plan` or any session on the
 * chain is in plan; otherwise dontAsk when any session is. Otherwise the outermost session's stored mode (or the
 * config default, or `default`), which a descendant's stored mode may narrow but never loosen. bypassPermissions
 * falls back to `default` when the gate fails.
 */
export function pick(input: {
  chain: ReadonlyArray<{ permissionMode?: Mode }>
  agentName?: string
  configDefault?: Mode
  gate?: string
}): Mode {
  const modes = input.chain.map((item) => item.permissionMode)
  if (input.agentName === "plan" || modes.includes("plan")) return "plan"
  if (modes.includes("dontAsk")) return "dontAsk"
  const rank = (mode: Mode) => LOOSENESS[mode] ?? 1
  let chosen: Mode = modes.at(-1) ?? input.configDefault ?? "default"
  for (const mode of modes.slice(0, -1).reverse()) {
    if (mode !== undefined && rank(mode) <= rank(chosen)) chosen = mode
  }
  if (chosen === "bypassPermissions" && input.gate !== undefined) return "default"
  return chosen
}

export type Details = {
  mode: Mode
  /** The asking session followed by its ancestors, as far as they exist (at most MAX_DEPTH). */
  chain: Session.Info[]
  root?: Session.Info
  rootID: SessionID
}

export interface Interface {
  readonly details: (sessionID: SessionID, options?: { agentName?: string }) => Effect.Effect<Details>
  readonly resolve: (sessionID: SessionID, agentName?: string) => Effect.Effect<Mode>
  readonly root: (sessionID: SessionID) => Effect.Effect<Session.Info | undefined>
  readonly set: (sessionID: SessionID, mode: Mode | null) => Effect.Effect<void, ModeError>
  readonly prePlan: (sessionID: SessionID) => Effect.Effect<Mode | undefined>
}

export const make = Effect.fnUntraced(function* (deps: { sessions: Session.Interface; config: Config.Interface }) {
  const state = yield* InstanceState.make(() => Effect.succeed({ prePlan: new Map<string, Mode>() }))

  const chain = Effect.fnUntraced(function* (sessionID: SessionID) {
    const result: Session.Info[] = []
    const seen = new Set<string>()
    let id: SessionID | undefined = sessionID
    while (id && result.length < MAX_DEPTH && !seen.has(id)) {
      seen.add(id)
      const info: Option.Option<Session.Info> = yield* deps.sessions.get(id).pipe(Effect.option)
      if (Option.isNone(info)) break
      result.push(info.value)
      id = info.value.parentID
    }
    return result
  })

  const details: Interface["details"] = Effect.fnUntraced(function* (sessionID, options) {
    const sessions = yield* chain(sessionID)
    const cfg = yield* deps.config.get()
    // Only the agent actually running counts: Session.Info.agent is the last prompted agent and goes stale when
    // plan_exit hands the turn to another agent.
    const agentName = options?.agentName
    const root = sessions.at(-1)
    return {
      mode: pick({ chain: sessions, agentName, configDefault: cfg.default_permission_mode, gate: gate(cfg) }),
      chain: sessions,
      root,
      rootID: root?.id ?? sessionID,
    }
  })

  const resolve: Interface["resolve"] = (sessionID, agentName) =>
    details(sessionID, { agentName }).pipe(Effect.map((item) => item.mode))

  const root: Interface["root"] = (sessionID) => details(sessionID).pipe(Effect.map((item) => item.root))

  const set: Interface["set"] = Effect.fn("Permission.setMode")(function* (sessionID, mode) {
    const current = yield* details(sessionID)
    if (current.chain.length === 0) return yield* new ModeError({ reason: `session ${sessionID} was not found` })
    if (mode === "bypassPermissions") {
      const reason = gate(yield* deps.config.get())
      if (reason) return yield* new ModeError({ reason })
    }
    if (mode === "plan" && current.mode !== "plan")
      (yield* InstanceState.get(state)).prePlan.set(current.rootID, current.mode)
    yield* deps.sessions.setPermissionMode({ sessionID, mode })
  })

  const prePlan: Interface["prePlan"] = Effect.fnUntraced(function* (sessionID) {
    const { rootID } = yield* details(sessionID)
    return (yield* InstanceState.get(state)).prePlan.get(rootID)
  })

  return { details, resolve, root, set, prePlan } satisfies Interface
})

export * as PermissionMode from "./mode"
