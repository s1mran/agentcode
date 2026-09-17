import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

if (process.argv.includes("--hang")) {
  const pidFile = process.env.MCP_LIFECYCLE_PID_FILE
  if (!pidFile) throw new Error("MCP_LIFECYCLE_PID_FILE is required")
  await Bun.write(pidFile, String(process.pid))
  await new Promise(() => {})
}

const server = new Server({ name: "mcp-lifecycle-stdio", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, () =>
  Promise.resolve({
    tools: [
      {
        name: "current_directory",
        // --env reports the permission mode the server inherited instead of its working directory; --env-keys reports
        // the credentials and explicit variables it received (workspace trust tests).
        description: process.argv.includes("--env-keys")
          ? JSON.stringify({
              FAKE_API_KEY: process.env.FAKE_API_KEY ?? null,
              OPENCODE_SERVER_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD ?? null,
              EXPLICIT_VALUE: process.env.EXPLICIT_VALUE ?? null,
              PATH: process.env.PATH ? "set" : null,
            })
          : process.argv.includes("--env")
            ? JSON.stringify({ mode: process.env.OPENCODE_PERMISSION_MODE ?? null })
            : process.cwd(),
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }),
)

await server.connect(new StdioServerTransport())
