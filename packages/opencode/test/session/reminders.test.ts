import { afterEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { SessionReminders } from "@/session/reminders"
import { MessageID, type SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Session.node,
      FSUtil.node,
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
const agent = (name: string) => ({ name }) as Agent.Info

const FULL = "## Plan Workflow"
const SHORT = "Plan mode is still active"
const SWITCH = "Plan mode has ended"
const SUBAGENT = "you are running as a subagent"

const created = (input?: Parameters<Session.Interface["create"]>[0]) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    return yield* Effect.acquireRelease(session.create(input), (info) => session.remove(info.id).pipe(Effect.ignore))
  })

const user = Effect.fn("RemindersTest.user")(function* (sessionID: SessionID, agentName = "build") {
  const session = yield* Session.Service
  return yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: agentName,
    model: ref,
    time: { created: Date.now() },
  })
})

const assistant = Effect.fn("RemindersTest.assistant")(function* (
  parent: SessionV1.User,
  agentName: string,
  permissionMode?: PermissionV1.Mode,
) {
  const session = yield* Session.Service
  return yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    parentID: parent.id,
    sessionID: parent.sessionID,
    mode: agentName,
    agent: agentName,
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(permissionMode ? { permissionMode } : {}),
  } satisfies SessionV1.Assistant)
})

/** Loads the messages as the prompt loop does and applies the reminders for one step. */
const step = Effect.fn("RemindersTest.step")(function* (
  info: Session.Info,
  input: { agent: string; mode?: PermissionV1.Mode; planExitAvailable?: boolean },
) {
  const session = yield* Session.Service
  const messages = yield* session.messages({ sessionID: info.id })
  return yield* SessionReminders.apply({
    messages,
    agent: agent(input.agent),
    session: info,
    mode: input.mode,
    planExitAvailable: input.planExitAvailable,
  })
})

const texts = (message: SessionV1.WithParts | undefined) =>
  (message?.parts ?? []).flatMap((part) => (part.type === "text" ? [part.text] : []))

const lastUser = (messages: SessionV1.WithParts[]) => messages.findLast((item) => item.info.role === "user")

const stored = Effect.fn("RemindersTest.stored")(function* (sessionID: SessionID) {
  const session = yield* Session.Service
  return lastUser(yield* session.messages({ sessionID }))
})

describe("SessionReminders.apply", () => {
  it.instance(
    "the first plan turn persists the full reminder once, and a second loop step adds nothing",
    () =>
      Effect.gen(function* () {
        const root = yield* created({})
        const first = yield* user(root.id)
        const plan = Session.plan(root, yield* InstanceState.context)

        const result = yield* step(root, { agent: "build", mode: "plan" })
        const reminder = texts(lastUser(result)).filter((text) => text.includes(FULL))
        expect(reminder).toHaveLength(1)
        expect(reminder[0]).toContain(`create your plan at ${plan}`)
        expect(reminder[0]).toContain("call plan_exit")
        expect(reminder[0]).not.toContain("${")
        expect(texts(yield* stored(root.id)).filter((text) => text.includes(FULL))).toHaveLength(1)
        expect(yield* Effect.promise(() => fs.stat(path.dirname(plan)).then((stat) => stat.isDirectory()))).toBe(true)

        // Second step of the same turn: the plan assistant from step one now follows the user message.
        yield* assistant(first, "build", "plan")
        const again = yield* step(root, { agent: "build", mode: "plan" })
        const later = texts(lastUser(again))
        expect(later.filter((text) => text.includes(FULL))).toHaveLength(1)
        expect(later.filter((text) => text.includes(SHORT))).toHaveLength(0)
        expect(texts(yield* stored(root.id)).filter((text) => text.includes(FULL))).toHaveLength(1)
      }),
    { git: true },
  )

  it.instance(
    "a later plan turn gets the short reminder in memory only",
    () =>
      Effect.gen(function* () {
        const root = yield* created({})
        const first = yield* user(root.id)
        yield* step(root, { agent: "build", mode: "plan" })
        yield* assistant(first, "build", "plan")
        yield* user(root.id)
        const plan = Session.plan(root, yield* InstanceState.context)

        const result = yield* step(root, { agent: "build", mode: "plan" })
        const current = texts(lastUser(result))
        expect(current.filter((text) => text.includes(FULL))).toHaveLength(0)
        const short = current.filter((text) => text.includes(SHORT))
        expect(short).toHaveLength(1)
        expect(short[0]).toContain(plan)
        expect(short[0]).toContain("call plan_exit")
        expect(short[0]).not.toContain("${")
        expect(texts(yield* stored(root.id))).toHaveLength(0)
      }),
    { git: true },
  )

  it.instance(
    "the plan agent counts as a previous plan turn without a stored mode",
    () =>
      Effect.gen(function* () {
        const root = yield* created({})
        const first = yield* user(root.id, "plan")
        yield* assistant(first, "plan")
        yield* user(root.id, "plan")
        // No mode passed: derived from the plan agent.
        const result = yield* step(root, { agent: "plan" })
        expect(texts(lastUser(result)).filter((text) => text.includes(SHORT))).toHaveLength(1)
      }),
    { git: true },
  )

  it.instance(
    "the first build turn after plan persists the build switch with the plan path",
    () =>
      Effect.gen(function* () {
        const root = yield* created({})
        const first = yield* user(root.id)
        yield* assistant(first, "build", "plan")
        const next = yield* user(root.id)
        const plan = Session.plan(root, yield* InstanceState.context)
        yield* Effect.promise(async () => {
          await fs.mkdir(path.dirname(plan), { recursive: true })
          await fs.writeFile(plan, "# Plan\n")
        })

        const result = yield* step(root, { agent: "build", mode: "acceptEdits" })
        const switched = texts(lastUser(result)).filter((text) => text.includes(SWITCH))
        expect(switched).toHaveLength(1)
        expect(switched[0]).toContain(`A plan file exists at ${plan}. Implement it.`)
        expect(texts(yield* stored(root.id)).filter((text) => text.includes(SWITCH))).toHaveLength(1)

        // Next loop step: the build assistant follows, so nothing is added again.
        yield* assistant(next, "build", "acceptEdits")
        const again = yield* step(root, { agent: "build", mode: "acceptEdits" })
        expect(texts(lastUser(again)).filter((text) => text.includes(SWITCH))).toHaveLength(1)
        expect(texts(yield* stored(root.id)).filter((text) => text.includes(SWITCH))).toHaveLength(1)
      }),
    { git: true },
  )

  it.instance(
    "the build switch omits the plan pointer when no plan file exists",
    () =>
      Effect.gen(function* () {
        const root = yield* created({})
        const first = yield* user(root.id)
        yield* assistant(first, "plan")
        yield* user(root.id)
        const result = yield* step(root, { agent: "build" })
        const switched = texts(lastUser(result)).filter((text) => text.includes(SWITCH))
        expect(switched).toHaveLength(1)
        expect(switched[0]).not.toContain("A plan file exists")
      }),
    { git: true },
  )

  it.instance(
    "without plan_exit the reminders tell the model to present the plan in its reply",
    () =>
      Effect.gen(function* () {
        const root = yield* created({})
        const first = yield* user(root.id)
        const full = texts(lastUser(yield* step(root, { agent: "build", mode: "plan", planExitAvailable: false })))
        expect(full.some((text) => text.includes(FULL) && text.includes("present the final plan in your reply"))).toBe(
          true,
        )
        expect(full.some((text) => text.includes("call plan_exit"))).toBe(false)

        yield* assistant(first, "build", "plan")
        yield* user(root.id)
        const short = texts(lastUser(yield* step(root, { agent: "build", mode: "plan", planExitAvailable: false })))
        expect(
          short.some((text) => text.includes(SHORT) && text.includes("present the final plan in your reply")),
        ).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "a subagent in plan mode gets its own read-only reminder, never the plan file, plan_exit or question guidance",
    () =>
      Effect.gen(function* () {
        const root = yield* created({})
        const child = yield* created({ parentID: root.id })
        yield* user(child.id, "general")
        const plan = Session.plan(root, yield* InstanceState.context)

        const result = yield* step(child, { agent: "general", mode: "plan", planExitAvailable: false })
        const current = texts(lastUser(result))
        expect(current.filter((text) => text.includes(FULL))).toHaveLength(0)
        expect(current.filter((text) => text.includes(SHORT))).toHaveLength(0)
        const reminder = current.filter((text) => text.includes(SUBAGENT))
        expect(reminder).toHaveLength(1)
        // Subagents cannot edit (the plan file included), ask the user or call plan_exit.
        expect(reminder[0]).toContain("the plan file included")
        expect(reminder[0]).not.toContain(plan)
        expect(reminder[0]).not.toContain("plan_exit")
        expect(reminder[0]).not.toContain("present the final plan")
        expect(reminder[0]).not.toContain("${")
        expect(texts(yield* stored(child.id))).toHaveLength(0)
      }),
    { git: true },
  )

  it.instance(
    "a subagent resumed after the plan was approved gets the build switch without the plan pointer",
    () =>
      Effect.gen(function* () {
        const root = yield* created({})
        const child = yield* created({ parentID: root.id })
        const first = yield* user(child.id, "general")
        yield* assistant(first, "general", "plan")
        yield* user(child.id, "general")
        const plan = Session.plan(root, yield* InstanceState.context)
        yield* Effect.promise(async () => {
          await fs.mkdir(path.dirname(plan), { recursive: true })
          await fs.writeFile(plan, "# Plan\n")
        })

        const result = yield* step(child, { agent: "general", mode: "acceptEdits" })
        const switched = texts(lastUser(result)).filter((text) => text.includes(SWITCH))
        expect(switched).toHaveLength(1)
        expect(switched[0]).not.toContain("A plan file exists")
        expect(switched[0]).not.toContain(plan)
      }),
    { git: true },
  )

  it.instance(
    "switching modes back and forth within one turn always leaves the latest mode's reminder last",
    () =>
      Effect.gen(function* () {
        const root = yield* created({})
        const first = yield* user(root.id)
        const kinds = (message: SessionV1.WithParts | undefined) =>
          texts(message).flatMap((text) =>
            text.includes(FULL) ? ["full"] : text.includes(SHORT) ? ["short"] : text.includes(SWITCH) ? ["switch"] : [],
          )

        // Step 1 in plan: the full reminder is persisted.
        expect(kinds(lastUser(yield* step(root, { agent: "build", mode: "plan" })))).toEqual(["full"])
        yield* assistant(first, "build", "plan")
        // Step 2 after Shift+Tab to default: the build switch is persisted after it.
        expect(kinds(lastUser(yield* step(root, { agent: "build", mode: "default" })))).toEqual(["full", "switch"])
        yield* assistant(first, "build", "default")
        // Step 3 back in plan: the short reminder follows the build switch (in memory), so plan mode is what counts.
        expect(kinds(lastUser(yield* step(root, { agent: "build", mode: "plan" })))).toEqual([
          "full",
          "switch",
          "short",
        ])
        expect(kinds(yield* stored(root.id))).toEqual(["full", "switch"])
        yield* assistant(first, "build", "plan")
        // Step 4 still in plan: the short reminder stays last and nothing more is persisted.
        expect(kinds(lastUser(yield* step(root, { agent: "build", mode: "plan" })))).toEqual([
          "full",
          "switch",
          "short",
        ])
        yield* assistant(first, "build", "plan")
        // Step 5 in default again: the latest persisted reminder is already the build switch, and it is last.
        expect(kinds(lastUser(yield* step(root, { agent: "build", mode: "default" })))).toEqual(["full", "switch"])
        expect(kinds(yield* stored(root.id))).toEqual(["full", "switch"])
      }),
    { git: true },
  )

  it.instance(
    "outside plan mode and without a previous plan turn nothing is added",
    () =>
      Effect.gen(function* () {
        const root = yield* created({})
        const first = yield* user(root.id)
        yield* assistant(first, "build", "acceptEdits")
        yield* user(root.id)
        const result = yield* step(root, { agent: "build", mode: "acceptEdits" })
        expect(texts(lastUser(result))).toHaveLength(0)
      }),
    { git: true },
  )

  it.instance(
    "OPENCODE_EXPERIMENTAL_PLAN_MODE no longer changes the reminders",
    () =>
      Effect.gen(function* () {
        const run = (experimentalPlanMode: boolean) =>
          Effect.gen(function* () {
            const root = yield* created({})
            yield* user(root.id, "plan")
            const plan = Session.plan(root, yield* InstanceState.context)
            const result = yield* step(root, { agent: "plan" }).pipe(
              Effect.provide(RuntimeFlags.layer({ experimentalPlanMode })),
            )
            return {
              visible: texts(lastUser(result)).map((text) => text.replaceAll(plan, "<plan>")),
              persisted: texts(yield* stored(root.id)).map((text) => text.replaceAll(plan, "<plan>")),
            }
          })

        const previous = process.env.OPENCODE_EXPERIMENTAL_PLAN_MODE
        process.env.OPENCODE_EXPERIMENTAL_PLAN_MODE = "true"
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_PLAN_MODE
            else process.env.OPENCODE_EXPERIMENTAL_PLAN_MODE = previous
          }),
        )
        const enabled = yield* run(true)
        const disabled = yield* run(false)
        expect(enabled).toEqual(disabled)
        expect(enabled.persisted).toHaveLength(1)
        expect(enabled.persisted[0]).toContain(FULL)
      }),
    { git: true },
  )
})
