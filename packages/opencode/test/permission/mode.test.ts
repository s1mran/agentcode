import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Permission } from "../../src/permission"
import { PermissionMode } from "../../src/permission/mode"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

let config: ConfigV1.Info = {}

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Permission.node,
      Session.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [Config.node, Layer.succeed(Config.Service, TestConfig.make({ get: () => Effect.sync(() => config) }))],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

afterEach(() => {
  config = {}
})

const created = (input?: Parameters<Session.Interface["create"]>[0]) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    return yield* Effect.acquireRelease(session.create(input), (info) => session.remove(info.id).pipe(Effect.ignore))
  })

describe("PermissionMode.pick", () => {
  test("plan wins over dontAsk and stored modes anywhere on the chain", () => {
    expect(PermissionMode.pick({ chain: [{}, { permissionMode: "acceptEdits" }, { permissionMode: "plan" }] })).toBe(
      "plan",
    )
    expect(PermissionMode.pick({ chain: [{ permissionMode: "acceptEdits" }], agentName: "plan" })).toBe("plan")
  })

  test("dontAsk carries down, otherwise the outermost stored mode, config default, then default", () => {
    expect(PermissionMode.pick({ chain: [{ permissionMode: "acceptEdits" }, { permissionMode: "dontAsk" }] })).toBe(
      "dontAsk",
    )
    expect(PermissionMode.pick({ chain: [{}, { permissionMode: "default" }, { permissionMode: "acceptEdits" }] })).toBe(
      "default",
    )
    expect(PermissionMode.pick({ chain: [{}], configDefault: "acceptEdits" })).toBe("acceptEdits")
    expect(PermissionMode.pick({ chain: [] })).toBe("default")
  })

  test("a subagent session's stored mode narrows its parent's mode but never loosens it", () => {
    expect(PermissionMode.pick({ chain: [{ permissionMode: "acceptEdits" }, { permissionMode: "default" }] })).toBe(
      "default",
    )
    expect(
      PermissionMode.pick({ chain: [{ permissionMode: "bypassPermissions" }, { permissionMode: "default" }] }),
    ).toBe("default")
    expect(PermissionMode.pick({ chain: [{ permissionMode: "acceptEdits" }, {}], configDefault: "default" })).toBe(
      "default",
    )
    expect(
      PermissionMode.pick({ chain: [{ permissionMode: "default" }, { permissionMode: "bypassPermissions" }] }),
    ).toBe("default")
    expect(PermissionMode.pick({ chain: [{}, { permissionMode: "acceptEdits" }] })).toBe("acceptEdits")
  })

  test("bypassPermissions falls back to default when the gate fails", () => {
    expect(PermissionMode.pick({ chain: [{ permissionMode: "bypassPermissions" }] })).toBe("bypassPermissions")
    expect(PermissionMode.pick({ chain: [{ permissionMode: "bypassPermissions" }], gate: "disabled" })).toBe("default")
    expect(PermissionMode.pick({ chain: [], configDefault: "bypassPermissions", gate: "disabled" })).toBe("default")
  })
})

describe("PermissionMode.gate", () => {
  test("disabled by configuration", () => {
    expect(PermissionMode.gate({ disable_bypass_permissions: true })).toContain("disabled by configuration")
  })

  test("refused when running as root unless IS_SANDBOX=1", () => {
    const uid = spyOn(process, "getuid").mockReturnValue(0)
    const previous = process.env.IS_SANDBOX
    try {
      delete process.env.IS_SANDBOX
      expect(PermissionMode.gate({})).toContain("running as root")
      process.env.IS_SANDBOX = "1"
      expect(PermissionMode.gate({})).toBeUndefined()
    } finally {
      uid.mockRestore()
      if (previous === undefined) delete process.env.IS_SANDBOX
      else process.env.IS_SANDBOX = previous
    }
  })
})

describe("Permission.mode", () => {
  it.instance("a child inherits its parent's acceptEdits", () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const parent = yield* created({ permissionMode: "acceptEdits" })
      const child = yield* created({ parentID: parent.id })
      expect(yield* permission.mode(child.id)).toBe("acceptEdits")
    }),
  )

  it.instance("a grandparent in plan beats a parent in acceptEdits", () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const grandparent = yield* created({ permissionMode: "plan" })
      const parent = yield* created({ parentID: grandparent.id, permissionMode: "acceptEdits" })
      const child = yield* created({ parentID: parent.id })
      expect(yield* permission.mode(child.id)).toBe("plan")
      expect(yield* permission.mode(parent.id)).toBe("plan")
    }),
  )

  it.instance("a parent in dontAsk carries down to a child without a mode", () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const parent = yield* created({ permissionMode: "dontAsk" })
      const child = yield* created({ parentID: parent.id, permissionMode: "acceptEdits" })
      expect(yield* permission.mode(child.id)).toBe("dontAsk")
    }),
  )

  it.instance("without stored modes the config default applies", () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const session = yield* created({})
      expect(yield* permission.mode(session.id)).toBe("default")
      config = { default_permission_mode: "acceptEdits" }
      expect(yield* permission.mode(session.id)).toBe("acceptEdits")
      expect(yield* permission.mode(SessionID.make("ses_missing"))).toBe("acceptEdits")
    }),
  )

  it.instance("the plan agent resolves to plan", () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const session = yield* created({ permissionMode: "acceptEdits" })
      expect(yield* permission.mode(session.id, "plan")).toBe("plan")
      expect(yield* permission.mode(session.id, "build")).toBe("acceptEdits")
    }),
  )

  it.instance("a config default of bypassPermissions is ignored when bypass is disabled", () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const session = yield* created({})
      config = { default_permission_mode: "bypassPermissions", disable_bypass_permissions: true }
      expect(yield* permission.mode(session.id)).toBe("default")
    }),
  )
})

describe("Permission.setMode", () => {
  it.instance("stores the mode and records the mode before plan", () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const session = yield* Session.Service
      const root = yield* created({ permissionMode: "acceptEdits" })
      const child = yield* created({ parentID: root.id })

      yield* permission.setMode(root.id, "plan")
      expect((yield* session.get(root.id)).permissionMode).toBe("plan")
      expect(yield* permission.prePlan(child.id)).toBe("acceptEdits")

      yield* permission.setMode(root.id, "plan")
      expect(yield* permission.prePlan(root.id)).toBe("acceptEdits")

      yield* permission.setMode(root.id, null)
      expect((yield* session.get(root.id)).permissionMode).toBeUndefined()
      expect(yield* permission.mode(root.id)).toBe("default")
    }),
  )

  it.instance("bypassPermissions is stored when the gate passes", () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const root = yield* created({})
      const uid = spyOn(process, "getuid").mockReturnValue(501)
      try {
        yield* permission.setMode(root.id, "bypassPermissions")
      } finally {
        uid.mockRestore()
      }
      expect(yield* permission.mode(root.id)).toBe("bypassPermissions")
    }),
  )

  it.instance("bypassPermissions fails with ModeError when running as root", () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const session = yield* Session.Service
      const root = yield* created({})
      const previous = process.env.IS_SANDBOX
      delete process.env.IS_SANDBOX
      const uid = spyOn(process, "getuid").mockReturnValue(0)
      const exit = yield* permission.setMode(root.id, "bypassPermissions").pipe(
        Effect.exit,
        Effect.ensuring(
          Effect.sync(() => {
            uid.mockRestore()
            if (previous !== undefined) process.env.IS_SANDBOX = previous
          }),
        ),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(Permission.ModeError)
        expect(String((error as Error).message)).toContain("running as root")
      }
      expect((yield* session.get(root.id)).permissionMode).toBeUndefined()
    }),
  )

  it.instance("bypassPermissions fails with ModeError when disabled by configuration", () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const root = yield* created({})
      config = { disable_bypass_permissions: true }
      const exit = yield* permission.setMode(root.id, "bypassPermissions").pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Permission.ModeError)
    }),
  )

  it.instance("a missing session fails with ModeError", () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const exit = yield* permission.setMode(SessionID.make("ses_missing"), "acceptEdits").pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Permission.ModeError)
    }),
  )
})
