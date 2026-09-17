import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { InstanceState } from "@/effect/instance-state"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import type { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer, reply } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in permission mode tests"),
    authenticate: () => Effect.die("unexpected MCP auth in permission mode tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in permission mode tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const promptRoot = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
])

const replacements = [
  [SessionSummary.node, summary],
  [LSP.node, lsp],
  [MCP.node, mcp],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true, client: "desktop" })],
] as const

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })
const it = testEffect(LayerNode.compile(LayerNode.group([promptRoot, testLLMServerNode]), replacements))
const noLLMServer = testEffect(LayerNode.compile(promptRoot, replacements))
const withFlags = (flags: Parameters<typeof RuntimeFlags.layer>[0]) =>
  testEffect(
    LayerNode.compile(LayerNode.group([promptRoot, testLLMServerNode]), [
      [SessionSummary.node, summary],
      [LSP.node, lsp],
      [MCP.node, mcp],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true, ...flags })],
    ]),
  )
// An ACP client: no question tool, so no plan_exit.
const acp = withFlags({ client: "acp" })
const background = withFlags({ client: "desktop", experimentalBackgroundSubagents: true })

// A custom "test" provider so model lookup succeeds inside the loop.
const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

const useServerConfig = Effect.fn("test.useServerConfig")(function* (extra: Partial<ConfigV1.Info> = {}) {
  const { directory } = yield* TestInstance
  const llm = yield* TestLLMServer
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(
    path.join(directory, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      ...cfg,
      provider: { test: { ...cfg.provider.test, options: { ...cfg.provider.test.options, baseURL: llm.url } } },
      ...extra,
    }),
  )
  return { llm }
})

const userMessages = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const messages = yield* sessions.messages({ sessionID })
    return messages.filter((msg) => msg.info.role === "user")
  })

const assistantOf = (result: SessionV1.WithParts) => {
  expect(result.info.role).toBe("assistant")
  return result.info as SessionV1.Assistant
}

const text = (message: SessionV1.WithParts) =>
  message.parts.flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))

it.instance(
  "permissionMode on a prompt runs the build agent as plan, and acceptEdits hands back to build",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const permission = yield* Permission.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* llm.text("here is the plan")
      const planned = assistantOf(
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model,
          permissionMode: "plan",
          parts: [{ type: "text", text: "plan the change" }],
        }),
      )
      expect(planned.agent).toBe("plan")
      expect(planned.permissionMode).toBe("plan")
      expect(yield* permission.mode(chat.id)).toBe("plan")
      // The user message keeps the agent the user picked; only the turn runs as plan.
      expect((yield* userMessages(chat.id)).at(-1)?.info.agent).toBe("build")

      yield* llm.text("implemented")
      const built = assistantOf(
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model,
          permissionMode: "acceptEdits",
          parts: [{ type: "text", text: "go" }],
        }),
      )
      expect(built.agent).toBe("build")
      expect(built.permissionMode).toBe("acceptEdits")
      expect((yield* sessions.get(chat.id)).permissionMode).toBe("acceptEdits")
      expect(yield* llm.hits).toHaveLength(2)
    }),
  30_000,
)

noLLMServer.instance(
  "clients without mode support switch plan mode through the plan agent",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const permission = yield* Permission.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const send = (input: { agent: string; permissionMode?: Permission.Mode }) =>
        prompt.prompt({
          sessionID: chat.id,
          model,
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
          ...input,
        })

      yield* send({ agent: "build", permissionMode: "acceptEdits" })
      expect(yield* permission.mode(chat.id)).toBe("acceptEdits")

      // Legacy: picking the plan agent turns plan mode on...
      yield* send({ agent: "plan" })
      expect(yield* permission.mode(chat.id)).toBe("plan")
      expect(yield* permission.prePlan(chat.id)).toBe("acceptEdits")
      // ...and going back to build restores the mode from before plan.
      yield* send({ agent: "build" })
      expect(yield* permission.mode(chat.id)).toBe("acceptEdits")
      // Another build prompt does not touch the mode again.
      yield* send({ agent: "build" })
      expect(yield* permission.mode(chat.id)).toBe("acceptEdits")

      // Desktop style: the build agent with an explicit plan mode, repeated, stays in plan.
      yield* send({ agent: "build", permissionMode: "plan" })
      expect(yield* permission.mode(chat.id)).toBe("plan")
      yield* send({ agent: "build", permissionMode: "plan" })
      expect(yield* permission.mode(chat.id)).toBe("plan")
      // A legacy build prompt after it does not leave plan: the previous user message was not on the plan agent.
      yield* send({ agent: "build" })
      expect(yield* permission.mode(chat.id)).toBe("plan")
    }),
  { config: cfg },
)

noLLMServer.instance(
  "a prompt without an agent enters plan mode when the default agent is plan, so subagents inherit it",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const permission = yield* Permission.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* prompt.prompt({ sessionID: chat.id, model, noReply: true, parts: [{ type: "text", text: "hello" }] })
      expect((yield* sessions.get(chat.id)).permissionMode).toBe("plan")
      const child = yield* sessions.create({ parentID: chat.id, agent: "general" })
      expect(yield* permission.mode(child.id)).toBe("plan")
    }),
  { config: { ...cfg, default_agent: "plan" } },
)

noLLMServer.instance(
  "a prompt without an agent leaves the mode alone when the default agent is not plan",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* prompt.prompt({ sessionID: chat.id, model, noReply: true, parts: [{ type: "text", text: "hello" }] })
      expect((yield* sessions.get(chat.id)).permissionMode).toBeUndefined()
    }),
  { config: cfg },
)

noLLMServer.instance(
  "a refused bypassPermissions reports a session error and keeps the previous mode",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const permission = yield* Permission.Service
      const events = yield* EventV2Bridge.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const errors: string[] = []
      const off = yield* events.listen((event) => {
        if (event.type !== Session.Event.Error.type) return Effect.void
        const data = event.data as typeof Session.Event.Error.data.Type
        if (data.sessionID === chat.id && data.error) errors.push(JSON.stringify(data.error))
        return Effect.void
      })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model,
        permissionMode: "acceptEdits",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      const result = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model,
        permissionMode: "bypassPermissions",
        noReply: true,
        parts: [{ type: "text", text: "hello again" }],
      })
      yield* off

      // The prompt itself still goes through, in the previous mode.
      expect(result.info.role).toBe("user")
      expect(yield* permission.mode(chat.id)).toBe("acceptEdits")
      expect((yield* sessions.get(chat.id)).permissionMode).toBe("acceptEdits")
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain("UnknownError")
      expect(errors[0]).toContain("bypassPermissions is disabled by configuration")
    }),
  { config: { ...cfg, disable_bypass_permissions: true } },
)

it.instance(
  "/plan turns plan mode on and asks what to plan when run without arguments",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const permission = yield* Permission.Service
      const commands = yield* Command.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      const plan = yield* commands.get("plan")
      expect(plan).toBeDefined()
      expect(Command.isBuiltinPlan(plan!)).toBe(true)
      expect(plan!.hints).toEqual(["$ARGUMENTS"])

      yield* llm.text("What would you like to plan?")
      const asked = assistantOf(
        yield* prompt.command({
          sessionID: chat.id,
          command: "plan",
          arguments: "  ",
          agent: "build",
          model: "test/test-model",
        }),
      )
      expect(yield* permission.mode(chat.id)).toBe("plan")
      expect(asked.agent).toBe("plan")
      expect(asked.permissionMode).toBe("plan")
      const first = (yield* userMessages(chat.id)).at(-1)!
      expect(text(first)).toEqual([Command.PLAN_BLANK_PROMPT])
      // The command keeps the caller's agent, so a later build prompt from a legacy client stays in plan mode.
      expect(first.info.agent).toBe("build")

      yield* llm.text("Planning the cache.")
      yield* prompt.command({
        sessionID: chat.id,
        command: "plan",
        arguments: "add a cache",
        agent: "build",
        model: "test/test-model",
      })
      expect(text((yield* userMessages(chat.id)).at(-1)!)).toEqual(["add a cache"])
      expect(yield* permission.mode(chat.id)).toBe("plan")
    }),
  30_000,
)

it.instance(
  "a user command named plan replaces the built-in and does not change the mode",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig({ command: { plan: { template: "My own plan: $ARGUMENTS" } } })
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const permission = yield* Permission.Service
      const commands = yield* Command.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      const plan = yield* commands.get("plan")
      expect(plan && Command.isBuiltinPlan(plan)).toBe(false)

      yield* llm.text("ok")
      const result = assistantOf(
        yield* prompt.command({
          sessionID: chat.id,
          command: "plan",
          arguments: "",
          agent: "build",
          model: "test/test-model",
        }),
      )
      expect(result.agent).toBe("build")
      expect(yield* permission.mode(chat.id)).toBe("default")
      expect(text((yield* userMessages(chat.id)).at(-1)!)).toEqual(["My own plan:"])
    }),
  30_000,
)

/** Polls until `check` returns a value, failing after `ms`. */
const until = <A, E, R>(check: Effect.Effect<A | undefined, E, R>, ms = 15_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms
    for (;;) {
      const value = yield* check
      if (value !== undefined) return value
      if (Date.now() > deadline) return yield* Effect.die(new Error("timed out waiting"))
      yield* Effect.sleep("25 millis")
    }
  })

it.instance(
  "a plan approved from the plan agent lets the build agent edit right away in acceptEdits",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig()
      const { directory } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const permission = yield* Permission.Service
      const question = yield* Question.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const planFile = Session.plan(chat, yield* InstanceState.context)
      const target = path.join(directory, "impl.txt")

      yield* llm.tool("write", { filePath: planFile, content: "# Write impl\n\n1. Write impl.txt\n" })
      yield* llm.tool("plan_exit", {})
      yield* llm.tool("write", { filePath: target, content: "done\n" })
      yield* llm.text("implemented")

      // A legacy client planning on the plan agent: the session's stored agent is plan until the plan is approved.
      const fiber = yield* prompt
        .prompt({ sessionID: chat.id, agent: "plan", model, parts: [{ type: "text", text: "plan it" }] })
        .pipe(Effect.forkScoped)
      const request = yield* until(question.list().pipe(Effect.map((items) => items[0])))
      yield* question.reply({ requestID: request.id, answers: [["Yes, and accept edits"]] })
      const done = yield* Fiber.await(fiber).pipe(
        Effect.timeoutOrElse({
          duration: "20 seconds",
          orElse: () =>
            Effect.gen(function* () {
              const pending = yield* permission.list()
              return yield* Effect.die(new Error(`turn did not finish; pending asks: ${JSON.stringify(pending)}`))
            }),
        }),
      )
      expect(done._tag).toBe("Success")

      // The edit after approval ran in acceptEdits: no prompt, no plan-mode deny.
      expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("done\n")
      expect(yield* permission.list()).toHaveLength(0)
      expect(yield* permission.mode(chat.id)).toBe("acceptEdits")
      expect((yield* sessions.get(chat.id)).agent).toBe("build")
      const assistants = (yield* sessions.messages({ sessionID: chat.id })).flatMap((msg) =>
        msg.info.role === "assistant" ? [msg.info] : [],
      )
      expect(assistants.at(-1)?.agent).toBe("build")
      expect(assistants.at(-1)?.permissionMode).toBe("acceptEdits")
    }),
  60_000,
)

it.instance(
  "a deny configured on the build agent still applies while build runs as plan",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig({
        agent: { build: { permission: { bash: { "touch *": "deny" } } } },
      })
      const { directory } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const permission = yield* Permission.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* llm.tool("bash", { command: "touch denied.txt", description: "Create a file" })
      yield* llm.text("done")
      let finished = false
      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model,
          permissionMode: "plan",
          parts: [{ type: "text", text: "plan" }],
        })
        .pipe(Effect.ensuring(Effect.sync(() => (finished = true))), Effect.forkScoped)
      // Without the build agent's deny the command would only ask (plan mode asks for commands that change things).
      const outcome = yield* until(
        Effect.gen(function* () {
          if ((yield* permission.list()).length > 0) return "asked" as const
          if (finished) return "finished" as const
          return undefined
        }),
      )
      if (outcome === "asked") {
        for (const item of yield* permission.list()) yield* permission.reply({ requestID: item.id, reply: "reject" })
      }
      yield* Fiber.await(fiber)
      expect(outcome).toBe("finished")

      const parts = (yield* sessions.messages({ sessionID: chat.id })).flatMap((msg) => msg.parts)
      const bash = parts.find((part) => part.type === "tool" && part.tool === "bash")
      expect(bash?.type === "tool" && bash.state.status).toBe("error")
      expect(
        yield* Effect.promise(() =>
          fs.stat(path.join(directory, "denied.txt")).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
    }),
  60_000,
)

acp.instance(
  "/plan in a client without plan_exit runs on the plan agent, so going back to build leaves plan mode",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const permission = yield* Permission.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* llm.text("Here is the plan.")
      const planned = assistantOf(
        yield* prompt.command({
          sessionID: chat.id,
          command: "plan",
          arguments: "add caching",
          agent: "build",
          model: "test/test-model",
        }),
      )
      expect(yield* permission.mode(chat.id)).toBe("plan")
      expect(planned.agent).toBe("plan")
      expect((yield* userMessages(chat.id)).at(-1)?.info.agent).toBe("plan")

      // The ACP mode is still build: the next prompt ends plan mode.
      yield* llm.text("implementing")
      const built = assistantOf(
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model,
          parts: [{ type: "text", text: "ok implement it" }],
        }),
      )
      expect(yield* permission.mode(chat.id)).toBe("default")
      expect(built.agent).toBe("build")
      expect(built.permissionMode).toBe("default")
    }),
  30_000,
)

noLLMServer.instance(
  "plan agent -> custom primary agent -> build still leaves plan mode for clients without mode support",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const permission = yield* Permission.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const send = (input: { agent: string; permissionMode?: Permission.Mode }) =>
        prompt.prompt({ sessionID: chat.id, model, noReply: true, parts: [{ type: "text", text: "hi" }], ...input })

      yield* send({ agent: "build", permissionMode: "acceptEdits" })
      yield* send({ agent: "plan" })
      expect(yield* permission.mode(chat.id)).toBe("plan")
      // A custom primary agent keeps plan mode...
      yield* send({ agent: "reviewer" })
      expect(yield* permission.mode(chat.id)).toBe("plan")
      // ...and build afterwards restores the mode from before plan.
      yield* send({ agent: "build" })
      expect(yield* permission.mode(chat.id)).toBe("acceptEdits")
    }),
  { config: { ...cfg, agent: { reviewer: { mode: "primary", description: "Reviews code" } } } },
)

noLLMServer.instance(
  "a request that fails before its user message is written leaves the mode alone",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const permission = yield* Permission.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      const failedPrompt = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "missing-agent",
          model,
          permissionMode: "plan",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)
      expect(failedPrompt._tag).toBe("Failure")
      expect(yield* permission.mode(chat.id)).toBe("default")
      expect((yield* sessions.get(chat.id)).permissionMode).toBeUndefined()

      const failedCommand = yield* prompt
        .command({
          sessionID: chat.id,
          command: "plan",
          arguments: "add caching",
          agent: "build",
          model: "test/no-such-model",
        })
        .pipe(Effect.exit)
      expect(failedCommand._tag).toBe("Failure")
      expect(yield* permission.mode(chat.id)).toBe("default")
      expect((yield* sessions.get(chat.id)).permissionMode).toBeUndefined()
      expect(yield* userMessages(chat.id)).toHaveLength(0)
    }),
  { config: cfg },
)

background.instance(
  "a background task result injected on a stale plan agent does not turn plan mode back on",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const permission = yield* Permission.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const has = (text: string) => (hit: { body: Record<string, unknown> }) => JSON.stringify(hit.body).includes(text)

      let release!: () => void
      const held = new Promise<void>((resolve) => (release = resolve))
      // Only the subagent's own request names the task without the parent's tool result.
      const child = (hit: { body: Record<string, unknown> }) =>
        has("CHILD-TASK")(hit) && !has("working in the background")(hit)
      yield* llm.pushMatch(child, reply().wait(held).text("child done").stop())
      yield* llm.push(
        reply().tool("task", {
          description: "Explore",
          prompt: "CHILD-TASK",
          subagent_type: "general",
          background: true,
        }),
      )
      yield* llm.textMatch(has("Background task completed"), "noted")
      yield* llm.textMatch(() => true, "started")

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model,
        permissionMode: "acceptEdits",
        parts: [{ type: "text", text: "go" }],
      })
      expect(yield* permission.mode(chat.id)).toBe("acceptEdits")
      // A stale stored agent, as a legacy plan-agent session had before plan_exit updated it.
      const info = yield* sessions.get(chat.id)
      yield* sessions.setAgentModel({
        sessionID: chat.id,
        agent: "plan",
        model: info.model ?? { id: model.modelID, providerID: model.providerID, variant: "default" },
        time: Date.now(),
      })

      release()
      yield* until(
        userMessages(chat.id).pipe(
          Effect.map((items) =>
            items.some((msg) =>
              msg.parts.some((part) => part.type === "text" && part.text.includes("Background task completed")),
            )
              ? true
              : undefined,
          ),
        ),
      )
      expect((yield* sessions.get(chat.id)).permissionMode).toBe("acceptEdits")
      expect(yield* permission.mode(chat.id)).toBe("acceptEdits")
    }),
  60_000,
)
