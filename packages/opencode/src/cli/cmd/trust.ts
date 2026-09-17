import path from "path"
import { Effect } from "effect"
import * as prompts from "@clack/prompts"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import type { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { Config } from "@/config/config"
import { InstanceRef } from "@/effect/instance-ref"
import { WorkspaceTrust } from "@/trust"
import { WorkspaceTrustKey } from "@/trust/key"
import { WorkspaceTrustRestrict } from "@/trust/restrict"
import { WorkspaceTrustStore } from "@/trust/store"
import { WorkspaceTrustLaunch } from "@opencode-ai/core/trust/launch"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

type HeldSummary = { effective: WorkspaceTrust.Effective; held: ReadonlyArray<WorkspaceTrustRestrict.HeldItem> }

/**
 * The one-line stderr warning for a run that did not apply everything the folder's configuration supplies, or
 * undefined when nothing was held. Headless runs (`run`, `acp`) hold only allow rules, like Claude Code -p.
 */
export function heldAllowWarning(input: HeldSummary) {
  if (input.effective === "full" || input.held.length === 0) return
  if (input.effective === "headless") {
    const rules = input.held.filter((item) => item.kind === "permission").length
    const other = input.held.length - rules
    const parts = [
      ...(rules ? [`${rules} project allow rule${rules === 1 ? "" : "s"}`] : []),
      ...(other ? [`${other} other project setting${other === 1 ? "" : "s"}`] : []),
    ]
    return `! this workspace has not been trusted: ${parts.join(" and ")} ignored (run agentcode here to trust it, or pass --trust)`
  }
  return "! restricted mode: project plugins, MCP servers and allow rules are held until the folder is trusted in the app"
}

const GROUPS: Array<{ kind: WorkspaceTrustRestrict.HeldItem["kind"]; title: string }> = [
  { kind: "plugin", title: "Plugins" },
  { kind: "tool", title: "Custom tools" },
  { kind: "mcp", title: "MCP servers" },
  { kind: "permission", title: "Allow rules" },
  { kind: "command", title: "Shell commands" },
  { kind: "setting", title: "Other settings" },
]

function describeItem(item: WorkspaceTrustRestrict.HeldItem) {
  switch (item.kind) {
    case "plugin":
      return item.spec
    case "tool":
      return item.file
    case "mcp":
      return `${item.name}: ${item.type === "local" ? (item.command ?? []).join(" ") : item.url}${
        item.reason === "untrusted" ? "" : ` (${item.reason === "pending" ? "needs approval" : item.reason})`
      }`
    case "permission":
      return `${item.agent ? `agent ${item.agent}: ` : ""}${item.permission} ${item.pattern}`
    case "command":
      return `/${item.name}`
    case "setting":
      return item.detail ? `${item.key}: ${item.detail}` : item.key
  }
}

/** The held items grouped by kind, one indented line each, for a terminal. */
export function formatHeld(held: ReadonlyArray<WorkspaceTrustRestrict.HeldItem>) {
  return GROUPS.flatMap((group) => {
    const items = held.filter((item) => item.kind === group.kind)
    if (!items.length) return []
    return [`${group.title}:`, ...items.map((item) => `  ${describeItem(item)}`)]
  }).join("\n")
}

/**
 * After `agentcode mcp add` writes a server into a trusted folder's project config, records it as approved so the
 * user's own addition does not come back as pending. Does nothing for folders that are not trusted in the store.
 */
export async function approveAddedMcp(directory: string, name: string, entry: ConfigMCPV1.Info) {
  const info = WorkspaceTrustKey.resolve(directory)
  if (info.sessionOnly) return
  const current = WorkspaceTrustStore.lookupIn((await WorkspaceTrustStore.read()).data, info)
  if (!current?.entry.trusted) return
  await WorkspaceTrustStore.update((data) => {
    const found = WorkspaceTrustStore.lookupIn(data, info)
    if (!found?.entry.trusted) return
    const mcp = {
      approved: { ...found.entry.mcp.approved, [name]: WorkspaceTrustRestrict.mcpFingerprint(entry) },
      rejected: found.entry.mcp.rejected.filter((item) => item !== name),
    }
    // Trust from a parent directory decision stays there, so restricting the parent later still covers this folder.
    if (found.source === "parent") {
      found.entry.mcp = mcp
      return
    }
    data.workspaces[info.key] = { ...found.entry, path: info.path, kind: info.kind, trusted: true, mcp }
  })
}

const trustLayer = AppNodeBuilder.build(WorkspaceTrust.node)

export const TrustCommand = effectCmd({
  command: "trust [dir]",
  describe: "review and trust the configuration a folder supplies (plugins, MCP servers, allow rules)",
  builder: (yargs) =>
    yargs
      .positional("dir", {
        describe: "folder to review (defaults to the current directory)",
        type: "string",
      })
      .option("yes", {
        alias: ["y"],
        describe: "trust without asking (required when stdin is not a terminal)",
        type: "boolean",
        default: false,
      })
      .option("revoke", {
        describe: "store this folder as untrusted (restricted mode)",
        type: "boolean",
        default: false,
      })
      .option("forget", {
        describe: "remove the decision, so the folder is asked about again",
        type: "boolean",
        default: false,
      })
      .option("status", {
        describe: "print the trust state and what is held",
        type: "boolean",
        default: false,
      })
      .option("list", {
        describe: "list every stored trust decision",
        type: "boolean",
        default: false,
      })
      .option("reset-mcp", {
        describe: "clear the approved and rejected MCP servers for this folder",
        type: "boolean",
        default: false,
      })
      .option("format", {
        describe: "output format for --status and --list",
        type: "string",
        choices: ["text", "json"],
        default: "text",
      }),
  directory: (args) => path.resolve(process.cwd(), args.dir ?? "."),
  // Computed restricted, so reviewing a folder never runs anything it supplies.
  trustPolicy: () => "untrusted",
  handler: Effect.fn("Cli.trust")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* Effect.die("InstanceRef not provided")
    const trust = yield* WorkspaceTrust.Service
    const loaded = yield* (yield* Config.Service).trust()
    const current = yield* trust.state(ctx)
    const json = args.format === "json"
    const storeFailure = (error: WorkspaceTrust.StoreError) => fail(error.message)

    if (args.list) {
      const items = yield* trust.list()
      if (json) {
        process.stdout.write(JSON.stringify(items, null, 2) + "\n")
        return
      }
      if (!items.length) {
        UI.println("No workspace trust decisions stored")
        return
      }
      for (const item of items) {
        UI.println(`${item.trusted ? "trusted   " : "restricted"}  ${item.kind.padEnd(10)}  ${item.path}`)
      }
      return
    }

    if (args.status) {
      // This process reviews restricted; report the policy and mode a normal launch here would get.
      const policy = WorkspaceTrustLaunch.fromEnv() ?? "prompt"
      const effective = WorkspaceTrust.effectiveFor(policy, current.status)
      // This review loaded restricted, so `loaded.held` is everything the folder supplies. A launch that loads it all
      // holds nothing: report those items as supplied instead.
      const result = {
        ...WorkspaceTrust.info(loaded, current),
        policy,
        effective,
        ...(effective === "full" ? { held: [], supplies: loaded.held } : {}),
      }
      if (json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n")
        return
      }
      UI.println(`${result.path} (${result.kind})`)
      UI.println(`status: ${result.status}${result.sessionOnly ? " (session only)" : ""}`)
      if (result.held.length) UI.println(`Held until trusted:\n${formatHeld(result.held)}`)
      if (result.supplies?.length) UI.println(`Loaded from this folder:\n${formatHeld(result.supplies)}`)
      return
    }

    if (args["reset-mcp"]) {
      yield* trust.resetMcp(ctx).pipe(Effect.catch(storeFailure))
      UI.println(`MCP server choices cleared for ${current.path}`)
      return
    }

    if (args.forget) {
      yield* trust.forget(ctx).pipe(Effect.catch(storeFailure))
      UI.println(`Trust decision removed for ${current.path}`)
      return
    }

    if (args.revoke) {
      yield* trust.decide(ctx, { trusted: false }).pipe(Effect.catch(storeFailure))
      UI.println(`${current.path} is restricted: its plugins, MCP servers and allow rules are held`)
      return
    }

    if (current.sessionOnly) {
      return yield* fail(
        `${current.path} is your home folder or the filesystem root: trust there lasts for one session and is never saved. Trust it from the app or the TUI instead.`,
      )
    }

    UI.println(`${current.path} (${current.kind})`)
    UI.println(
      loaded.held.length
        ? `Trusting lets this folder's own configuration run on your machine:\n${formatHeld(loaded.held)}`
        : "This folder's configuration supplies nothing that waits for trust.",
    )
    if (!args.yes) {
      if (!process.stdin.isTTY) return yield* fail("pass --yes to trust non-interactively")
      const confirmed = yield* Effect.promise(() =>
        prompts.confirm({
          message: "Trust this folder? Only trust folders from people you trust.",
          initialValue: false,
        }),
      )
      if (prompts.isCancel(confirmed) || !confirmed) {
        UI.println("Nothing changed")
        return
      }
    }
    const approve = loaded.held.flatMap((item) =>
      item.kind === "mcp" && !current.mcp.rejected.includes(item.name)
        ? [{ name: item.name, fingerprint: item.fingerprint }]
        : [],
    )
    yield* trust.decide(ctx, { trusted: true, mcp: { approve } }).pipe(Effect.catch(storeFailure))
    UI.println(`Trusted ${current.path}`)
  }, Effect.provide(trustLayer)),
})
