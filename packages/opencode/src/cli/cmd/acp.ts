import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"
import { ServerAuth } from "@/server/auth"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { ACPProfile } from "@/acp/profile"
import { WorkspaceTrustLaunch } from "@opencode-ai/core/trust/launch"
import { heldAllowWarning } from "./trust"

export const AcpCommand = effectCmd({
  command: "acp",
  describe: "start ACP (Agent Client Protocol) server",
  builder: (yargs) => {
    return withNetworkOptions(yargs)
      .option("cwd", {
        describe: "working directory",
        type: "string",
        default: process.cwd(),
      })
      .option("trust", {
        describe: "trust the folder for this process only (applies project allow rules; not saved)",
        type: "boolean",
        default: false,
      })
  },
  // ACP never prompts (stdout is the protocol stream): Claude Code SDK parity is the headless policy unless --trust or
  // OPENCODE_WORKSPACE_TRUST says otherwise.
  trustPolicy: (args) => {
    process.env.OPENCODE_CLIENT = "acp"
    if (args.trust) return "trusted"
    return WorkspaceTrustLaunch.fromEnv() ? undefined : "headless"
  },
  handler: Effect.fn("Cli.acp")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("@/server/server"))
    const { ACP } = yield* Effect.promise(() => import("@/acp/agent"))
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    ACPProfile.mark("cli.acp.handler")
    process.env.OPENCODE_CLIENT = "acp"
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => ACPProfile.measure("cli.acp.server.listen", () => Server.listen(opts)))
    const trust = yield* (yield* Config.Service).trust()
    const warning = heldAllowWarning({ effective: trust.state.effective, held: trust.held })
    if (warning) process.stderr.write(warning + "\n")

    const sdk = createOpencodeClient({
      baseUrl: `http://${server.hostname}:${server.port}`,
      headers: ServerAuth.headers(),
    })

    const input = new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise<void>((resolve, reject) => {
          process.stdout.write(chunk, (err) => {
            if (err) {
              reject(err)
            } else {
              resolve()
            }
          })
        })
      },
    })
    const output = new ReadableStream<Uint8Array>({
      start(controller) {
        process.stdin.on("data", (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk))
        })
        process.stdin.on("end", () => controller.close())
        process.stdin.on("error", (err) => controller.error(err))
      },
    })

    const stream = ndJsonStream(input, output)
    const agent = ACP.init({ sdk })

    new AgentSideConnection((conn) => {
      ACPProfile.mark("cli.acp.connection.create")
      return agent.create(conn)
    }, stream)

    yield* Effect.logInfo("setup connection")
    process.stdin.resume()
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          process.stdin.on("end", () => resolve())
          process.stdin.on("error", reject)
        }),
    )
  }),
})
