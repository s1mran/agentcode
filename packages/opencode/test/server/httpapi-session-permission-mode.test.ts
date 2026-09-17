import { afterEach, describe, expect } from "bun:test"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Effect, Fiber, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Workspace } from "../../src/control-plane/workspace"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { Session } from "@/session/session"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { waitGlobalBusEvent } from "./global-bus"
import { GlobalBus, type GlobalEvent } from "@/bus/global"

const noopBootstrapLayer = Layer.succeed(
  InstanceBootstrapService.Service,
  InstanceBootstrapService.Service.of({ run: Effect.void }),
)
const appLayer = AppNodeBuilder.build(
  LayerNode.group([InstanceStore.node, Project.node, Session.node, Workspace.node, Database.node, Ripgrep.node]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

const instanceOptions = { git: true, config: { formatter: false, lsp: false } } as const

function pathFor(path: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), path)
}

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  if (response.status !== 200) return response.text.pipe(Effect.flatMap((text) => Effect.die(new Error(text))))
  return response.json.pipe(Effect.map((value) => value as T))
}

const headersFor = (directory: string) => ({ "x-opencode-directory": directory, "content-type": "application/json" })

const createViaHttp = (directory: string, body: Record<string, unknown>) =>
  request(SessionPaths.create, { method: "POST", headers: headersFor(directory), body: JSON.stringify(body) })

const patchViaHttp = (directory: string, sessionID: string, body: Record<string, unknown>) =>
  request(pathFor(SessionPaths.update, { sessionID }), {
    method: "PATCH",
    headers: headersFor(directory),
    body: JSON.stringify(body),
  })

const getViaHttp = (directory: string, sessionID: string) =>
  request(pathFor(SessionPaths.get, { sessionID }), { headers: headersFor(directory) }).pipe(
    Effect.flatMap(json<Session.Info>),
  )

const listViaHttp = (directory: string) =>
  request(SessionPaths.list, { headers: headersFor(directory) }).pipe(Effect.flatMap(json<Session.Info[]>))

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("session HttpApi permission mode", () => {
  it.instance(
    "PATCH permissionMode sets the mode, publishes session.updated and null clears it",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const created = yield* createViaHttp(test.directory, { title: "mode" }).pipe(Effect.flatMap(json<Session.Info>))
        expect(created.permissionMode).toBeUndefined()

        const updatedEvent = yield* waitGlobalBusEvent({
          message: "timed out waiting for session.updated with permissionMode plan",
          predicate: (event) => {
            const payload = event.payload as { type: string; properties?: { info?: Session.Info } }
            return (
              payload.type === "session.updated" &&
              payload.properties?.info?.id === created.id &&
              payload.properties.info.permissionMode === "plan"
            )
          },
        }).pipe(Effect.forkScoped({ startImmediately: true }))

        const planned = yield* patchViaHttp(test.directory, created.id, { permissionMode: "plan" }).pipe(
          Effect.flatMap(json<Session.Info>),
        )
        expect(planned).toMatchObject({ id: created.id, permissionMode: "plan" })
        yield* Fiber.join(updatedEvent)
        expect((yield* getViaHttp(test.directory, created.id)).permissionMode).toBe("plan")

        const cleared = yield* patchViaHttp(test.directory, created.id, { permissionMode: null }).pipe(
          Effect.flatMap(json<Session.Info>),
        )
        expect(cleared.permissionMode).toBeUndefined()
        expect((yield* getViaHttp(test.directory, created.id)).permissionMode).toBeUndefined()
      }),
    instanceOptions,
  )

  it.instance(
    "PATCH rejects an unknown permissionMode",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const created = yield* createViaHttp(test.directory, {}).pipe(Effect.flatMap(json<Session.Info>))

        const response = yield* patchViaHttp(test.directory, created.id, { permissionMode: "yolo" })
        expect(response.status).toBe(400)
        expect(yield* response.text).toContain("BadRequest")
        expect((yield* getViaHttp(test.directory, created.id)).permissionMode).toBeUndefined()
      }),
    instanceOptions,
  )

  it.instance(
    "PATCH bypassPermissions is refused with its reason when configuration disables it",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const created = yield* createViaHttp(test.directory, { title: "keep" }).pipe(Effect.flatMap(json<Session.Info>))

        const response = yield* patchViaHttp(test.directory, created.id, {
          permissionMode: "bypassPermissions",
          title: "not applied",
        })
        expect(response.status).toBe(400)
        const body = (yield* response.json) as { name: string; data: { message: string } }
        expect(body.name).toBe("BadRequest")
        expect(body.data.message).toContain("disabled by configuration")

        const after = yield* getViaHttp(test.directory, created.id)
        expect(after.permissionMode).toBeUndefined()
        expect(after.title).toBe("keep")
      }),
    { git: true, config: { formatter: false, lsp: false, disable_bypass_permissions: true } },
  )

  it.instance(
    "POST bypassPermissions is refused with its reason before any session is created",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const created: string[] = []
        const handler = (event: GlobalEvent) => {
          const payload = event.payload as { type: string; properties?: { info?: Session.Info } }
          if (payload.type === "session.created") created.push(payload.properties?.info?.title ?? "")
        }
        yield* Effect.acquireRelease(
          Effect.sync(() => GlobalBus.on("event", handler)),
          () => Effect.sync(() => GlobalBus.off("event", handler)),
        )

        const response = yield* createViaHttp(test.directory, { title: "bypass", permissionMode: "bypassPermissions" })
        expect(response.status).toBe(400)
        const body = (yield* response.json) as { name: string; data: { message: string } }
        expect(body.name).toBe("BadRequest")
        expect(body.data.message).toBe("Permission mode not changed: bypassPermissions is disabled by configuration")

        // A later create proves the event stream caught up: only that session was ever created.
        const marker = yield* waitGlobalBusEvent({
          message: "timed out waiting for session.created of the marker session",
          predicate: (event) => {
            const payload = event.payload as { type: string; properties?: { info?: Session.Info } }
            return payload.type === "session.created" && payload.properties?.info?.title === "marker"
          },
        }).pipe(Effect.forkScoped({ startImmediately: true }))
        yield* createViaHttp(test.directory, { title: "marker" }).pipe(Effect.flatMap(json<Session.Info>))
        yield* Fiber.join(marker)
        expect(created).toEqual(["marker"])
        expect((yield* listViaHttp(test.directory)).map((item) => item.title)).toEqual(["marker"])
      }),
    { git: true, config: { formatter: false, lsp: false, disable_bypass_permissions: true } },
  )

  it.instance(
    "bypassPermissions goes through the gate on POST and PATCH when it is allowed",
    () =>
      Effect.gen(function* () {
        // The gate refuses bypass for root outside a sandbox; that refusal is covered by the permission mode tests.
        if (process.getuid?.() === 0 && process.env.IS_SANDBOX !== "1") return
        const test = yield* TestInstance
        const created = yield* createViaHttp(test.directory, { permissionMode: "bypassPermissions" }).pipe(
          Effect.flatMap(json<Session.Info>),
        )
        expect(created.permissionMode).toBe("bypassPermissions")
        expect((yield* getViaHttp(test.directory, created.id)).permissionMode).toBe("bypassPermissions")

        const other = yield* createViaHttp(test.directory, {}).pipe(Effect.flatMap(json<Session.Info>))
        const patched = yield* patchViaHttp(test.directory, other.id, { permissionMode: "bypassPermissions" }).pipe(
          Effect.flatMap(json<Session.Info>),
        )
        expect(patched.permissionMode).toBe("bypassPermissions")
      }),
    instanceOptions,
  )

  it.instance(
    "POST permissionMode acceptEdits persists the mode",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const created = yield* createViaHttp(test.directory, { permissionMode: "acceptEdits" }).pipe(
          Effect.flatMap(json<Session.Info>),
        )
        expect(created.permissionMode).toBe("acceptEdits")
        expect((yield* getViaHttp(test.directory, created.id)).permissionMode).toBe("acceptEdits")
      }),
    instanceOptions,
  )

  it.instance(
    "PATCH permission rules drop a client-supplied builtin source",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const created = yield* createViaHttp(test.directory, {
          permission: [{ permission: "read", pattern: "*", action: "allow", source: "builtin" }],
        }).pipe(Effect.flatMap(json<Session.Info>))
        expect(created.permission).toEqual([{ permission: "read", pattern: "*", action: "allow" }])

        const updated = yield* patchViaHttp(test.directory, created.id, {
          permission: [{ permission: "bash", pattern: "git status *", action: "allow", source: "builtin" }],
        }).pipe(Effect.flatMap(json<Session.Info>))
        const expected: PermissionV1.Rule[] = [
          { permission: "read", pattern: "*", action: "allow" },
          { permission: "bash", pattern: "git status *", action: "allow" },
        ]
        expect(updated.permission).toEqual(expected)
        expect((yield* getViaHttp(test.directory, created.id)).permission).toEqual(expected)
      }),
    instanceOptions,
  )
})
