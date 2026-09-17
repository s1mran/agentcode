import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { WorkspaceTrustLaunch } from "@opencode-ai/core/trust/launch"
import { WorkspaceTrustState } from "@opencode-ai/core/trust/state"
import { Context, Effect, Layer, Schema } from "effect"
import * as Key from "./key"
import * as Store from "./store"
import type { HeldItem } from "./restrict"

/**
 * Workspace trust: whether what a folder's own configuration supplies may run. Config loading asks `state()` once per
 * instance and holds project plugins, MCP servers, allow rules and other executable settings unless the answer is
 * `full`. Clients show the question and record the answer with `decide()`; a decision reloads the instances it covers.
 * The service reads no config, so Config can depend on it.
 */

export type Status = WorkspaceTrustState.Status
export type Effective = WorkspaceTrustState.Effective
export type Source = WorkspaceTrustState.Source
export type TrustState = WorkspaceTrustState.TrustState

export interface Decision {
  readonly trusted: boolean
  /** False keeps the decision in memory for this engine only. Home and `/` are never written. */
  readonly remember?: boolean
  readonly mcp?: {
    readonly approve?: ReadonlyArray<{ readonly name: string; readonly fingerprint: string }>
    readonly reject?: ReadonlyArray<string>
  }
}

export interface Listed {
  readonly key: string
  readonly path: string
  readonly kind: Key.Kind
  readonly trusted: boolean
  readonly time: number
  readonly sessionOnly: boolean
}

export class TrustRequiredError extends Schema.TaggedErrorClass<TrustRequiredError>()("WorkspaceTrust.RequiredError", {
  path: Schema.String,
}) {}

export class StoreError extends Schema.TaggedErrorClass<StoreError>()("WorkspaceTrust.StoreError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly state: (ctx: { readonly directory: string }) => Effect.Effect<TrustState>
  readonly decide: (ctx: { readonly directory: string }, input: Decision) => Effect.Effect<TrustState, StoreError>
  readonly forget: (ctx: { readonly directory: string }) => Effect.Effect<TrustState, StoreError>
  readonly setMcp: (
    ctx: { readonly directory: string },
    name: string,
    choice: string | "reject",
  ) => Effect.Effect<TrustState, TrustRequiredError | StoreError>
  readonly resetMcp: (ctx: { readonly directory: string }) => Effect.Effect<TrustState, StoreError>
  readonly list: () => Effect.Effect<Listed[]>
  readonly forgetPath: (path: string) => Effect.Effect<string[], StoreError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkspaceTrust") {}

export const use = serviceUse(Service)

const emptyMcp = WorkspaceTrustState.emptyMcp
const session = WorkspaceTrustState.sessionDecisions

function applyMcp(current: Store.McpChoices, input: Decision["mcp"]): Store.McpChoices {
  const approved = { ...current.approved }
  const rejected = new Set(current.rejected)
  for (const item of input?.approve ?? []) {
    approved[item.name] = item.fingerprint
    rejected.delete(item.name)
  }
  for (const name of input?.reject ?? []) {
    delete approved[name]
    rejected.add(name)
  }
  return { approved, rejected: [...rejected].sort() }
}

export const effectiveFor = WorkspaceTrustState.effectiveFor
export const compute = WorkspaceTrustState.compute

/** The public shape (GET /trust, `agentcode trust --status`): the decision now, and what the instance loaded with. */
export interface Info {
  readonly path: string
  readonly kind: Key.Kind
  readonly status: Status
  readonly source?: Source
  readonly policy: WorkspaceTrustLaunch.Policy
  readonly effective: Effective
  readonly sessionOnly: boolean
  readonly held: ReadonlyArray<HeldItem>
  readonly mcp: { readonly approved: string[]; readonly rejected: string[] }
}

export function info(loaded: { state: TrustState; held: ReadonlyArray<HeldItem> }, current: TrustState): Info {
  return {
    path: current.path,
    kind: current.kind,
    status: current.status,
    ...(current.source ? { source: current.source } : {}),
    policy: current.policy,
    effective: loaded.state.effective,
    sessionOnly: current.sessionOnly,
    held: loaded.held,
    mcp: { approved: Object.keys(current.mcp.approved).sort(), rejected: [...current.mcp.rejected] },
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const read = Effect.promise(() => Store.read())
    const write = (fn: (data: Store.Data) => void) =>
      Effect.tryPromise({
        try: () => Store.update(fn),
        catch: (error) => new StoreError({ message: error instanceof Error ? error.message : String(error) }),
      })

    const stateFor = Effect.fnUntraced(function* (info: Key.Info) {
      const current = yield* read
      if (current.corrupt) yield* Effect.logWarning("workspace trust store could not be parsed", { file: Store.file() })
      if (current.error)
        yield* Effect.logWarning("workspace trust store could not be read", {
          file: Store.file(),
          error: current.error.message,
        })
      const warning = WorkspaceTrustLaunch.takeWarning()
      if (warning !== undefined)
        yield* Effect.logWarning(`${WorkspaceTrustLaunch.ENV_KEY} is not a trust policy, using prompt`, {
          value: warning,
        })
      return compute({ info, data: current.data, session: session.get(info.key), policy: WorkspaceTrustLaunch.read() })
    })

    const state = Effect.fn("WorkspaceTrust.state")(function* (ctx: { readonly directory: string }) {
      return yield* stateFor(Key.resolve(ctx.directory))
    })

    const decide = Effect.fn("WorkspaceTrust.decide")(function* (ctx: { readonly directory: string }, input: Decision) {
      const info = Key.resolve(ctx.directory)
      if (info.sessionOnly || input.remember === false) {
        const previous = session.get(info.key)
        const base = previous?.mcp ?? (yield* stateFor(info)).mcp
        session.set(info.key, {
          path: info.path,
          kind: info.kind,
          trusted: input.trusted,
          mcp: applyMcp(base, input.mcp),
        })
        return yield* stateFor(info)
      }
      yield* write((data) => {
        const existing = data.workspaces[info.key]
        data.workspaces[info.key] = {
          path: info.path,
          kind: info.kind,
          trusted: input.trusted,
          time: Date.now(),
          mcp: applyMcp(existing?.mcp ?? emptyMcp(), input.mcp),
        }
      })
      session.delete(info.key)
      return yield* stateFor(info)
    })

    const forget = Effect.fn("WorkspaceTrust.forget")(function* (ctx: { readonly directory: string }) {
      const info = Key.resolve(ctx.directory)
      session.delete(info.key)
      if (!info.sessionOnly && (yield* read).data.workspaces[info.key]) {
        yield* write((data) => {
          delete data.workspaces[info.key]
        })
      }
      return yield* stateFor(info)
    })

    const setMcp = Effect.fn("WorkspaceTrust.setMcp")(function* (
      ctx: { readonly directory: string },
      name: string,
      choice: string | "reject",
    ) {
      const info = Key.resolve(ctx.directory)
      const current = yield* stateFor(info)
      if (current.status !== "trusted") return yield* new TrustRequiredError({ path: info.path })
      const change: Decision["mcp"] =
        choice === "reject" ? { reject: [name] } : { approve: [{ name, fingerprint: choice }] }
      const previous = session.get(info.key)
      if (previous) {
        session.set(info.key, { ...previous, mcp: applyMcp(previous.mcp, change) })
        return yield* stateFor(info)
      }
      yield* write((data) => {
        // Trust inherited from a parent directory decision keeps coming from there: the choice is stored on that
        // decision, so an exact `trusted: true` entry never pins this folder after the parent is restricted.
        const found = Store.lookupIn(data, info)
        if (found?.source === "parent") {
          found.entry.mcp = applyMcp(found.entry.mcp, change)
          return
        }
        const existing = data.workspaces[info.key]
        data.workspaces[info.key] = {
          path: info.path,
          kind: info.kind,
          trusted: true,
          time: existing?.time ?? Date.now(),
          mcp: applyMcp(existing?.mcp ?? current.mcp, change),
        }
      })
      return yield* stateFor(info)
    })

    const resetMcp = Effect.fn("WorkspaceTrust.resetMcp")(function* (ctx: { readonly directory: string }) {
      const info = Key.resolve(ctx.directory)
      const previous = session.get(info.key)
      if (previous) session.set(info.key, { ...previous, mcp: emptyMcp() })
      if ((yield* read).data.workspaces[info.key]) {
        yield* write((data) => {
          const existing = data.workspaces[info.key]
          if (existing) existing.mcp = emptyMcp()
        })
      }
      return yield* stateFor(info)
    })

    const list = Effect.fn("WorkspaceTrust.list")(function* () {
      const current = yield* read
      const stored = Object.entries(current.data.workspaces).map(
        ([key, item]): Listed => ({
          key,
          path: item.path,
          kind: item.kind,
          trusted: item.trusted,
          time: item.time,
          sessionOnly: false,
        }),
      )
      const inMemory = session.entries().map(
        ([key, item]): Listed => ({
          key,
          path: item.path,
          kind: item.kind,
          trusted: item.trusted,
          time: 0,
          sessionOnly: true,
        }),
      )
      return [...stored, ...inMemory].sort((a, b) => a.path.localeCompare(b.path))
    })

    const forgetPath = Effect.fn("WorkspaceTrust.forgetPath")(function* (target: string) {
      const keys = new Set([Key.normalize(target), Key.resolve(target).key])
      const removed: string[] = []
      for (const [key, item] of session.entries()) {
        if (!keys.has(key) && item.path !== target) continue
        session.delete(key)
        removed.push(key)
      }
      const data = (yield* read).data
      const stored = Object.entries(data.workspaces)
        .filter(([key, item]) => keys.has(key) || item.path === target)
        .map(([key]) => key)
      if (stored.length) {
        yield* write((next) => {
          for (const key of stored) delete next.workspaces[key]
        })
        removed.push(...stored)
      }
      return [...new Set(removed)]
    })

    return Service.of({ state, decide, forget, setMcp, resetMcp, list, forgetPath })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export * as WorkspaceTrust from "."
