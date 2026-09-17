import path from "node:path"
import { afterEach, beforeEach, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { WorkspaceTrustLaunch } from "@opencode-ai/core/trust/launch"
import { Effect, Exit } from "effect"
import { MCP } from "../../src/mcp/index"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(MCP.node))
const stdioFixture = path.join(import.meta.dir, "../fixture/mcp-lifecycle-stdio.ts")

const saved = {
  FAKE_API_KEY: process.env.FAKE_API_KEY,
  OPENCODE_SERVER_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD,
}

beforeEach(() => {
  process.env.FAKE_API_KEY = "fake-key"
  process.env.OPENCODE_SERVER_PASSWORD = "server-password"
})

afterEach(() => {
  WorkspaceTrustLaunch.set(undefined)
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const projectServer = {
  mcp: {
    "project-srv": {
      type: "local" as const,
      command: [process.execPath, stdioFixture, "--env-keys"],
      environment: { EXPLICIT_VALUE: "explicit" },
    },
  },
}

const envOf = (tools: Record<string, MCP.McpTool>, name: string) =>
  JSON.parse(tools[`${name}_current_directory`]?.def.description ?? "null")

it.instance(
  "an untrusted project server reports pending approval and is never started",
  () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      const status = yield* mcp.status()
      expect(status["project-srv"]).toMatchObject({ status: "pending_approval", reason: "untrusted" })
      const exit = yield* mcp.connect("project-srv").pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(JSON.stringify(exit.cause)).toContain("MCP.ApprovalRequiredError")
      expect(Object.keys(yield* mcp.clients())).toEqual([])
      expect(yield* mcp.tools()).toEqual({})
    }),
  {
    git: true,
    config: () => {
      WorkspaceTrustLaunch.set("prompt")
      return projectServer
    },
  },
)

it.instance(
  "a trusted project server gets no credentials from the environment but keeps its explicit variables",
  () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      expect((yield* mcp.status())["project-srv"]).toEqual({ status: "connected" })
      // A server the user adds (not from the project's config) keeps today's environment.
      yield* mcp.add("user-srv", { type: "local", command: [process.execPath, stdioFixture, "--env-keys"] })
      const tools = yield* mcp.tools()
      expect(envOf(tools, "project-srv")).toEqual({
        FAKE_API_KEY: null,
        OPENCODE_SERVER_PASSWORD: null,
        EXPLICIT_VALUE: "explicit",
        PATH: "set",
      })
      expect(envOf(tools, "user-srv")).toMatchObject({
        FAKE_API_KEY: "fake-key",
        OPENCODE_SERVER_PASSWORD: "server-password",
      })
    }),
  {
    git: true,
    config: () => {
      WorkspaceTrustLaunch.set("trusted")
      return projectServer
    },
  },
)
