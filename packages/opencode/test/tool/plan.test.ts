import { afterEach, describe, expect, spyOn } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit, Fiber, Layer, Queue } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { Session } from "@/session/session"
import { MessageID, type SessionID } from "@/session/schema"
import { Truncate } from "@/tool/truncate"
import { Choice, PlanExitTool, planTitle } from "../../src/tool/plan"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Session.node,
      Question.node,
      Agent.node,
      Permission.node,
      Provider.node,
      FSUtil.node,
      Truncate.node,
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

afterEach(async () => {
  await disposeAllInstances()
})

const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
const PLAN = "# Add login\n\n1. Add a login form\n2. Store the session cookie\n"

const created = (input?: Parameters<Session.Interface["create"]>[0]) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    return yield* Effect.acquireRelease(session.create(input), (info) => session.remove(info.id).pipe(Effect.ignore))
  })

const userMessage = Effect.fn("PlanExitTest.userMessage")(function* (sessionID: SessionID, agent = "build") {
  const session = yield* Session.Service
  return yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent,
    model: ref,
    time: { created: Date.now() },
  })
})

const writePlan = Effect.fn("PlanExitTest.writePlan")(function* (root: Session.Info, text = PLAN) {
  const file = Session.plan(root, yield* InstanceState.context)
  yield* Effect.promise(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text)
  })
  return file
})

/** A root session in plan mode with a build user message and a written plan. */
const planning = Effect.fn("PlanExitTest.planning")(function* (options?: { before?: Permission.Mode; agent?: string }) {
  const permission = yield* Permission.Service
  const root = yield* created({})
  yield* userMessage(root.id, options?.agent)
  if (options?.before) yield* permission.setMode(root.id, options.before)
  yield* permission.setMode(root.id, "plan")
  yield* writePlan(root)
  return root
})

function context(sessionID: SessionID) {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    callID: "call_plan_exit",
    agent: "plan",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

const pendingQuestion = Effect.fn("PlanExitTest.pendingQuestion")(function* () {
  const question = yield* Question.Service
  const events = yield* EventV2Bridge.Service
  const asked = yield* Queue.unbounded<void>()
  const off = yield* events.listen((event) => {
    if (event.type === Question.Event.Asked.type) Queue.offerUnsafe(asked, undefined)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)
  for (;;) {
    const item = (yield* question.list())[0]
    if (item) return item
    yield* Queue.take(asked).pipe(Effect.timeout("5 seconds"))
  }
})

/** Runs plan_exit for a session and answers its question with `answer`. */
const exitWith = Effect.fn("PlanExitTest.exitWith")(function* (sessionID: SessionID, answer: string) {
  const question = yield* Question.Service
  const tool = yield* (yield* PlanExitTool).init()
  const fiber = yield* tool.execute({}, context(sessionID)).pipe(Effect.forkScoped)
  const request = yield* pendingQuestion()
  yield* question.reply({ requestID: request.id, answers: [[answer]] })
  return { request, exit: yield* Fiber.await(fiber) }
})

const count = (sessionID: SessionID) =>
  Session.Service.use((session) => session.messages({ sessionID })).pipe(Effect.map((items) => items.length))

describe("plan_exit", () => {
  it.instance("fails with the plan path when no plan was written, without asking", () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const question = yield* Question.Service
      const events = yield* EventV2Bridge.Service
      const root = yield* created({})
      yield* userMessage(root.id)
      yield* permission.setMode(root.id, "plan")
      let asked = 0
      const off = yield* events.listen((event) => {
        if (event.type === Question.Event.Asked.type) asked++
        return Effect.void
      })
      yield* Effect.addFinalizer(() => off)

      const tool = yield* (yield* PlanExitTool).init()
      const exit = yield* tool.execute({}, context(root.id)).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      const planPath = Session.plan(root, yield* InstanceState.context)
      if (Exit.isFailure(exit)) {
        const message = String((Cause.squash(exit.cause) as Error).message)
        expect(message).toContain("No plan found at")
        expect(message).toContain(path.basename(planPath))
      }
      expect(asked).toBe(0)
      expect(yield* question.list()).toHaveLength(0)
      expect(yield* permission.mode(root.id)).toBe("plan")
    }),
  )

  it.instance("a blank plan file counts as missing", () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const root = yield* created({})
      yield* permission.setMode(root.id, "plan")
      yield* writePlan(root, "  \n\n")
      const tool = yield* (yield* PlanExitTool).init()
      const exit = yield* tool.execute({}, context(root.id)).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("No plan found at")
    }),
  )

  it.instance(
    "'Yes, and accept edits' switches the root to acceptEdits and hands off from the plan agent to build on its configured model",
    () =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const session = yield* Session.Service
        const root = yield* planning({ agent: "plan" })
        expect(Session.isDefaultTitle(root.title)).toBe(true)

        const { request, exit } = yield* exitWith(root.id, Choice.acceptEdits)
        expect(request.questions[0].header).toBe("Plan ready")
        expect(request.questions[0].custom).toBe(true)
        expect(request.questions[0].options.map((item) => item.label)).toEqual([
          Choice.acceptEdits,
          Choice.manual,
          Choice.keepPlanning,
        ])
        expect(Exit.isSuccess(exit)).toBe(true)
        if (!Exit.isSuccess(exit)) return
        expect(exit.value.metadata.approved).toBe(true)
        expect(exit.value.metadata.mode).toBe("acceptEdits")
        expect(exit.value.metadata.agent).toBe("build")
        expect(exit.value.output).toContain("The build agent will implement it in acceptEdits mode")

        expect(yield* permission.mode(root.id)).toBe("acceptEdits")
        expect((yield* session.get(root.id)).permissionMode).toBe("acceptEdits")

        const messages = yield* session.messages({ sessionID: root.id })
        const handoff = messages.at(-1)
        expect(handoff?.info.role).toBe("user")
        if (handoff?.info.role !== "user") return
        expect(handoff.info.agent).toBe("build")
        expect(String(handoff.info.model.providerID)).toBe("test")
        expect(String(handoff.info.model.modelID)).toBe("build-model")
        const text = handoff.parts.find((part) => part.type === "text")
        expect(text?.type === "text" && text.synthetic).toBe(true)
        expect(text?.type === "text" ? text.text : "").toContain("permission mode: acceptEdits")
        expect(text?.type === "text" ? text.text : "").toContain(PLAN.trim())

        expect((yield* session.get(root.id)).title).toBe("Add login")
        // The session itself moves off the plan agent, so background results and clients resume on build.
        const stored = yield* session.get(root.id)
        expect(stored.agent).toBe("build")
        expect(String(stored.model?.id)).toBe("build-model")
      }),
    { git: true, config: { agent: { build: { model: "test/build-model" } } } },
  )

  it.instance(
    "planning on build in plan mode keeps the model the user picked, even when build has a configured model",
    () =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const root = yield* planning()
        const { exit } = yield* exitWith(root.id, Choice.acceptEdits)
        expect(Exit.isSuccess(exit)).toBe(true)
        const handoff = (yield* session.messages({ sessionID: root.id })).at(-1)
        expect(handoff?.info.role === "user" && handoff.info.agent).toBe("build")
        expect(handoff?.info.role === "user" && String(handoff.info.model.modelID)).toBe("test-model")
        expect(String((yield* session.get(root.id)).model?.id)).toBe("test-model")
      }),
    { git: true, config: { agent: { build: { model: "test/build-model" } } } },
  )

  it.instance(
    "'Yes, manually approve edits' switches to default; a plan-agent user hands off to the default agent",
    () =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const session = yield* Session.Service
        const root = yield* planning({ before: "acceptEdits", agent: "plan" })
        yield* session.setTitle({ sessionID: root.id, title: "Custom title" })

        const { exit } = yield* exitWith(root.id, Choice.manual)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) expect(exit.value.metadata.mode).toBe("default")
        expect(yield* permission.mode(root.id)).toBe("default")

        const handoff = (yield* session.messages({ sessionID: root.id })).at(-1)
        expect(handoff?.info.role === "user" && handoff.info.agent).toBe("build")
        // No configured build model: the last user's model is reused.
        expect(handoff?.info.role === "user" && String(handoff.info.model.modelID)).toBe("test-model")
        expect((yield* session.get(root.id)).title).toBe("Custom title")
      }),
    { git: true },
  )

  it.instance(
    "'No, keep planning' rejects and stays in plan mode",
    () =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const root = yield* planning()
        const before = yield* count(root.id)

        const { exit } = yield* exitWith(root.id, Choice.keepPlanning)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Question.RejectedError)
        expect(yield* permission.mode(root.id)).toBe("plan")
        expect(yield* count(root.id)).toBe(before)
      }),
    { git: true },
  )

  it.instance(
    "a typed answer is feedback: planning continues and nothing is handed off",
    () =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const root = yield* planning()
        const before = yield* count(root.id)

        const { exit } = yield* exitWith(root.id, "use sqlite instead")
        expect(Exit.isSuccess(exit)).toBe(true)
        if (!Exit.isSuccess(exit)) return
        expect(exit.value.metadata.approved).toBe(false)
        expect(exit.value.metadata.feedback).toBe("use sqlite instead")
        expect(exit.value.output).toContain("use sqlite instead")
        expect(exit.value.output).toContain("call plan_exit again")
        expect(yield* permission.mode(root.id)).toBe("plan")
        expect(yield* count(root.id)).toBe(before)
      }),
    { git: true },
  )

  it.instance(
    "typing the bypass label never approves when bypass was not offered",
    () =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const root = yield* planning()
        const { exit } = yield* exitWith(root.id, Choice.bypass)
        expect(Exit.isSuccess(exit) && exit.value.metadata.approved).toBe(false)
        expect(yield* permission.mode(root.id)).toBe("plan")
      }),
    { git: true },
  )

  it.instance(
    "offers bypass only when plan mode was entered from bypassPermissions",
    () =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const uid = spyOn(process, "getuid").mockReturnValue(501)
        yield* Effect.addFinalizer(() => Effect.sync(() => uid.mockRestore()))
        const root = yield* planning({ before: "bypassPermissions" })
        expect(yield* permission.prePlan(root.id)).toBe("bypassPermissions")

        const { request, exit } = yield* exitWith(root.id, Choice.bypass)
        expect(request.questions[0].options.map((item) => item.label)).toEqual([
          Choice.bypass,
          Choice.acceptEdits,
          Choice.manual,
          Choice.keepPlanning,
        ])
        expect(Exit.isSuccess(exit) && exit.value.metadata.mode).toBe("bypassPermissions")
        expect(yield* permission.mode(root.id)).toBe("bypassPermissions")
      }),
    { git: true },
  )

  it.instance(
    "offers bypass after a restart lost the in-memory mode from before plan, reading it from the last turn",
    () =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const session = yield* Session.Service
        const uid = spyOn(process, "getuid").mockReturnValue(501)
        yield* Effect.addFinalizer(() => Effect.sync(() => uid.mockRestore()))
        const root = yield* created({})
        const user = yield* userMessage(root.id)
        yield* session.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: user.id,
          sessionID: root.id,
          mode: "build",
          agent: "build",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now() },
          permissionMode: "bypassPermissions",
        })
        // A stored plan mode without the in-memory record, as after an app restart.
        yield* session.setPermissionMode({ sessionID: root.id, mode: "plan" })
        yield* writePlan(root)
        expect(yield* permission.prePlan(root.id)).toBeUndefined()

        const { request, exit } = yield* exitWith(root.id, Choice.bypass)
        expect(request.questions[0].options.map((item) => item.label)[0]).toBe(Choice.bypass)
        expect(Exit.isSuccess(exit) && exit.value.metadata.mode).toBe("bypassPermissions")
        expect(yield* permission.mode(root.id)).toBe("bypassPermissions")
      }),
    { git: true },
  )

  it.instance(
    "called from a child session sets the mode on the root",
    () =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const session = yield* Session.Service
        const root = yield* planning()
        const child = yield* created({ parentID: root.id })

        const { request, exit } = yield* exitWith(child.id, Choice.manual)
        expect(request.sessionID).toBe(child.id)
        expect(Exit.isSuccess(exit)).toBe(true)
        expect((yield* session.get(root.id)).permissionMode).toBe("default")
        expect((yield* session.get(child.id)).permissionMode).toBeUndefined()
        expect(yield* permission.mode(root.id)).toBe("default")
        expect(yield* permission.mode(child.id)).toBe("default")
      }),
    { git: true },
  )

  it.instance(
    "refuses to run outside plan mode",
    () =>
      Effect.gen(function* () {
        const root = yield* created({})
        yield* writePlan(root)
        const tool = yield* (yield* PlanExitTool).init()
        const exit = yield* tool.execute({}, { ...context(root.id), agent: "build" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("only available in plan mode")
      }),
    { git: true },
  )
})

describe("planTitle", () => {
  it.effect("uses the first heading, else the first non-empty line, capped at 80 characters", () =>
    Effect.sync(() => {
      expect(planTitle("intro\n# Add login\n## Steps")).toBe("Add login")
      expect(planTitle("\n\n## Refactor the parser\ntext")).toBe("Refactor the parser")
      expect(planTitle("x".repeat(100))).toHaveLength(80)
      expect(planTitle("  \n")).toBe("")
    }),
  )
})
