import { afterEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { LSP } from "@/lsp/lsp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { modeRules } from "@/session/tools"
import { ApplyPatchTool } from "@/tool/apply_patch"
import { EditTool } from "@/tool/edit"
import type * as Tool from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { WriteTool } from "@/tool/write"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
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
      FSUtil.node,
      Plugin.node,
      Truncate.node,
      Agent.node,
      Config.node,
      RuntimeFlags.node,
      LSP.node,
      Format.node,
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

afterEach(async () => {
  await disposeAllInstances()
})

const PLAN_DENIED = "Plan mode is active"

/**
 * Runs a tool with a context wired to the real permission service the way session/tools.ts wires it. Every ask the
 * tool makes is recorded, and a background responder answers each prompt that reaches the user with "once" and records
 * it, so a test sees both what the tool asked and which of those asks actually prompted.
 */
const runTool = Effect.fn("PlanEditGuardTest.runTool")(function* <P>(
  tool: { execute(args: P, ctx: Tool.Context): Effect.Effect<unknown> },
  args: P,
  input: { session: Session.Info; agent: string },
) {
  const permission = yield* Permission.Service
  const agent = yield* (yield* Agent.Service).get(input.agent)
  const mode = yield* permission.mode(input.session.id, input.agent)
  const ruleset = Permission.merge(agent.permission, [
    ...(input.session.permission ?? []),
    ...modeRules({ mode, child: false }),
  ])
  const asked: string[] = []
  const prompted: string[] = []

  yield* Effect.gen(function* () {
    for (;;) {
      for (const item of yield* permission.list()) {
        if (item.sessionID !== input.session.id) continue
        prompted.push(item.permission)
        yield* permission.reply({ requestID: item.id, reply: "once" }).pipe(Effect.ignore)
      }
      yield* Effect.sleep("5 millis")
    }
  }).pipe(Effect.forkScoped)

  const ctx: Tool.Context = {
    sessionID: input.session.id,
    messageID: MessageID.ascending(),
    callID: "call_plan_edit_guard",
    agent: input.agent,
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (request) =>
      Effect.suspend(() => {
        asked.push(request.permission)
        return permission
          .ask({ ...request, sessionID: input.session.id, agent: input.agent, ruleset })
          .pipe(Effect.orDie)
      }),
  }
  const exit = yield* tool.execute(args, ctx).pipe(Effect.exit)
  return { exit, asked, prompted }
})

const failure = (exit: Exit.Exit<unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  return Exit.isFailure(exit) ? String((Cause.squash(exit.cause) as Error)?.message ?? Cause.squash(exit.cause)) : ""
}

const created = Effect.fn("PlanEditGuardTest.created")(function* (mode?: Permission.Mode) {
  const sessions = yield* Session.Service
  const permission = yield* Permission.Service
  const session = yield* Effect.acquireRelease(sessions.create({}), (info) =>
    sessions.remove(info.id).pipe(Effect.ignore),
  )
  if (mode) yield* permission.setMode(session.id, mode)
  return session
})

const exists = (file: string) =>
  Effect.promise(() =>
    fs.stat(file).then(
      () => true,
      () => false,
    ),
  )
const read = (file: string) => Effect.promise(() => fs.readFile(file, "utf8"))

describe("tool.plan-edit-guard", () => {
  it.instance(
    "plan mode denies write, edit and apply_patch outside the project before any external_directory prompt",
    () =>
      Effect.gen(function* () {
        const outside = yield* tmpdirScoped()
        const existing = path.join(outside, "existing.txt")
        yield* Effect.promise(() => fs.writeFile(existing, "old\n"))
        const session = yield* created("plan")

        const write = yield* (yield* WriteTool).init()
        const written = yield* runTool(
          write,
          { filePath: path.join(outside, "new.txt"), content: "hi\n" },
          { session, agent: "build" },
        )
        expect(failure(written.exit)).toContain(PLAN_DENIED)
        expect(written.asked).toEqual(["edit"])
        expect(written.prompted).toEqual([])
        expect(yield* exists(path.join(outside, "new.txt"))).toBe(false)

        const edit = yield* (yield* EditTool).init()
        const edited = yield* runTool(
          edit,
          { filePath: existing, oldString: "old", newString: "new" },
          { session, agent: "build" },
        )
        expect(failure(edited.exit)).toContain(PLAN_DENIED)
        expect(edited.asked).toEqual(["edit"])
        expect(edited.prompted).toEqual([])
        expect(yield* read(existing)).toBe("old\n")

        const patch = yield* (yield* ApplyPatchTool).init()
        const patched = yield* runTool(
          patch,
          { patchText: `*** Begin Patch\n*** Add File: ${path.join(outside, "patched.txt")}\n+hi\n*** End Patch` },
          { session, agent: "build" },
        )
        expect(failure(patched.exit)).toContain(PLAN_DENIED)
        expect(patched.asked).toEqual(["edit"])
        expect(patched.prompted).toEqual([])
        expect(yield* exists(path.join(outside, "patched.txt"))).toBe(false)
        expect(yield* (yield* Permission.Service).list()).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "the plan agent and a move out of the project are denied up front too",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* InstanceState.context
        const outside = yield* tmpdirScoped()
        const source = path.join(directory, "inside.txt")
        yield* Effect.promise(() => fs.writeFile(source, "old content\n"))
        const session = yield* created()

        const patch = yield* (yield* ApplyPatchTool).init()
        const moved = yield* runTool(
          patch,
          {
            patchText: `*** Begin Patch\n*** Update File: inside.txt\n*** Move to: ${path.join(outside, "moved.txt")}\n@@\n-old content\n+new content\n*** End Patch`,
          },
          { session, agent: "plan" },
        )
        expect(failure(moved.exit)).toContain(PLAN_DENIED)
        expect(moved.asked).toEqual(["edit"])
        expect(moved.prompted).toEqual([])
        expect(yield* read(source)).toBe("old content\n")
        expect(yield* exists(path.join(outside, "moved.txt"))).toBe(false)
      }),
    { git: true },
  )

  it.instance("plan mode still writes a plan file that lives outside the project", () =>
    Effect.gen(function* () {
      const session = yield* created("plan")
      const plan = Session.plan(session, yield* InstanceState.context)
      const write = yield* (yield* WriteTool).init()
      const result = yield* runTool(write, { filePath: plan, content: "# Plan\n" }, { session, agent: "plan" })
      expect(Exit.isSuccess(result.exit)).toBe(true)
      expect(result.asked).toEqual(["edit", "external_directory", "edit"])
      expect(result.prompted).toEqual([])
      expect(yield* read(plan)).toBe("# Plan\n")
    }),
  )

  it.instance(
    "default mode keeps the external_directory prompt before the edit prompt",
    () =>
      Effect.gen(function* () {
        const outside = yield* tmpdirScoped()
        const target = path.join(outside, "new.txt")
        const session = yield* created()
        const write = yield* (yield* WriteTool).init()
        const result = yield* runTool(write, { filePath: target, content: "hi\n" }, { session, agent: "build" })
        expect(Exit.isSuccess(result.exit)).toBe(true)
        expect(result.asked).toEqual(["external_directory", "edit"])
        expect(result.prompted).toEqual(["external_directory", "edit"])
        expect(yield* read(target)).toBe("hi\n")
      }),
    { git: true },
  )
})
