// ACP never prompts about workspace trust (stdout is the protocol stream). Without --trust it is headless, like the
// Claude Code SDK: a folder's own plugins and MCP servers load without asking, and the session does not hang.
import { describe, expect } from "bun:test"
import type { PromptResponse } from "@agentclientprotocol/sdk"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { cliIt } from "../../lib/cli-process"
import { expectOk } from "./acp-test-client"
import { createAcpClient, initialize, newSession, verifierConfig } from "./helpers"

const exists = (file: string) =>
  fs
    .stat(file)
    .then(() => true)
    .catch(() => false)

describe("opencode acp workspace trust", () => {
  cliIt.live(
    "a session in a folder with project plugins and an MCP server starts them without asking",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const project = path.join(home, "project")
        const pluginMarker = path.join(home, "plugin-imported.txt")
        const mcpMarker = path.join(home, "mcp-started.txt")
        yield* Effect.promise(async () => {
          await fs.mkdir(project, { recursive: true })
          const plugin = path.join(project, "marker-plugin.ts")
          await fs.writeFile(
            plugin,
            `import fs from "fs"\nfs.writeFileSync(${JSON.stringify(pluginMarker)}, "1")\nexport default async () => ({})\n`,
          )
          await fs.writeFile(
            path.join(project, "opencode.json"),
            JSON.stringify({
              plugin: [pathToFileURL(plugin).href],
              mcp: {
                marker: {
                  type: "local",
                  command: [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(mcpMarker)}, "1")`],
                  timeout: 2000,
                },
              },
            }),
          )
        })
        const acp = yield* createAcpClient(
          { opencode },
          {
            OPENCODE_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)),
            OPENCODE_WORKSPACE_TRUST: "",
            OPENCODE_PURE: "false",
            OPENCODE_DISABLE_PROJECT_CONFIG: "false",
          },
        )
        yield* initialize(acp)
        const session = yield* newSession(acp, project)
        yield* llm.text("done")
        const result = expectOk(
          yield* acp.request<PromptResponse>("session/prompt", {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "hi" }],
          }),
        )
        expect(result.stopReason).toBe("end_turn")
        expect(yield* Effect.promise(() => exists(pluginMarker))).toBe(true)
        expect(yield* Effect.promise(() => exists(mcpMarker))).toBe(true)
      }),
    120_000,
  )
})
