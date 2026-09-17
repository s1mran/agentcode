import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { deriveSubagentSessionPermission } from "../../src/agent/subagent-permissions"
import { autoReplyPermissions } from "../../src/cli/cmd/github.shared"
import { Permission } from "../../src/permission"
import { DONT_ASK_REASON } from "../../src/permission/evaluate"
import { PermissionLocalStore } from "../../src/permission/local-store"
import { TestConfig } from "../fixture/config"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

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
      [Config.node, TestConfig.layer()],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const defaults: PermissionV1.Ruleset = [{ permission: "*", pattern: "*", action: "ask", source: "builtin" }]

const created = (input?: Parameters<Session.Interface["create"]>[0]) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    return yield* Effect.acquireRelease(session.create(input), (info) => session.remove(info.id).pipe(Effect.ignore))
  })

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    while (true) {
      const list = yield* permission.list()
      if (list.length === count) return list
      yield* Effect.sleep("10 millis")
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: "2 seconds",
      orElse: () => Effect.fail(new Error(`timed out waiting for ${count} pending permission request(s)`)),
    }),
  )

const ask = (input: Omit<PermissionV1.AskInput, "ruleset" | "metadata" | "always"> & Partial<PermissionV1.AskInput>) =>
  Permission.Service.use((permission) =>
    permission.ask({ metadata: {}, always: [], ruleset: defaults, ...input } as PermissionV1.AskInput),
  )

/** Asks and expects the request to resolve without prompting. */
const silently = (input: Parameters<typeof ask>[0]) =>
  ask(input).pipe(
    Effect.timeoutOrElse({
      duration: "2 seconds",
      orElse: () => Effect.fail(new Error("expected the permission request to resolve without prompting")),
    }),
  )

/** Asks, returns the published request, then rejects it. */
const prompted = (input: Parameters<typeof ask>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const fiber = yield* ask(input).pipe(Effect.forkScoped)
    const [request] = yield* waitForPending(1)
    yield* permission.reply({ requestID: request.id, reply: "reject" })
    yield* Fiber.await(fiber)
    return request
  })

const failure = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(self)
    if (Exit.isSuccess(exit)) throw new Error("expected the permission request to fail")
    return Cause.squash(exit.cause)
  })

const replies = Effect.gen(function* () {
  const events = yield* EventV2Bridge.Service
  const seen: Array<{ sessionID: string; requestID: string; reply: string }> = []
  const unsubscribe = yield* events.listen((event) => {
    if (event.type === Permission.Event.Replied.type) seen.push(event.data as (typeof seen)[number])
    return Effect.void
  })
  yield* Effect.addFinalizer(() => unsubscribe)
  return seen
})

const promise = <A>(fn: () => Promise<A>) => Effect.promise(fn)
const localFile = (dir: string) => path.join(dir, ".opencode", PermissionLocalStore.FILE)
const exists = (file: string) =>
  promise(() =>
    fs.lstat(file).then(
      () => true,
      () => false,
    ),
  )

describe("Permission service - floor", () => {
  it.instance(
    "an edit inside .git asks with a floor guard, no always, and an always reply saves nothing",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const permission = yield* Permission.Service
        const session = yield* Session.Service
        const root = yield* created({})
        const input = {
          sessionID: root.id,
          permission: "edit",
          patterns: [".git/hooks/pre-commit"],
          always: ["*"],
          metadata: { filepath: path.join(directory, ".git", "hooks", "pre-commit") },
          ruleset: [...defaults, { permission: "edit", pattern: "*", action: "allow" as const }],
        }
        const seen = yield* replies

        const fiber = yield* ask(input).pipe(Effect.forkScoped)
        const [request] = yield* waitForPending(1)
        expect(request.guard).toMatchObject({ level: "floor", category: "protected_path" })
        expect(request.always).toEqual([])
        expect(request.alwaysScope).toBeUndefined()
        yield* permission.reply({ requestID: request.id, reply: "always" })
        yield* Fiber.join(fiber)
        expect(seen).toContainEqual(expect.objectContaining({ requestID: request.id, reply: "once" }))

        const again = yield* prompted(input)
        expect(again.guard?.level).toBe("floor")
        expect(yield* exists(localFile(directory))).toBe(false)
        expect((yield* session.get(root.id)).permissionMode).toBeUndefined()
      }),
    { git: true },
  )

  it.instance(
    "an edit through a symlinked folder that resolves into .git is floor",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* promise(() => fs.symlink(path.join(directory, ".git"), path.join(directory, "gitlink")))
        const request = yield* prompted({
          sessionID: SessionID.make("ses_symlink"),
          permission: "edit",
          patterns: ["gitlink/config"],
          always: ["*"],
          metadata: { filepath: path.join(directory, "gitlink", "config") },
        })
        expect(request.guard?.level).toBe("floor")
        expect(request.always).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "external_directory asks for shell startup files and ~/.ssh carry a floor guard and no always",
    () =>
      Effect.gen(function* () {
        const home = os.homedir()
        const zshrc = yield* prompted({
          sessionID: SessionID.make("ses_external"),
          permission: "external_directory",
          patterns: [path.join(home, "*")],
          always: [path.join(home, "*")],
          metadata: { filepath: path.join(home, ".zshrc"), parentDir: home },
        })
        expect(zshrc.guard).toMatchObject({ level: "floor", category: "protected_path" })
        expect(zshrc.always).toEqual([])

        const ssh = yield* prompted({
          sessionID: SessionID.make("ses_external"),
          permission: "external_directory",
          patterns: [path.join(home, ".ssh", "*")],
          always: [path.join(home, ".ssh", "*")],
          metadata: { filepath: path.join(home, ".ssh", "config"), parentDir: path.join(home, ".ssh") },
        })
        expect(ssh.guard?.level).toBe("floor")
        expect(ssh.always).toEqual([])

        const work = yield* prompted({
          sessionID: SessionID.make("ses_external"),
          permission: "external_directory",
          patterns: [path.join(home, "some-project", "*")],
          always: [path.join(home, "some-project", "*")],
          metadata: { filepath: path.join(home, "some-project", "notes.md") },
        })
        expect(work.guard).toBeUndefined()
        expect(work.always).toEqual([path.join(home, "some-project", "*")])
        expect(work.alwaysScope).toBe("project")

        // Read-only tools mark their lookups with access: "read"; reading a protected file is not a write.
        const read = yield* prompted({
          sessionID: SessionID.make("ses_external"),
          permission: "external_directory",
          patterns: [path.join(home, "*")],
          always: [path.join(home, "*")],
          metadata: { filepath: path.join(home, ".zshrc"), parentDir: home, access: "read" },
        })
        expect(read.guard).toBeUndefined()
      }),
    { git: true },
  )

  it.instance(
    "a critical rm without hints asks with a floor guard even when bash is allowed",
    () =>
      Effect.gen(function* () {
        const request = yield* prompted({
          sessionID: SessionID.make("ses_rm"),
          permission: "bash",
          patterns: ["rm -rf ~"],
          always: ["rm -rf ~"],
          ruleset: [...defaults, { permission: "bash", pattern: "*", action: "allow" }],
        })
        expect(request.guard).toMatchObject({ level: "floor", category: "critical_rm" })
        expect(request.always).toEqual([])
      }),
    { git: true },
  )
})

describe("Permission service - project approvals", () => {
  it.instance(
    "an always answer on bash is saved to settings.local.json and honoured by a fresh instance",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const permission = yield* Permission.Service
        const store = yield* InstanceStore.Service
        const hint = (command: string, strict = command) => ({ pattern: command, strict, loose: command })

        const approve = (command: string, always: string) =>
          Effect.gen(function* () {
            const fiber = yield* ask({
              sessionID: SessionID.make("ses_bash"),
              permission: "bash",
              patterns: [command],
              always: [always],
              hints: [hint(command)],
            }).pipe(Effect.forkScoped)
            const [request] = yield* waitForPending(1)
            expect(request.alwaysScope).toBe("project")
            expect(request.always).toEqual([always])
            yield* permission.reply({ requestID: request.id, reply: "always" })
            yield* Fiber.join(fiber)
          })

        yield* approve("git checkout main", "git checkout *")
        yield* approve("git switch main", "git switch *")

        const saved = JSON.parse(yield* promise(() => fs.readFile(localFile(directory), "utf8")))
        expect(saved).toEqual({ permission: { bash: { "git checkout *": "allow", "git switch *": "allow" } } })
        const exclude = yield* promise(() => fs.readFile(path.join(directory, ".git", "info", "exclude"), "utf8"))
        expect(exclude.split("\n").filter((line) => line === PermissionLocalStore.EXCLUDE_LINE)).toHaveLength(1)

        yield* store.reload({ directory })
        yield* store.provide(
          { directory },
          Effect.gen(function* () {
            yield* silently({
              sessionID: SessionID.make("ses_other"),
              permission: "bash",
              patterns: ["git checkout feature"],
              hints: [hint("git checkout feature")],
            })
            // Allow rules only match the strict form, which keeps unsafe environment assignments.
            const unsafe = yield* prompted({
              sessionID: SessionID.make("ses_other"),
              permission: "bash",
              patterns: ["GIT_DIR=x git checkout main"],
              hints: [hint("GIT_DIR=x git checkout main")],
            })
            expect(unsafe.permission).toBe("bash")
          }),
        )
      }),
    { git: true },
  )

  it.instance(
    "a settings.local.json tracked by git is ignored",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* promise(async () => {
          await fs.mkdir(path.dirname(localFile(directory)), { recursive: true })
          await fs.writeFile(
            localFile(directory),
            JSON.stringify({ permission: { bash: { "git checkout *": "allow" } } }),
          )
          await $`git add -f .opencode/settings.local.json`.cwd(directory).quiet()
        })
        yield* prompted({
          sessionID: SessionID.make("ses_tracked"),
          permission: "bash",
          patterns: ["git checkout main"],
        })
      }),
    { git: true },
  )

  it.instance(
    "a symlinked settings.local.json is ignored",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* promise(async () => {
          const target = path.join(directory, "approvals.json")
          await fs.writeFile(target, JSON.stringify({ permission: { bash: { "git checkout *": "allow" } } }))
          await fs.mkdir(path.dirname(localFile(directory)), { recursive: true })
          await fs.symlink(target, localFile(directory))
        })
        yield* prompted({
          sessionID: SessionID.make("ses_symlink"),
          permission: "bash",
          patterns: ["git checkout main"],
        })
      }),
    { git: true },
  )

  it.instance(
    "a corrupt settings.local.json is not overwritten and approvals fall back to the session",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const permission = yield* Permission.Service
        yield* promise(async () => {
          await fs.mkdir(path.dirname(localFile(directory)), { recursive: true })
          await fs.writeFile(localFile(directory), "{ not json")
        })
        const input = {
          sessionID: SessionID.make("ses_corrupt"),
          permission: "bash",
          patterns: ["npm test"],
          always: ["npm test *"],
        }
        const fiber = yield* ask(input).pipe(Effect.forkScoped)
        const [request] = yield* waitForPending(1)
        yield* permission.reply({ requestID: request.id, reply: "always" })
        yield* Fiber.join(fiber)

        expect(yield* promise(() => fs.readFile(localFile(directory), "utf8"))).toBe("{ not json")
        yield* silently(input)
        yield* prompted({ ...input, sessionID: SessionID.make("ses_corrupt_other") })
      }),
    { git: true },
  )
})

describe("Permission service - review fixes", () => {
  it.instance(
    "a session last prompted on the plan agent follows its stored mode once another agent runs",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const root = yield* created({ agent: "plan", permissionMode: "acceptEdits" })
        const edit = {
          sessionID: root.id,
          permission: "edit",
          patterns: ["src/a.ts"],
          metadata: { filepath: path.join(directory, "src", "a.ts") },
        }
        // plan_exit leaves Session.Info.agent on "plan" while the build agent implements the plan.
        yield* silently({ ...edit, agent: "build" })
        yield* silently(edit)
        const denied = yield* failure(ask({ ...edit, agent: "plan" }))
        expect(denied).toBeInstanceOf(PermissionV1.DeniedError)
      }),
    { git: true },
  )

  it.instance(
    "an explicit edit ask offers session-scoped always, never a switch to Accept edits",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const permission = yield* Permission.Service
        const session = yield* Session.Service
        const root = yield* created({})
        const edit = (file: string) => ({
          sessionID: root.id,
          permission: "edit",
          patterns: [file],
          always: ["*"],
          metadata: { filepath: path.join(directory, file) },
          ruleset: [...defaults, { permission: "edit", pattern: "*", action: "ask" as const }],
        })
        const fiber = yield* ask(edit("src/a.ts")).pipe(Effect.forkScoped)
        const [request] = yield* waitForPending(1)
        expect(request.alwaysScope).toBe("session")
        yield* permission.reply({ requestID: request.id, reply: "always" })
        yield* Fiber.join(fiber)
        expect((yield* session.get(root.id)).permissionMode).toBeUndefined()
        yield* silently(edit("src/a.ts"))
        expect((yield* prompted(edit("src/b.ts"))).alwaysScope).toBe("session")

        const catchall = yield* prompted({
          ...edit("src/c.ts"),
          ruleset: [...defaults, { permission: "*", pattern: "*", action: "ask" as const }],
        })
        expect(catchall.alwaysScope).toBe("session")
      }),
    { git: true },
  )

  it.instance(
    "always is withheld when the saved rule could never beat an explicit tool-level ask",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const request = yield* prompted({
          sessionID: SessionID.make("ses_websearch"),
          permission: "websearch",
          patterns: ["*"],
          always: ["*"],
          ruleset: [...defaults, { permission: "websearch", pattern: "*", action: "ask" }],
        })
        expect(request.always).toEqual([])
        expect(request.alwaysScope).toBeUndefined()

        const specific = yield* prompted({
          sessionID: SessionID.make("ses_websearch"),
          permission: "bash",
          patterns: ["npm test"],
          always: ["npm test *"],
          ruleset: [...defaults, { permission: "bash", pattern: "*", action: "ask" }],
        })
        expect(specific.always).toEqual(["npm test *"])
        expect(specific.alwaysScope).toBe("project")
        expect(yield* exists(localFile(directory))).toBe(false)
      }),
    { git: true },
  )

  it.instance(
    "acceptEdits does not approve an edit through an in-project symlink to a folder outside the project",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const outside = yield* promise(() => fs.mkdtemp(path.join(os.tmpdir(), "perm-link-")))
        yield* Effect.addFinalizer(() => promise(() => fs.rm(outside, { recursive: true, force: true })))
        yield* promise(() => fs.symlink(outside, path.join(directory, "vendor")))
        const root = yield* created({ permissionMode: "acceptEdits" })
        const request = yield* prompted({
          sessionID: root.id,
          permission: "edit",
          patterns: ["vendor/index.ts"],
          always: ["*"],
          metadata: { filepath: path.join(directory, "vendor", "index.ts") },
        })
        expect(request.permission).toBe("edit")
        yield* silently({
          sessionID: root.id,
          permission: "edit",
          patterns: ["src/a.ts"],
          metadata: { filepath: path.join(directory, "src", "a.ts") },
        })
      }),
    { git: true },
  )

  it.instance(
    "writing the global approvals folder always asks",
    () =>
      Effect.gen(function* () {
        const target = path.join(Global.Path.data, "permission", "abc.json")
        const request = yield* prompted({
          sessionID: SessionID.make("ses_global"),
          permission: "external_directory",
          patterns: [path.join(Global.Path.data, "permission", "*")],
          always: [path.join(Global.Path.data, "permission", "*")],
          metadata: { filepath: target },
          ruleset: [
            ...defaults,
            { permission: "external_directory", pattern: path.join(Global.Path.data, "*"), action: "allow" },
          ],
        })
        expect(request.guard?.level).toBe("floor")
      }),
    { git: true },
  )

  it.instance(
    "writing the workspace trust store always asks, whatever the rules allow",
    () =>
      Effect.gen(function* () {
        const target = path.join(Global.Path.data, "trust", "workspaces.json")
        for (const permission of ["external_directory", "edit"] as const) {
          const request = yield* prompted({
            sessionID: SessionID.make("ses_trust_store"),
            permission,
            patterns: permission === "edit" ? [target] : [path.join(Global.Path.data, "trust", "*")],
            always: permission === "edit" ? [target] : [path.join(Global.Path.data, "trust", "*")],
            metadata: { filepath: target },
            ruleset: [
              ...defaults,
              { permission: "external_directory", pattern: "*", action: "allow" },
              { permission: "edit", pattern: "*", action: "allow" },
            ],
          })
          expect(request.guard?.level).toBe("floor")
          expect(request.always).toEqual([])
        }
      }),
    { git: true },
  )

  it.instance(
    "a subagent session cannot store a looser mode than its parent",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const permission = yield* Permission.Service
        const root = yield* created({})
        const child = yield* created({ parentID: root.id, permissionMode: "acceptEdits" })
        expect(yield* permission.mode(child.id)).toBe("default")
        yield* permission.setMode(child.id, "acceptEdits")
        expect(yield* permission.mode(child.id)).toBe("default")
        yield* prompted({
          sessionID: child.id,
          permission: "edit",
          patterns: ["src/a.ts"],
          metadata: { filepath: path.join(directory, "src", "a.ts") },
        })
      }),
    { git: true },
  )
})

describe("Permission service - headless and subagent paths", () => {
  it.instance(
    "the GitHub agent's auto-reply approves ordinary asks once and rejects floor asks instead of hanging",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const permission = yield* Permission.Service
        const events = yield* EventV2Bridge.Service
        const logs: string[] = []
        const off = yield* autoReplyPermissions({ events, reply: permission.reply, log: (line) => logs.push(line) })
        yield* Effect.addFinalizer(() => off)
        const root = yield* created({})

        yield* silently({ sessionID: root.id, permission: "bash", patterns: ["npm test"], always: ["npm test *"] })
        yield* silently({
          sessionID: root.id,
          permission: "edit",
          patterns: ["src/a.ts"],
          metadata: { filepath: path.join(directory, "src", "a.ts") },
        })
        const floor = yield* failure(
          silently({
            sessionID: root.id,
            permission: "edit",
            patterns: [".git/hooks/pre-commit"],
            metadata: { filepath: path.join(directory, ".git", "hooks", "pre-commit") },
          }),
        )
        expect(floor).toBeInstanceOf(PermissionV1.RejectedError)
        expect(logs.some((line) => line.includes("needs interactive approval"))).toBe(true)
        expect(yield* permission.list()).toHaveLength(0)
        expect(yield* exists(localFile(directory))).toBe(false)
      }),
    { git: true },
  )

  it.instance(
    "a parent session's explicit ask still asks in the subagent session; read-only commands stay silent",
    () =>
      Effect.gen(function* () {
        const root = yield* created({ permission: [{ permission: "bash", pattern: "git push *", action: "ask" }] })
        const subagent = {
          name: "general",
          mode: "subagent" as const,
          options: {},
          permission: [...defaults, { permission: "bash", pattern: "*", action: "allow" as const }],
        }
        const childRules = deriveSubagentSessionPermission({
          parentSessionPermission: root.permission ?? [],
          subagent,
        })
        const child = yield* created({ parentID: root.id, permission: childRules })
        const ruleset = [...subagent.permission, ...(child.permission ?? [])]
        const hint = (command: string, readOnly = false) => ({
          pattern: command,
          strict: command,
          loose: command,
          ...(readOnly ? { readOnly } : {}),
        })

        const push = yield* prompted({
          sessionID: child.id,
          permission: "bash",
          patterns: ["git push origin main"],
          hints: [hint("git push origin main")],
          ruleset,
        })
        expect(push.permission).toBe("bash")
        yield* silently({
          sessionID: child.id,
          permission: "bash",
          patterns: ["npm test"],
          hints: [hint("npm test")],
          ruleset,
        })
        yield* silently({
          sessionID: child.id,
          permission: "bash",
          patterns: ["ls"],
          hints: [hint("ls", true)],
          ruleset: [...defaults, ...(child.permission ?? [])],
        })
      }),
    { git: true },
  )
})

describe("Permission service - edit approvals and modes", () => {
  it.instance(
    "an always answer on an in-project edit switches the root session to Accept edits",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const permission = yield* Permission.Service
        const session = yield* Session.Service
        const root = yield* created({})
        const child = yield* created({ parentID: root.id })
        const other = yield* created({})
        const edit = (sessionID: SessionID, file: string) => ({
          sessionID,
          permission: "edit",
          patterns: [file],
          always: ["*"],
          metadata: { filepath: path.join(directory, file) },
        })

        const fiber = yield* ask(edit(child.id, "src/a.ts")).pipe(Effect.forkScoped)
        const [request] = yield* waitForPending(1)
        expect(request.alwaysScope).toBe("acceptEdits")
        yield* permission.reply({ requestID: request.id, reply: "always" })
        yield* Fiber.join(fiber)

        expect((yield* session.get(root.id)).permissionMode).toBe("acceptEdits")
        expect(yield* permission.mode(child.id)).toBe("acceptEdits")
        yield* silently(edit(root.id, "src/b.ts"))
        yield* silently(edit(child.id, "src/c.ts"))
        expect((yield* prompted(edit(other.id, "src/b.ts"))).alwaysScope).toBe("acceptEdits")

        const outside = yield* prompted({
          sessionID: root.id,
          permission: "edit",
          patterns: ["../outside.ts"],
          always: ["*"],
          metadata: { filepath: path.resolve(directory, "..", "outside.ts") },
        })
        expect(outside.alwaysScope).toBe("session")
      }),
    { git: true },
  )

  it.instance(
    "plan mode denies edits except the root session's plan file",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const root = yield* created({ permissionMode: "plan" })
        const child = yield* created({ parentID: root.id })
        const instance = yield* InstanceState.context
        const planFile = Session.plan(root, instance)

        const denied = yield* failure(
          ask({
            sessionID: child.id,
            permission: "edit",
            patterns: ["src/a.ts"],
            metadata: { filepath: path.join(directory, "src", "a.ts") },
            ruleset: [...defaults, { permission: "edit", pattern: "*", action: "allow" }],
          }),
        )
        expect(denied).toBeInstanceOf(PermissionV1.DeniedError)
        expect((denied as PermissionV1.DeniedError).message).toContain(planFile)

        yield* silently({
          sessionID: child.id,
          permission: "edit",
          patterns: [path.relative(directory, planFile)],
          metadata: { filepath: planFile },
        })
      }),
    { git: true },
  )

  it.instance(
    "dontAsk denies would-be asks immediately and keeps allows",
    () =>
      Effect.gen(function* () {
        const root = yield* created({ permissionMode: "dontAsk" })
        const denied = yield* failure(ask({ sessionID: root.id, permission: "bash", patterns: ["npm test"] }))
        expect(denied).toBeInstanceOf(PermissionV1.DeniedError)
        expect((denied as PermissionV1.DeniedError).message).toBe(DONT_ASK_REASON)
        yield* silently({
          sessionID: root.id,
          permission: "bash",
          patterns: ["npm test"],
          ruleset: [...defaults, { permission: "bash", pattern: "npm *", action: "allow" }],
        })
      }),
    { git: true },
  )

  it.instance(
    "setMode(acceptEdits) resolves a pending in-project edit once",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const permission = yield* Permission.Service
        const root = yield* created({})
        const seen = yield* replies
        const fiber = yield* ask({
          sessionID: root.id,
          permission: "edit",
          patterns: ["src/a.ts"],
          always: ["*"],
          metadata: { filepath: path.join(directory, "src", "a.ts") },
        }).pipe(Effect.forkScoped)
        const bash = yield* ask({ sessionID: root.id, permission: "bash", patterns: ["npm test"] }).pipe(
          Effect.forkScoped,
        )
        const pending = yield* waitForPending(2)
        const editRequest = pending.find((item) => item.permission === "edit")!

        yield* permission.setMode(root.id, "acceptEdits")
        yield* Fiber.join(fiber)
        expect(seen).toEqual([{ sessionID: root.id, requestID: editRequest.id, reply: "once" }])
        const left = yield* permission.list()
        expect(left.map((item) => item.permission)).toEqual(["bash"])

        yield* permission.reply({ requestID: left[0].id, reply: "reject" })
        yield* Fiber.await(bash)
      }),
    { git: true },
  )

  it.instance(
    "setMode(dontAsk) rejects pending asks with a DeniedError",
    () =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const root = yield* created({})
        const child = yield* created({ parentID: root.id })
        const seen = yield* replies
        const fiber = yield* ask({ sessionID: child.id, permission: "bash", patterns: ["npm test"] }).pipe(
          Effect.forkScoped,
        )
        const [request] = yield* waitForPending(1)

        yield* permission.setMode(root.id, "dontAsk")
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause)
          expect(error).toBeInstanceOf(PermissionV1.DeniedError)
          expect((error as PermissionV1.DeniedError).message).toBe(DONT_ASK_REASON)
        }
        expect(seen).toEqual([{ sessionID: child.id, requestID: request.id, reply: "reject" }])
        expect(yield* permission.list()).toHaveLength(0)
      }),
    { git: true },
  )

  it.instance(
    "a concurrent reply and recheck resolve a request exactly once",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const permission = yield* Permission.Service
        for (let round = 0; round < 5; round++) {
          const root = yield* created({})
          const seen = yield* replies
          const fiber = yield* ask({
            sessionID: root.id,
            permission: "edit",
            patterns: ["src/a.ts"],
            always: ["*"],
            metadata: { filepath: path.join(directory, "src", "a.ts") },
          }).pipe(Effect.forkScoped)
          const [request] = yield* waitForPending(1)

          const replyFirst = round % 2 === 0
          const reply = permission.reply({ requestID: request.id, reply: "once" }).pipe(Effect.exit)
          const recheck = permission.setMode(root.id, "acceptEdits")
          yield* Effect.all(replyFirst ? [reply, recheck] : [recheck, reply], { concurrency: "unbounded" })
          yield* Fiber.join(fiber)

          expect(seen.filter((item) => item.requestID === request.id)).toHaveLength(1)
          expect(yield* permission.list()).toHaveLength(0)
        }
      }),
    { git: true },
  )
})

// Workspace trust: an untrusted repository cannot keep a project-wide "Allow always", so the request says session.
const restricted = testEffect(
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
      [
        Config.node,
        TestConfig.layer({
          trust: () =>
            Effect.succeed({
              ...TestConfig.trusted,
              state: { ...TestConfig.trusted.state, status: "unknown", effective: "restricted" },
            }),
        }),
      ],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

describe("Permission service - workspace trust", () => {
  restricted.instance(
    "a restricted repository advertises session scope for a bash always and stores it for the session",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const permission = yield* Permission.Service
        const input = {
          sessionID: SessionID.make("ses_trust"),
          permission: "bash",
          patterns: ["git checkout main"],
          always: ["git checkout *"],
          hints: [{ pattern: "git checkout main", strict: "git checkout main", loose: "git checkout main" }],
        }
        const fiber = yield* ask(input).pipe(Effect.forkScoped)
        const [request] = yield* waitForPending(1)
        expect(request.alwaysScope).toBe("session")
        yield* permission.reply({ requestID: request.id, reply: "always" })
        yield* Fiber.join(fiber)
        expect(
          yield* Effect.promise(() =>
            fs.stat(path.join(directory, ".opencode", "settings.local.json")).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
        // The session approval answers the same command again without asking.
        yield* ask(input)
      }),
    { git: true },
  )
})
