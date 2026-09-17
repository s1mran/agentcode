import { describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Deferred, Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { migrations } from "@opencode-ai/core/database/migration.gen"
import permissionModeMigration from "@opencode-ai/core/database/migration/20260916000000_session-permission-mode"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session as SessionNs } from "@/session/session"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { SessionID } from "@/session/schema"
import { ProjectV2 } from "@opencode-ai/core/project"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      SessionNs.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const awaitDeferred = <T>(deferred: Deferred.Deferred<T>, message: string) =>
  Effect.race(
    Deferred.await(deferred),
    Effect.sleep("2 seconds").pipe(Effect.flatMap(() => Effect.fail(new Error(message)))),
  )

const created = (input?: Parameters<SessionNs.Interface["create"]>[0]) =>
  Effect.gen(function* () {
    const session = yield* SessionNs.Service
    return yield* Effect.acquireRelease(session.create(input), (info) => session.remove(info.id).pipe(Effect.ignore))
  })

describe("session permission mode", () => {
  it.instance("create persists the mode and get returns it", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const info = yield* created({ permissionMode: "plan" })

      expect(info.permissionMode).toBe("plan")
      expect((yield* session.get(info.id)).permissionMode).toBe("plan")
    }),
  )

  it.instance("setPermissionMode(null) clears the mode", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const info = yield* created({ permissionMode: "acceptEdits" })

      yield* session.setPermissionMode({ sessionID: info.id, mode: "dontAsk" })
      expect((yield* session.get(info.id)).permissionMode).toBe("dontAsk")

      yield* session.setPermissionMode({ sessionID: info.id, mode: null })
      const cleared = yield* session.get(info.id)
      expect(cleared.permissionMode).toBeUndefined()
      expect("permissionMode" in cleared && cleared.permissionMode !== undefined).toBe(false)
    }),
  )

  it.instance("a session without a mode reads back undefined", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const info = yield* created({})

      expect(info.permissionMode).toBeUndefined()
      expect((yield* session.get(info.id)).permissionMode).toBeUndefined()
    }),
  )

  it.instance("session.updated carries permissionMode", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const info = yield* created({})
      const received = yield* Deferred.make<SessionV1.SessionInfo>()

      const unsubscribe = yield* events.listen((event) => {
        if (event.type !== SessionNs.Event.Updated.type) return Effect.void
        const data = event.data as typeof SessionNs.Event.Updated.data.Type
        if (data.sessionID === info.id && data.info.permissionMode === "acceptEdits")
          Deferred.doneUnsafe(received, Effect.succeed(data.info))
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* session.setPermissionMode({ sessionID: info.id, mode: "acceptEdits" })
      const updated = yield* awaitDeferred(received, "timed out waiting for session.updated with permissionMode")

      expect(updated.id).toBe(info.id)
      expect(updated.permissionMode).toBe("acceptEdits")
    }),
  )

  it.instance("create silently drops bypassPermissions", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const info = yield* created({ permissionMode: "bypassPermissions" })

      expect(info.permissionMode).toBeUndefined()
      expect((yield* session.get(info.id)).permissionMode).toBeUndefined()
    }),
  )

  it.instance("fork copies acceptEdits but not bypassPermissions", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const release = (info: SessionNs.Info) => session.remove(info.id).pipe(Effect.ignore)

      const edits = yield* created({ permissionMode: "acceptEdits" })
      const editsFork = yield* Effect.acquireRelease(session.fork({ sessionID: edits.id }), release)
      expect(editsFork.permissionMode).toBe("acceptEdits")
      expect((yield* session.get(editsFork.id)).permissionMode).toBe("acceptEdits")

      const bypass = yield* created({})
      yield* session.setPermissionMode({ sessionID: bypass.id, mode: "bypassPermissions" })
      expect((yield* session.get(bypass.id)).permissionMode).toBe("bypassPermissions")
      const bypassFork = yield* Effect.acquireRelease(session.fork({ sessionID: bypass.id }), release)
      expect(bypassFork.permissionMode).toBeUndefined()
      expect((yield* session.get(bypassFork.id)).permissionMode).toBeUndefined()
    }),
  )

  it.instance("create and setPermission strip source from client rules", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const info = yield* created({
        permission: [{ permission: "bash", pattern: "*", action: "allow", source: "builtin" }],
      })
      expect(info.permission).toEqual([{ permission: "bash", pattern: "*", action: "allow" }])
      expect((yield* session.get(info.id)).permission).toEqual([{ permission: "bash", pattern: "*", action: "allow" }])

      yield* session.setPermission({
        sessionID: info.id,
        permission: [
          { permission: "edit", pattern: "*", action: "allow", source: "builtin" },
          { permission: "read", pattern: "*.env", action: "ask" },
        ],
      })
      const stored = yield* session.get(info.id)
      expect(stored.permission).toEqual([
        { permission: "edit", pattern: "*", action: "allow" },
        { permission: "read", pattern: "*.env", action: "ask" },
      ])
      expect(stored.permission?.some((rule) => "source" in rule)).toBe(false)
    }),
  )
})

describe("session permission mode - review fixes", () => {
  it.instance("an unknown stored mode reads back undefined and sessions still encode", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const { db } = yield* Database.Service
      const info = yield* created({ permissionMode: "plan" })
      yield* db.run(sql`UPDATE session SET permission_mode = 'auto' WHERE id = ${info.id}`)

      const stored = yield* session.get(info.id)
      expect(stored.permissionMode).toBeUndefined()
      const children = yield* session.children(info.id)
      expect(Schema.encodeUnknownExit(Schema.Array(SessionNs.Info))([stored, ...children])._tag).toBe("Success")
    }),
  )

  it.instance("unrelated patches keep the stored mode", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const info = yield* created({ permissionMode: "plan" })

      yield* session.setTitle({ sessionID: info.id, title: "renamed" })
      yield* session.setMetadata({ sessionID: info.id, metadata: { a: 1 } })
      yield* session.setAgentModel({
        sessionID: info.id,
        agent: "build",
        model: { id: "m", providerID: "p", variant: "default" } as unknown as NonNullable<SessionNs.Info["model"]>,
        time: Date.now(),
      })
      yield* session.touch(info.id)
      yield* session.setArchived({ sessionID: info.id, time: Date.now() })
      yield* session.setArchived({ sessionID: info.id })
      expect((yield* session.get(info.id)).permissionMode).toBe("plan")
    }),
  )

  it.instance("a replayed session.updated without a mode clears it and never stores built-in rule tags", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const info = yield* created({ permissionMode: "acceptEdits" })
      const current = yield* session.get(info.id)
      const { permissionMode: _mode, ...rest } = current
      yield* events.publish(SessionNs.Event.Updated, {
        sessionID: info.id,
        info: { ...rest, permission: [{ permission: "bash", pattern: "*", action: "allow", source: "builtin" }] },
      })
      const stored = yield* session.get(info.id)
      expect(stored.permissionMode).toBeUndefined()
      expect(stored.permission).toEqual([{ permission: "bash", pattern: "*", action: "allow" }])
    }),
  )

  it.instance("a concurrent patch never writes back a mode that was replaced meanwhile", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      for (let round = 0; round < 20; round++) {
        const info = yield* created({ permissionMode: "acceptEdits" })
        yield* Effect.all(
          [
            session.setTitle({ sessionID: info.id, title: `t${round}` }),
            session.setPermissionMode({ sessionID: info.id, mode: "default" }),
            session.setMetadata({ sessionID: info.id, metadata: { round } }),
            session.touch(info.id),
          ],
          { concurrency: "unbounded" },
        )
        const stored = yield* session.get(info.id)
        expect(stored.permissionMode).toBe("default")
        expect(stored.title).toBe(`t${round}`)
        expect(stored.metadata).toEqual({ round })
      }
    }),
  )

  it.instance("fork keeps the mode a subagent session inherits from its parents", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const release = (info: SessionNs.Info) => session.remove(info.id).pipe(Effect.ignore)

      const planRoot = yield* created({ permissionMode: "plan" })
      const planChild = yield* created({ parentID: planRoot.id })
      const planFork = yield* Effect.acquireRelease(session.fork({ sessionID: planChild.id }), release)
      expect(planFork.parentID).toBeUndefined()
      expect((yield* session.get(planFork.id)).permissionMode).toBe("plan")

      const dontAskRoot = yield* created({ permissionMode: "dontAsk" })
      const middle = yield* created({ parentID: dontAskRoot.id, permissionMode: "default" })
      const leaf = yield* created({ parentID: middle.id })
      expect((yield* Effect.acquireRelease(session.fork({ sessionID: leaf.id }), release)).permissionMode).toBe(
        "dontAsk",
      )

      const plain = yield* created({})
      const plainChild = yield* created({ parentID: plain.id })
      expect((yield* Effect.acquireRelease(session.fork({ sessionID: plainChild.id }), release)).permissionMode).toBe(
        undefined,
      )
    }),
  )
})

describe("inheritedMode", () => {
  test("carries plan and dontAsk, lets a descendant only narrow, and never copies bypassPermissions", () => {
    expect(SessionNs.inheritedMode([{}, {}])).toBeUndefined()
    expect(SessionNs.inheritedMode([{}, { permissionMode: "plan" }])).toBe("plan")
    expect(SessionNs.inheritedMode([{ permissionMode: "acceptEdits" }, { permissionMode: "default" }])).toBe("default")
    expect(SessionNs.inheritedMode([{ permissionMode: "default" }, { permissionMode: "acceptEdits" }])).toBe("default")
    expect(SessionNs.inheritedMode([{}, { permissionMode: "bypassPermissions" }])).toBeUndefined()
  })
})

describe("session row mapping", () => {
  const info = (extra: Partial<SessionNs.Info>): SessionNs.Info => ({
    id: SessionID.make("ses_row"),
    slug: "slug",
    projectID: ProjectV2.ID.make("global"),
    directory: "/tmp",
    title: "t",
    version: "1",
    time: { created: 1, updated: 1 },
    ...extra,
  })

  test("toRow maps the mode, drops bypassPermissions and strips rule sources", () => {
    expect(SessionNs.toRow(info({ permissionMode: "plan" })).permission_mode).toBe("plan")
    expect(SessionNs.toRow(info({})).permission_mode).toBeNull()
    expect(SessionNs.toRow(info({ permissionMode: "bypassPermissions" })).permission_mode).toBeNull()
    expect(
      SessionNs.toRow(info({ permission: [{ permission: "bash", pattern: "*", action: "allow", source: "builtin" }] }))
        .permission,
    ).toEqual([{ permission: "bash", pattern: "*", action: "allow" }])
  })
})

describe("session permission_mode migration", () => {
  const columns = (db: Database.Interface["db"]) =>
    db.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('session') WHERE name = 'permission_mode'`)

  test("is registered last and a fresh database has the column", async () => {
    expect(migrations.at(-1)?.id).toBe("20260916000000_session-permission-mode")
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        expect(yield* columns(db)).toEqual([{ name: "permission_mode" }])
      }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
    )
  })

  test("adds permission_mode once and re-running is a no-op", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const forget = db.run(sql`DELETE FROM migration WHERE id = ${permissionModeMigration.id}`)

        // Simulate a database created before this migration existed.
        yield* db.run(sql`ALTER TABLE session DROP COLUMN permission_mode`)
        yield* forget
        expect(yield* columns(db)).toEqual([])

        yield* DatabaseMigration.applyOnly(db, [permissionModeMigration])
        expect(yield* columns(db)).toEqual([{ name: "permission_mode" }])
        expect(yield* db.all(sql`SELECT id FROM migration WHERE id = ${permissionModeMigration.id}`)).toEqual([
          { id: permissionModeMigration.id },
        ])

        // Already recorded: skipped.
        yield* DatabaseMigration.applyOnly(db, [permissionModeMigration])
        // Column present but not recorded (e.g. a replayed id): the PRAGMA guard makes it a no-op.
        yield* forget
        yield* DatabaseMigration.applyOnly(db, [permissionModeMigration])
        expect(yield* columns(db)).toEqual([{ name: "permission_mode" }])
      }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
    )
  })
})

describe("permission schema additions", () => {
  test("Request with a guard round-trips", () => {
    const request = {
      id: "per_test",
      sessionID: "ses_test",
      permission: "bash",
      patterns: ["rm -rf /"],
      metadata: {},
      always: [],
      guard: { level: "floor", category: "critical_rm", reason: "x" },
      alwaysScope: "project",
    } as const
    const decoded = Schema.decodeUnknownSync(PermissionV1.Request)(request)
    expect(decoded.guard).toEqual({ level: "floor", category: "critical_rm", reason: "x" })
    expect(Schema.encodeSync(PermissionV1.Request)(decoded)).toEqual(request)

    const withPaths = { ...request, guard: { ...request.guard, paths: ["/"] } }
    expect(Schema.encodeSync(PermissionV1.Request)(Schema.decodeUnknownSync(PermissionV1.Request)(withPaths))).toEqual(
      withPaths,
    )
  })

  test("a Request without the new fields still decodes and encodes without them", () => {
    const request = {
      id: "per_old",
      sessionID: "ses_old",
      permission: "edit",
      patterns: ["a.ts"],
      metadata: {},
      always: ["*"],
    }
    expect(Schema.encodeSync(PermissionV1.Request)(Schema.decodeUnknownSync(PermissionV1.Request)(request))).toEqual(
      request,
    )
  })

  test("a Guard without level or category fails to decode", () => {
    const decode = Schema.decodeUnknownExit(PermissionV1.Guard)
    expect(decode({ category: "secret", reason: "x" })._tag).toBe("Failure")
    expect(decode({ level: "guard", reason: "x" })._tag).toBe("Failure")
    expect(decode({ level: "other", category: "secret", reason: "x" })._tag).toBe("Failure")
    expect(decode({ level: "guard", category: "secret", reason: "x" })._tag).toBe("Success")
  })

  test("AskInput decodes without hints and with hints", () => {
    const base = {
      sessionID: "ses_ask",
      permission: "bash",
      patterns: ["ls"],
      metadata: {},
      always: ["ls *"],
      ruleset: [{ permission: "bash", pattern: "*", action: "ask", source: "builtin" }],
    }
    const plain = Schema.decodeUnknownSync(PermissionV1.AskInput)(base)
    expect(plain.hints).toBeUndefined()
    expect(plain.ruleset[0]?.source).toBe("builtin")

    const hinted = Schema.decodeUnknownSync(PermissionV1.AskInput)({
      ...base,
      hints: [
        { pattern: "ls", readOnly: true, strict: "ls", loose: "ls" },
        {
          pattern: "git push --force",
          withholdAlways: true,
          guard: { level: "guard", category: "destructive_git", reason: "force push" },
        },
      ],
    })
    expect(hinted.hints?.[0]?.readOnly).toBe(true)
    expect(hinted.hints?.[1]?.guard?.category).toBe("destructive_git")
  })

  test("Rule rejects unknown source values and Mode rejects unknown modes", () => {
    expect(
      Schema.decodeUnknownExit(PermissionV1.Rule)({ permission: "*", pattern: "*", action: "ask", source: "user" })
        ._tag,
    ).toBe("Failure")
    expect(Schema.decodeUnknownExit(PermissionV1.Mode)("auto")._tag).toBe("Failure")
    expect(Schema.decodeUnknownSync(PermissionV1.Mode)("bypassPermissions")).toBe("bypassPermissions")
  })

  test("DeniedError exposes reason in its message", () => {
    const reason = "Plan mode is active: edits are blocked except the plan file."
    const denied = new PermissionV1.DeniedError({ ruleset: [], reason })
    expect(denied.reason).toBe(reason)
    expect(denied.message).toBe(reason)

    const legacy = new PermissionV1.DeniedError({ ruleset: [{ permission: "bash", pattern: "*", action: "deny" }] })
    expect(legacy.reason).toBeUndefined()
    expect(legacy.message).toContain("The user has specified a rule which prevents you")
  })

  test("SessionInfo and Assistant accept permissionMode", () => {
    const info = Schema.decodeUnknownSync(SessionV1.SessionInfo)({
      id: "ses_info",
      slug: "slug",
      projectID: "global",
      directory: "/tmp",
      title: "t",
      version: "1",
      time: { created: 1, updated: 1 },
      permissionMode: "plan",
    })
    expect(info.permissionMode).toBe("plan")
    expect(
      Schema.decodeUnknownExit(SessionV1.SessionInfo)({
        id: "ses_info",
        slug: "slug",
        projectID: "global",
        directory: "/tmp",
        title: "t",
        version: "1",
        time: { created: 1, updated: 1 },
        permissionMode: "yolo",
      })._tag,
    ).toBe("Failure")
    expect(SessionV1.Assistant.fields.permissionMode).toBeDefined()
  })
})
