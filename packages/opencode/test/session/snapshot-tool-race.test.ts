/**
 * Reproducer for snapshot race condition with instant tool execution.
 *
 * When the mock LLM returns a tool call response instantly, the AI SDK
 * processes the tool call and executes the tool (e.g. apply_patch) before
 * the processor's start-step handler can capture a pre-tool snapshot.
 * Both the "before" and "after" snapshots end up with the same git tree
 * hash, so computeDiff returns empty and the session summary shows 0 files.
 *
 * This is a real bug: the snapshot system assumes it can capture state
 * before tools run by hooking into start-step, but the AI SDK executes
 * tools internally during multi-step processing before emitting events.
 */
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import type * as Scope from "effect/Scope"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import fs from "fs/promises"
import path from "path"
import { Session } from "@/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionSummary } from "../../src/session/summary"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { provideInstance, provideTmpdirServer, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

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
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
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

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  SessionSummary.node,
  Database.node,
  CrossSpawnSpawner.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])
const it = testEffect(
  LayerNode.compile(root, [
    [MCP.node, mcp],
    [LSP.node, lsp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ]),
)

// Pin the custom test provider so the loop never falls back to a real default model over the network.
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

const providerCfg = (url: string) => ({
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
        baseURL: url,
      },
    },
  },
})

it.live("tool execution produces non-empty session diff (snapshot race)", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ dir, llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const summary = yield* SessionSummary.Service

      const session = yield* sessions.create({
        title: "snapshot race test",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      // Use bash tool (always registered) to create a file
      const command = `echo 'snapshot race test content' > ${path.join(dir, "race-test.txt")}`
      yield* llm.toolMatch((hit) => JSON.stringify(hit.body).includes("create the file"), "bash", {
        command,
      })
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("bash"), "done")

      // Seed user message
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model,
        noReply: true,
        parts: [{ type: "text", text: "create the file" }],
      })

      // Run the agent loop
      const result = yield* prompt.loop({ sessionID: session.id })
      expect(result.info.role).toBe("assistant")

      // Verify the file was created
      const filePath = path.join(dir, "race-test.txt")
      const fileExists = yield* Effect.promise(() =>
        fs
          .access(filePath)
          .then(() => true)
          .catch(() => false),
      )
      expect(fileExists).toBe(true)

      // Verify the tool call completed (in the first assistant message)
      const allMsgs = yield* MessageV2.filterCompactedEffect(session.id)
      const user = allMsgs.find(
        (msg): msg is SessionV1.WithParts & { info: SessionV1.User } => msg.info.role === "user",
      )
      const tool = allMsgs
        .flatMap((m) => m.parts)
        .find((p): p is SessionV1.ToolPart => p.type === "tool" && p.tool === "bash")
      expect(tool?.state.status).toBe("completed")
      if (!user) throw new Error("Expected user message")

      // Poll for the turn diff — summarize() is fire-and-forget.
      let diff: Array<{ file?: string }> = []
      for (let i = 0; i < 50; i++) {
        diff = yield* summary.diff({ sessionID: session.id, messageID: user.info.id })
        if (diff.length > 0) break
        yield* Effect.sleep("100 millis")
      }
      expect(diff.length).toBeGreaterThan(0)
    }),
    { git: true, config: providerCfg },
  ),
)

// Like provideTmpdirServer, with an init hook that runs before the instance loads.
const withServerDir = <A, E, R>(
  self: (input: { dir: string; llm: TestLLMServer["Service"] }) => Effect.Effect<A, E, R>,
  options: { git?: boolean; init?: (dir: string) => Effect.Effect<void, never, Scope.Scope> } = {},
) =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const dir = yield* tmpdirScoped({ git: options.git, config: providerCfg(llm.url), init: options.init })
    return yield* self({ dir, llm }).pipe(provideInstance(dir))
  }).pipe(Effect.provide(testInstanceStoreLayer))

// Runs one agent turn that calls a single tool, then answers with text. Returns the session's parts.
const runToolTurn = Effect.fnUntraced(function* (input: {
  llm: TestLLMServer["Service"]
  tool: string
  args: Record<string, unknown>
}) {
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const session = yield* sessions.create({
    title: "checkpoint test",
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  })
  yield* input.llm.toolMatch((hit) => JSON.stringify(hit.body).includes("change the files"), input.tool, input.args)
  yield* input.llm.textMatch((hit) => JSON.stringify(hit.body).includes(input.tool), "done")
  yield* prompt.prompt({
    sessionID: session.id,
    agent: "build",
    model,
    noReply: true,
    parts: [{ type: "text", text: "change the files" }],
  })
  yield* prompt.loop({ sessionID: session.id })
  const messages = yield* MessageV2.filterCompactedEffect(session.id)
  const tool = messages
    .flatMap((m) => m.parts)
    .find((p): p is SessionV1.ToolPart => p.type === "tool" && p.tool === input.tool)
  expect(tool?.state.status).toBe("completed")
  return { session, messages, parts: messages.flatMap((m) => m.parts) }
})

const homeAt = (dir: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_TEST_HOME
      process.env.OPENCODE_TEST_HOME = dir
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.OPENCODE_TEST_HOME
        else process.env.OPENCODE_TEST_HOME = previous
      }),
  ).pipe(Effect.asVoid)

const fwd = (...parts: string[]) => path.join(...parts).replaceAll("\\", "/")

it.live("plain folder: tool changes get checkpoints, a patch part and a turn diff", () =>
  withServerDir(
    Effect.fnUntraced(function* ({ dir, llm }) {
      const summary = yield* SessionSummary.Service
      const file = path.join(dir, "race-test.txt")
      const { session, messages, parts } = yield* runToolTurn({
        llm,
        tool: "write",
        args: { filePath: file, content: "folder checkpoint content\n" },
      })

      const patch = parts.find((p): p is SessionV1.PatchPart => p.type === "patch")
      expect(patch?.files).toContain(fwd(file))
      expect(patch?.hash).toBeTruthy()
      expect(parts.some((p) => p.type === "step-start" && !!p.snapshot)).toBe(true)
      expect(parts.some((p) => p.type === "step-finish" && !!p.snapshot)).toBe(true)

      const user = messages.find((msg) => msg.info.role === "user")
      if (!user) throw new Error("Expected user message")
      let diff: Array<{ file?: string }> = []
      for (let i = 0; i < 50; i++) {
        diff = yield* summary.diff({ sessionID: session.id, messageID: user.info.id })
        if (diff.length > 0) break
        yield* Effect.sleep("100 millis")
      }
      expect(diff.length).toBeGreaterThan(0)
    }),
  ),
)

it.live("plain folder: a write into an ignored folder is reported as not restorable", () =>
  withServerDir(
    Effect.fnUntraced(function* ({ dir, llm }) {
      const file = path.join(dir, "node_modules", "z.js")
      const { parts } = yield* runToolTurn({ llm, tool: "write", args: { filePath: file, content: "z\n" } })
      const patch = parts.find((p): p is SessionV1.PatchPart => p.type === "patch")
      expect(patch?.files).toEqual([])
      expect(patch?.skipped).toEqual([{ file: fwd(file), reason: "ignored" }])
    }),
  ),
)

it.live("home folder: file tool edits get a checkpoints-off notice", () =>
  withServerDir(
    Effect.fnUntraced(function* ({ dir, llm }) {
      const file = path.join(dir, "notes.txt")
      const { parts } = yield* runToolTurn({ llm, tool: "write", args: { filePath: file, content: "notes\n" } })
      const patch = parts.find((p): p is SessionV1.PatchPart => p.type === "patch")
      expect(patch).toMatchObject({
        hash: "",
        files: [],
        skipped: [{ file, reason: "unavailable" }],
        unavailable: "home",
      })
      expect(parts.some((p) => p.type === "step-start" && !!p.snapshot)).toBe(false)
    }),
    { init: homeAt },
  ),
)
