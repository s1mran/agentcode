import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Npm } from "@opencode-ai/core/npm"
import { WorkspaceTrustLaunch } from "@opencode-ai/core/trust/launch"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin"
import { Permission } from "../../src/permission"
import { Instruction } from "../../src/session/instruction"
import { WorkspaceTrust } from "../../src/trust"
import { WorkspaceTrustKey } from "../../src/trust/key"
import { WorkspaceTrustRestrict } from "../../src/trust/restrict"
import { WorkspaceTrustStore } from "../../src/trust/store"
import { approveAddedMcp } from "../../src/cli/cmd/trust"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { provideInstanceEffect, testInstanceStoreLayer, tmpdir } from "../fixture/fixture"

const unexpectedHttp = HttpClient.make((request) => Effect.die(`unexpected http request: ${request.url}`))

const layer = () =>
  AppNodeBuilder.build(
    LayerNode.group([
      Plugin.node,
      Config.node,
      WorkspaceTrust.node,
      FSUtil.node,
      Env.node,
      CrossSpawnSpawner.node,
      Instruction.node,
      Permission.node,
    ]),
    [
      [Auth.node, AuthTest.empty],
      [Account.node, AccountTest.empty],
      [Npm.node, NpmTest.noop],
      [httpClient, Layer.succeed(HttpClient.HttpClient, unexpectedHttp)],
      [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
    ],
  )

function run<A, E>(
  directory: string,
  effect: Effect.Effect<A, E, Config.Service | Plugin.Service | Instruction.Service | WorkspaceTrust.Service>,
) {
  return Effect.runPromise(
    effect.pipe(provideInstanceEffect(directory), Effect.provide(testInstanceStoreLayer), Effect.provide(layer())),
  )
}

const loadConfig = (directory: string) =>
  run(
    directory,
    Effect.gen(function* () {
      const config = yield* Config.Service
      return {
        info: yield* config.get(),
        trust: yield* config.trust(),
        directories: yield* config.directories(),
        trusted: yield* config.trustedDirectories(),
        localOrigin: yield* config.mcpOrigin("local-srv"),
      }
    }),
  )

const originalConfig = Global.Path.config
const originalEnv = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, MY_TOKEN: process.env.MY_TOKEN }

beforeEach(async () => {
  await fs.rm(WorkspaceTrustStore.file(), { force: true })
  process.env.ANTHROPIC_API_KEY = "sk-ant-secret"
  process.env.MY_TOKEN = "my-token-value"
})

afterEach(async () => {
  WorkspaceTrustLaunch.set(undefined)
  ;(Global.Path as { config: string }).config = originalConfig
  await fs.rm(WorkspaceTrustStore.file(), { force: true })
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

type Fixture = { dir: string; outside: string; markers: string; global: string }

async function fixture(options: { extraMcp?: Record<string, unknown> } = {}) {
  const repo = await tmpdir({ git: true })
  const other = await tmpdir()
  const dir = repo.path
  const markers = path.join(other.path, "markers")
  const global = path.join(other.path, "global")
  await fs.mkdir(markers, { recursive: true })
  await fs.mkdir(global, { recursive: true })
  const outside = path.join(other.path, "outside.txt")
  await fs.writeFile(outside, "outside-secret")
  await fs.writeFile(path.join(dir, "inside.txt"), "inside-value")

  const marker = (name: string) =>
    `import fs from "fs"\nfs.writeFileSync(${JSON.stringify(path.join(markers, name))}, "imported")\nexport default async () => ({})\n`
  await fs.writeFile(path.join(global, "global-plugin.ts"), marker("global"))
  await fs.writeFile(
    path.join(global, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      plugin: [pathToFileURL(path.join(global, "global-plugin.ts")).href],
      mcp: {
        shared: { type: "local", command: ["user-command"], enabled: false },
        "global-only": { type: "local", command: ["global-only"], enabled: false },
      },
    }),
  )
  ;(Global.Path as { config: string }).config = global

  await fs.writeFile(
    path.join(dir, "opencode.json"),
    JSON.stringify({
      username: `{env:MY_TOKEN}|{env:ANTHROPIC_API_KEY}|{file:${outside}}|{file:./inside.txt}`,
      permission: { bash: { "git *": "allow", "rm *": "deny" } },
      mcp: {
        "local-srv": { type: "local", command: ["project-server"], enabled: false },
        shared: { type: "local", command: ["project-shadow"], enabled: false },
        ...options.extraMcp,
      },
    }),
  )
  const opencode = path.join(dir, ".opencode")
  await fs.mkdir(path.join(opencode, "plugins"), { recursive: true })
  await fs.mkdir(path.join(opencode, "agents"), { recursive: true })
  await fs.mkdir(path.join(opencode, "commands"), { recursive: true })
  await fs.mkdir(path.join(opencode, "tools"), { recursive: true })
  await fs.writeFile(path.join(opencode, "plugins", "marker.ts"), marker("project"))
  await fs.writeFile(
    path.join(opencode, "agents", "helper.md"),
    "---\ndescription: helper\npermission:\n  bash: allow\n  edit: deny\n---\nHelp.\n",
  )
  await fs.writeFile(path.join(opencode, "commands", "boom.md"), "Run !`echo boom` now\n")
  await fs.writeFile(path.join(opencode, "commands", "plain.md"), "Summarize the repo\n")
  await fs.writeFile(path.join(opencode, "tools", "tool.ts"), "export default {}\n")

  const value: Fixture & AsyncDisposable = {
    dir,
    outside,
    markers,
    global,
    async [Symbol.asyncDispose]() {
      await repo[Symbol.asyncDispose]()
      await other[Symbol.asyncDispose]()
    },
  }
  return value
}

const exists = (file: string) =>
  fs
    .stat(file)
    .then(() => true)
    .catch(() => false)

const initPlugins = (directory: string) =>
  run(
    directory,
    Effect.gen(function* () {
      yield* (yield* Plugin.Service).init()
    }),
  )

async function storeDecision(dir: string, entry: Partial<WorkspaceTrustStore.Entry>) {
  const info = WorkspaceTrustKey.resolve(dir)
  await WorkspaceTrustStore.update((data) => {
    data.workspaces[info.key] = {
      path: info.path,
      kind: info.kind,
      trusted: true,
      time: 1,
      mcp: { approved: {}, rejected: [] },
      ...entry,
    }
  })
}

const fingerprint = (entry: Parameters<typeof WorkspaceTrustRestrict.mcpFingerprint>[0]) =>
  WorkspaceTrustRestrict.mcpFingerprint(entry)

describe("workspace trust: restricted (prompt policy, no decision)", () => {
  test("holds project code and allow rules, keeps deny rules and the user's own config", async () => {
    WorkspaceTrustLaunch.set("prompt")
    await using fx = await fixture()
    const loaded = await loadConfig(fx.dir)

    expect(loaded.trust.state).toMatchObject({ status: "unknown", effective: "restricted", kind: "repository" })

    // Plugins: the project marker is held and never imported; the global plugin still loads.
    await initPlugins(fx.dir)
    expect(await exists(path.join(fx.markers, "project"))).toBe(false)
    expect(await exists(path.join(fx.markers, "global"))).toBe(true)
    expect(loaded.trust.held).toContainEqual({
      kind: "plugin",
      spec: pathToFileURL(path.join(fx.dir, ".opencode", "plugins", "marker.ts")).href,
      source: path.join(fx.dir, ".opencode"),
    })
    expect(loaded.trust.held).toContainEqual({
      kind: "tool",
      file: path.join(fx.dir, ".opencode", "tools", "tool.ts"),
    })
    expect(loaded.trusted).not.toContain(path.join(fx.dir, ".opencode"))
    expect(loaded.directories).toContain(path.join(fx.dir, ".opencode"))

    // Nothing is written into the repository.
    expect(await exists(path.join(fx.dir, ".opencode", ".gitignore"))).toBe(false)
    expect(await exists(path.join(fx.dir, ".opencode", "package.json"))).toBe(false)
    expect(await exists(path.join(fx.dir, ".opencode", "node_modules"))).toBe(false)
    expect(await Bun.file(path.join(fx.dir, "opencode.json")).text()).not.toContain("$schema")

    // MCP: project servers are held; a name the user defines falls back to the user's definition.
    expect(loaded.info.mcp?.["local-srv"]).toBeUndefined()
    expect(loaded.info.mcp?.shared).toEqual({ type: "local", command: ["user-command"], enabled: false })
    expect(loaded.info.mcp?.["global-only"]).toBeDefined()
    expect(loaded.localOrigin).toBeUndefined()
    const heldMcp = loaded.trust.held.filter((item) => item.kind === "mcp")
    expect(heldMcp.map((item) => item.kind === "mcp" && [item.name, item.reason]).sort()).toEqual([
      ["local-srv", "untrusted"],
      ["shared", "untrusted"],
    ])

    // Permissions: only the deny survives, and the agent's allow is stripped.
    expect(loaded.info.permission?.bash).toEqual({ "rm *": "deny" })
    expect(loaded.info.agent?.helper?.permission).toEqual({ edit: "deny" })
    expect(loaded.trust.held).toContainEqual({
      kind: "permission",
      permission: "bash",
      pattern: "*",
      source: path.join(fx.dir, ".opencode"),
      agent: "helper",
    })

    // Commands: shell templates are held, plain ones apply.
    expect(loaded.info.command?.boom).toBeUndefined()
    expect(loaded.info.command?.plain).toBeDefined()
    expect(loaded.trust.held).toContainEqual({ kind: "command", name: "boom", source: path.join(fx.dir, ".opencode") })

    // Substitutions: credentials and files outside the repository read as empty.
    expect(loaded.info.username).toBe("|||inside-value")
  })
})

describe("workspace trust: trusted", () => {
  test("a stored decision with approvals loads everything, and project config substitutes like the user's", async () => {
    WorkspaceTrustLaunch.set("prompt")
    await using fx = await fixture()
    await storeDecision(fx.dir, {
      mcp: {
        approved: {
          "local-srv": fingerprint({ type: "local", command: ["project-server"], enabled: false }),
          shared: fingerprint({ type: "local", command: ["project-shadow"], enabled: false }),
        },
        rejected: [],
      },
    })
    const loaded = await loadConfig(fx.dir)
    expect(loaded.trust.state).toMatchObject({ status: "trusted", effective: "full", source: "stored" })
    expect(loaded.trust.held).toEqual([])
    await initPlugins(fx.dir)
    expect(await exists(path.join(fx.markers, "project"))).toBe(true)
    expect(loaded.info.permission?.bash).toEqual({ "git *": "allow", "rm *": "deny" })
    expect(loaded.info.mcp?.["local-srv"]).toMatchObject({ command: ["project-server"] })
    expect(loaded.info.mcp?.shared).toMatchObject({ command: ["project-shadow"] })
    expect(loaded.localOrigin).toMatchObject({ project: true })
    expect(loaded.trusted).toContain(path.join(fx.dir, ".opencode"))
    // Trusted project config can already run code, so hiding a variable from its text protects nothing and only breaks
    // provider and MCP settings that read keys from the environment.
    expect(loaded.info.username).toBe("my-token-value|sk-ant-secret|outside-secret|inside-value")
  })

  test("new, changed and rejected project servers are held with their reason", async () => {
    WorkspaceTrustLaunch.set("prompt")
    await using fx = await fixture({
      extraMcp: { added: { type: "remote", url: "https://mcp.example", enabled: false } },
    })
    await storeDecision(fx.dir, {
      mcp: {
        approved: { "local-srv": fingerprint({ type: "local", command: ["old-command"], enabled: false }) },
        rejected: ["shared"],
      },
    })
    const loaded = await loadConfig(fx.dir)
    const reasons = Object.fromEntries(
      loaded.trust.held.flatMap((item) => (item.kind === "mcp" ? [[item.name, item.reason]] : [])),
    )
    expect(reasons).toEqual({ "local-srv": "changed", shared: "rejected", added: "pending" })
    expect(loaded.info.mcp?.["local-srv"]).toBeUndefined()
    expect(loaded.info.mcp?.added).toBeUndefined()
    // The rejected project definition falls back to the user's own server of the same name.
    expect(loaded.info.mcp?.shared).toMatchObject({ command: ["user-command"] })
  })

  test("the untrusted policy overrides a stored trusted decision", async () => {
    WorkspaceTrustLaunch.set("untrusted")
    await using fx = await fixture()
    await storeDecision(fx.dir, {})
    const loaded = await loadConfig(fx.dir)
    expect(loaded.trust.state).toMatchObject({ status: "trusted", effective: "restricted" })
    expect(loaded.info.permission?.bash).toEqual({ "rm *": "deny" })
    expect(loaded.info.mcp?.["local-srv"]).toBeUndefined()
  })
})

describe("workspace trust: headless", () => {
  test("plugins and MCP servers load, allow rules do not, rejected servers stay held", async () => {
    WorkspaceTrustLaunch.set("headless")
    await using fx = await fixture()
    await storeDecision(fx.dir, { trusted: false, mcp: { approved: {}, rejected: ["shared"] } })
    const loaded = await loadConfig(fx.dir)
    expect(loaded.trust.state).toMatchObject({ status: "untrusted", effective: "headless" })
    await initPlugins(fx.dir)
    expect(await exists(path.join(fx.markers, "project"))).toBe(true)
    expect(loaded.info.mcp?.["local-srv"]).toMatchObject({ command: ["project-server"] })
    expect(loaded.info.mcp?.shared).toMatchObject({ command: ["user-command"] })
    expect(loaded.info.permission?.bash).toEqual({ "rm *": "deny" })
    expect(loaded.info.agent?.helper?.permission).toEqual({ edit: "deny" })
    expect(loaded.info.command?.boom).toBeDefined()
    expect(loaded.trust.held.map((item) => item.kind).sort()).toEqual(["mcp", "permission", "permission"])
  })
})

describe("workspace trust: instruction files", () => {
  test("restricted: an untrusted config cannot put files from outside the project into the system prompt", async () => {
    WorkspaceTrustLaunch.set("prompt")
    await using fx = await fixture()
    const secret = path.join(path.dirname(fx.outside), "id_rsa")
    await fs.writeFile(secret, "TOP-SECRET-PRIVATE-KEY-abcdef")
    await fs.mkdir(path.join(fx.dir, "docs"), { recursive: true })
    await fs.writeFile(path.join(fx.dir, "docs", "rules.md"), "INSIDE-RULES-123")
    await fs.symlink(secret, path.join(fx.dir, "notes.md"))
    await fs.writeFile(
      path.join(fx.dir, ".opencode", "opencode.json"),
      JSON.stringify({ instructions: [secret, "../id_rsa", "notes.md", "docs/rules.md"] }),
    )
    const result = await run(
      fx.dir,
      Effect.gen(function* () {
        const config = yield* Config.Service
        return {
          trust: yield* config.trust(),
          info: yield* config.get(),
          system: (yield* (yield* Instruction.Service).system()).join("\n"),
        }
      }),
    )
    expect(result.trust.state.effective).toBe("restricted")
    expect(result.system).not.toContain("TOP-SECRET-PRIVATE-KEY-abcdef")
    expect(result.system).toContain("INSIDE-RULES-123")
    expect(result.info.instructions).toEqual(["docs/rules.md"])
    for (const detail of [secret, "../id_rsa", "notes.md"]) {
      expect(result.trust.held).toContainEqual({
        kind: "setting",
        key: "instructions",
        source: path.join(fx.dir, ".opencode", "opencode.json"),
        detail,
      })
    }
  })
})

describe("workspace trust: MCP fingerprints and headless runs", () => {
  test("a server's fingerprint is the same in every mode and never includes a substituted secret", async () => {
    await using fx = await fixture({
      extraMcp: {
        tokened: { type: "local", command: ["srv", "--token", "{env:MY_TOKEN}"], enabled: false },
        keyed: { type: "remote", url: "https://mcp.example/{env:ANTHROPIC_API_KEY}", enabled: false },
      },
    })
    const held = async (policy: WorkspaceTrustLaunch.Policy) => {
      WorkspaceTrustLaunch.set(policy)
      const loaded = await loadConfig(fx.dir)
      return Object.fromEntries(
        loaded.trust.held.flatMap((item) => (item.kind === "mcp" ? [[item.name, item] as const] : [])),
      )
    }
    const restricted = await held("prompt")
    expect(restricted.tokened?.command).toEqual(["srv", "--token", "{env:MY_TOKEN}"])
    expect(restricted.keyed?.url).toBe("https://mcp.example/{env:ANTHROPIC_API_KEY}")

    // Approve what the restricted dialog showed, then load trusted: nothing comes back as changed.
    await storeDecision(fx.dir, {
      mcp: {
        approved: Object.fromEntries(Object.values(restricted).map((item) => [item.name, item.fingerprint])),
        rejected: [],
      },
    })
    const trusted = await loadConfig(fx.dir)
    expect(trusted.trust.state.effective).toBe("full")
    expect(trusted.trust.held).toEqual([])
    expect(trusted.info.mcp?.tokened).toMatchObject({ command: ["srv", "--token", "my-token-value"] })

    // Rotating the secret does not ask again.
    process.env.MY_TOKEN = "rotated-token"
    expect((await loadConfig(fx.dir)).trust.held).toEqual([])
  })

  test("headless in a trusted folder connects servers the user never approved, like an undecided folder", async () => {
    WorkspaceTrustLaunch.set("headless")
    await using fx = await fixture({
      extraMcp: { added: { type: "remote", url: "https://mcp.example", enabled: false } },
    })
    await storeDecision(fx.dir, { mcp: { approved: {}, rejected: ["shared"] } })
    const loaded = await loadConfig(fx.dir)
    expect(loaded.trust.state).toMatchObject({ status: "trusted", effective: "full", source: "stored" })
    expect(loaded.info.mcp?.added).toMatchObject({ url: "https://mcp.example" })
    expect(loaded.info.mcp?.["local-srv"]).toMatchObject({ command: ["project-server"] })
    // An explicit rejection still holds.
    expect(loaded.info.mcp?.shared).toMatchObject({ command: ["user-command"] })
    expect(loaded.trust.held.flatMap((item) => (item.kind === "mcp" ? [[item.name, item.reason]] : []))).toEqual([
      ["shared", "rejected"],
    ])
  })

  test("headless substitutes project config like the user's: provider keys from the environment reach it", async () => {
    WorkspaceTrustLaunch.set("headless")
    await using fx = await fixture()
    const loaded = await loadConfig(fx.dir)
    expect(loaded.trust.state.effective).toBe("headless")
    expect(loaded.info.username).toBe("my-token-value|sk-ant-secret|outside-secret|inside-value")
  })
})

describe("workspace trust: MCP choices under a trusted parent directory", () => {
  test("approving a server stores the choice on the parent decision, so restricting the parent still covers the child", async () => {
    WorkspaceTrustLaunch.set("prompt")
    await using tmp = await tmpdir()
    const parent = await fs.realpath(tmp.path)
    const child = path.join(parent, "tool")
    await fs.mkdir(child)
    await WorkspaceTrustStore.update((data) => {
      const info = WorkspaceTrustKey.resolve(parent)
      data.workspaces[info.key] = {
        path: info.path,
        kind: "directory",
        trusted: true,
        time: 1,
        mcp: { approved: {}, rejected: [] },
      }
    })
    const state = await run(
      child,
      Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        const ctx = { directory: child }
        return yield* trust.setMcp(ctx, "srv", "fingerprint-1")
      }),
    )
    expect(state).toMatchObject({ status: "trusted", source: "parent" })
    expect(state.mcp.approved).toEqual({ srv: "fingerprint-1" })
    await approveAddedMcp(child, "added", { type: "remote", url: "https://mcp.example" })

    const data = (await WorkspaceTrustStore.read()).data
    expect(data.workspaces[WorkspaceTrustKey.resolve(child).key]).toBeUndefined()
    expect(Object.keys(data.workspaces[WorkspaceTrustKey.resolve(parent).key]?.mcp.approved ?? {}).sort()).toEqual([
      "added",
      "srv",
    ])

    await WorkspaceTrustStore.update((next) => {
      next.workspaces[WorkspaceTrustKey.resolve(parent).key]!.trusted = false
    })
    const after = await run(
      child,
      Effect.gen(function* () {
        return yield* (yield* WorkspaceTrust.Service).state({ directory: child })
      }),
    )
    expect(after).toMatchObject({ status: "untrusted", effective: "restricted" })
  })
})
