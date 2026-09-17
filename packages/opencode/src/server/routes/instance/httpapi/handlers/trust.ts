import { Config } from "@/config/config"
import { EffectBridge } from "@/effect/bridge"
import * as InstanceState from "@/effect/instance-state"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceStore } from "@/project/instance-store"
import { WorkspaceTrust } from "@/trust"
import { WorkspaceTrustKey } from "@/trust/key"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { McpServerNotFoundError, WorkspaceTrustRequiredError, WorkspaceTrustStoreError } from "../errors"
import { TrustMcpPayload, TrustSetPayload } from "../groups/trust"
import { markInstanceForReload } from "../lifecycle"

/** Whether a decision on `decided` applies to the instance loaded at `directory`. */
export function coversDirectory(decided: Pick<WorkspaceTrustKey.Info, "key" | "kind">, directory: string) {
  const other = WorkspaceTrustKey.resolve(directory)
  if (other.key === decided.key) return true
  return decided.kind === "directory" && other.kind === "directory" && WorkspaceTrustKey.covers(decided.key, other.key)
}

const storeError = (error: WorkspaceTrust.StoreError) => new WorkspaceTrustStoreError({ message: error.message })

export const trustHandlers = HttpApiBuilder.group(InstanceHttpApi, "trust", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const trust = yield* WorkspaceTrust.Service
    const store = yield* InstanceStore.Service
    const bridge = yield* EffectBridge.make()

    const decision = (state: WorkspaceTrust.TrustState) => ({
      path: state.path,
      status: state.status,
      effective: state.effective,
    })

    // The current instance reloads after the response is sent; every other loaded instance the decision covers
    // reloads in the background. Each reload emits server.instance.disposed, which is how clients learn to refetch.
    const reloadCovered = Effect.fnUntraced(function* (ctx: InstanceContext, state: WorkspaceTrust.TrustState) {
      yield* markInstanceForReload(ctx, { directory: ctx.directory, worktree: ctx.worktree, project: ctx.project })
      for (const other of yield* store.loaded()) {
        if (other.directory === ctx.directory || !coversDirectory(state, other.directory)) continue
        bridge.fork(
          store
            .reload({ directory: other.directory, worktree: other.worktree, project: other.project })
            .pipe(Effect.asVoid),
        )
      }
    })

    const get = Effect.fn("TrustHttpApi.get")(function* () {
      const ctx = yield* InstanceState.context
      return WorkspaceTrust.info(yield* config.trust(), yield* trust.state(ctx))
    })

    const set = Effect.fn("TrustHttpApi.set")(function* (input: { payload: typeof TrustSetPayload.Type }) {
      const ctx = yield* InstanceState.context
      const held = (yield* config.trust()).held
      const fingerprints = new Map(
        held.flatMap((item) => (item.kind === "mcp" ? [[item.name, item.fingerprint] as const] : [])),
      )
      const approve = (input.payload.mcp?.approve ?? []).flatMap((name) => {
        const fingerprint = fingerprints.get(name)
        return fingerprint ? [{ name, fingerprint }] : []
      })
      const state = yield* trust
        .decide(ctx, {
          trusted: input.payload.trusted,
          remember: input.payload.remember ?? true,
          mcp: { approve, reject: input.payload.mcp?.reject ?? [] },
        })
        .pipe(Effect.mapError(storeError))
      yield* reloadCovered(ctx, state)
      return decision(state)
    })

    const forget = Effect.fn("TrustHttpApi.forget")(function* () {
      const ctx = yield* InstanceState.context
      const state = yield* trust.forget(ctx).pipe(Effect.mapError(storeError))
      yield* reloadCovered(ctx, state)
      return decision(state)
    })

    const mcp = Effect.fn("TrustHttpApi.mcp")(function* (input: {
      params: { name: string }
      payload: typeof TrustMcpPayload.Type
    }) {
      const ctx = yield* InstanceState.context
      const name = input.params.name
      const item = (yield* config.trust()).held.find((held) => held.kind === "mcp" && held.name === name)
      if (item?.kind !== "mcp")
        return yield* new McpServerNotFoundError({ name, message: `No held MCP server named ${name}` })
      const state = yield* trust.setMcp(ctx, name, input.payload.approve ? item.fingerprint : "reject").pipe(
        Effect.catchTag("WorkspaceTrust.RequiredError", (error) =>
          Effect.fail(
            new WorkspaceTrustRequiredError({
              path: error.path,
              message: "Trust this folder before approving or rejecting its MCP servers",
            }),
          ),
        ),
        Effect.catchTag("WorkspaceTrust.StoreError", (error) => Effect.fail(storeError(error))),
      )
      yield* markInstanceForReload(ctx, { directory: ctx.directory, worktree: ctx.worktree, project: ctx.project })
      return decision(state)
    })

    const resetMcp = Effect.fn("TrustHttpApi.resetMcp")(function* () {
      const ctx = yield* InstanceState.context
      const state = yield* trust.resetMcp(ctx).pipe(Effect.mapError(storeError))
      yield* markInstanceForReload(ctx, { directory: ctx.directory, worktree: ctx.worktree, project: ctx.project })
      return decision(state)
    })

    return handlers
      .handle("get", get)
      .handle("set", set)
      .handle("forget", forget)
      .handle("resetMcp", resetMcp)
      .handle("mcp", mcp)
  }),
)
