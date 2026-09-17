import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { InstanceState } from "@/effect/instance-state"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { PermissionLocalStore } from "../../src/permission/local-store"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import type { WorkspaceTrust } from "../../src/trust"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([FSUtil.node, CrossSpawnSpawner.node, InstanceStore.node]), [
    [InstanceBootstrap.node, noopBootstrap],
  ]),
)

const store = Effect.gen(function* () {
  return yield* PermissionLocalStore.make({ fs: yield* FSUtil.Service, spawner: yield* ChildProcessSpawner })
})

const allow = (permission: string, pattern: string) => ({ permission, pattern, action: "allow" as const })

const file = (dir: string) => path.join(dir, ".opencode", "settings.local.json")

const promise = <A>(fn: () => Promise<A>) => Effect.promise(fn)

describe("PermissionLocalStore.parse / merge", () => {
  test("merge creates the permission object in an empty file", () => {
    const next = PermissionLocalStore.merge("", [allow("bash", "git checkout *"), allow("webfetch", "example.com")])
    expect(next?.changed).toBe(true)
    expect(JSON.parse(next!.text)).toEqual({
      permission: { bash: { "git checkout *": "allow" }, webfetch: { "example.com": "allow" } },
    })
  })

  test("merge keeps existing entries, converts string values and never replaces a deny", () => {
    const text = `{
  // user notes survive
  "theme": "dark",
  "permission": { "bash": "deny", "edit": { "secrets/*": "deny" } }
}
`
    const next = PermissionLocalStore.merge(text, [allow("bash", "npm test *"), allow("edit", "secrets/*")])
    expect(next?.changed).toBe(true)
    expect(next!.text).toContain("// user notes survive")
    const parsed = PermissionLocalStore.parse(next!.text)!
    expect(parsed.data.theme).toBe("dark")
    expect(parsed.data.permission).toEqual({
      bash: { "*": "deny", "npm test *": "allow" },
      edit: { "secrets/*": "deny" },
    })
  })

  test("merge reports no change for rules already present", () => {
    const text = JSON.stringify({ permission: { bash: { "git checkout *": "allow" } } })
    expect(PermissionLocalStore.merge(text, [allow("bash", "git checkout *")])).toEqual({ text, changed: false })
  })

  test("invalid JSON or an invalid permission shape does not parse or merge", () => {
    expect(PermissionLocalStore.parse("{ not json")).toBeUndefined()
    expect(PermissionLocalStore.parse(JSON.stringify({ permission: 5 }))).toBeUndefined()
    expect(PermissionLocalStore.parse(JSON.stringify({ permission: { bash: "maybe" } }))).toBeUndefined()
    expect(PermissionLocalStore.merge("{ not json", [allow("bash", "ls *")])).toBeUndefined()
  })

  test("parse expands home patterns like config does", () => {
    const parsed = PermissionLocalStore.parse(
      JSON.stringify({ permission: { external_directory: { "~/work/*": "allow" } } }),
    )
    expect(parsed?.rules[0]?.pattern.endsWith(path.join("work", "*"))).toBe(true)
    expect(parsed?.rules[0]?.pattern.startsWith("~")).toBe(false)
  })
})

describe("PermissionLocalStore", () => {
  it.instance(
    "add writes a 0600 file, excludes it from git once and serves the rules",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const local = yield* store

        expect(yield* local.rules()).toEqual([])
        expect(yield* local.add([allow("bash", "git checkout *")])).toBe(true)
        expect(yield* local.add([allow("webfetch", "example.com")])).toBe(true)
        expect(yield* local.file()).toBe(file(directory))

        const stat = yield* promise(() => fs.stat(file(directory)))
        if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o600)
        expect(yield* local.rules()).toEqual([allow("bash", "git checkout *"), allow("webfetch", "example.com")])

        const exclude = yield* promise(() => fs.readFile(path.join(directory, ".git", "info", "exclude"), "utf8"))
        expect(exclude.split("\n").filter((line) => line === PermissionLocalStore.EXCLUDE_LINE)).toHaveLength(1)
        const ignored = yield* promise(() =>
          $`git check-ignore .opencode/settings.local.json`.cwd(directory).quiet().nothrow(),
        )
        expect(ignored.exitCode).toBe(0)
        const leftovers = yield* promise(() => fs.readdir(path.dirname(file(directory))))
        expect(leftovers.filter((name) => name.endsWith(".tmp"))).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "rules follow external edits to the file",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const local = yield* store
        yield* local.add([allow("bash", "npm test *")])
        expect(yield* local.rules()).toEqual([allow("bash", "npm test *")])

        yield* promise(async () => {
          await Bun.sleep(5)
          await fs.writeFile(file(directory), JSON.stringify({ permission: { bash: { "bun test *": "allow" } } }))
        })
        expect(yield* local.rules()).toEqual([allow("bash", "bun test *")])

        yield* promise(() => fs.rm(file(directory)))
        expect(yield* local.rules()).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "a file tracked by git is ignored and never written",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const content = JSON.stringify({ permission: { bash: "allow" } })
        yield* promise(async () => {
          await fs.mkdir(path.dirname(file(directory)), { recursive: true })
          await fs.writeFile(file(directory), content)
          await $`git add -f .opencode/settings.local.json`.cwd(directory).quiet()
        })
        const local = yield* store
        expect(yield* local.rules()).toEqual([])
        expect(yield* local.add([allow("bash", "ls *")])).toBe(false)
        expect(yield* promise(() => fs.readFile(file(directory), "utf8"))).toBe(content)
      }),
    { git: true },
  )

  it.instance(
    "a symlinked file is ignored and never written through",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const target = path.join(directory, "elsewhere.json")
        const content = JSON.stringify({ permission: { bash: "allow" } })
        yield* promise(async () => {
          await fs.mkdir(path.dirname(file(directory)), { recursive: true })
          await fs.writeFile(target, content)
          await fs.symlink(target, file(directory))
        })
        const local = yield* store
        expect(yield* local.rules()).toEqual([])
        expect(yield* local.add([allow("bash", "ls *")])).toBe(false)
        expect(yield* promise(() => fs.readFile(target, "utf8"))).toBe(content)
      }),
    { git: true },
  )

  it.instance(
    "a corrupt file is ignored and not overwritten",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* promise(async () => {
          await fs.mkdir(path.dirname(file(directory)), { recursive: true })
          await fs.writeFile(file(directory), "{ not json")
        })
        const local = yield* store
        expect(yield* local.rules()).toEqual([])
        expect(yield* local.add([allow("bash", "ls *")])).toBe(false)
        expect(yield* promise(() => fs.readFile(file(directory), "utf8"))).toBe("{ not json")
      }),
    { git: true },
  )

  it.instance(
    "OPENCODE_DISABLE_PROJECT_CONFIG disables reading and writing",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* promise(async () => {
          await fs.mkdir(path.dirname(file(directory)), { recursive: true })
          await fs.writeFile(file(directory), JSON.stringify({ permission: { bash: "allow" } }))
        })
        const local = yield* store
        const previous = process.env.OPENCODE_DISABLE_PROJECT_CONFIG
        process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"
        const result = yield* Effect.all([local.rules(), local.add([allow("bash", "ls *")])]).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG
              else process.env.OPENCODE_DISABLE_PROJECT_CONFIG = previous
            }),
          ),
        )
        expect(result).toEqual([[], false])
      }),
    { git: true },
  )

  it.instance(
    "falls back to .opencode/.gitignore when info/exclude cannot be written",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* promise(async () => {
          const exclude = path.join(directory, ".git", "info", "exclude")
          await fs.rm(exclude, { force: true })
          await fs.mkdir(exclude, { recursive: true })
        })
        const local = yield* store
        expect(yield* local.add([allow("bash", "ls *")])).toBe(true)
        const gitignore = yield* promise(() => fs.readFile(path.join(directory, ".opencode", ".gitignore"), "utf8"))
        expect(gitignore.split("\n")).toContain(PermissionLocalStore.FILE)
      }),
    { git: true },
  )

  it.instance(
    "a file tracked in another letter case is ignored on a case-insensitive checkout",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const content = JSON.stringify({ permission: { bash: "allow" } })
        const upper = path.join(directory, ".OPENCODE", "settings.local.json")
        yield* promise(async () => {
          await fs.mkdir(path.dirname(upper), { recursive: true })
          await fs.writeFile(upper, content)
          await $`git add -f .OPENCODE/settings.local.json`.cwd(directory).quiet()
        })
        const caseInsensitive = yield* promise(() =>
          fs.stat(file(directory)).then(
            () => true,
            () => false,
          ),
        )
        if (!caseInsensitive) return
        const local = yield* store
        expect(yield* local.rules()).toEqual([])
        expect(yield* local.add([allow("bash", "ls *")])).toBe(false)
        expect(yield* promise(() => fs.readFile(upper, "utf8"))).toBe(content)
      }),
    { git: true },
  )

  it.instance(
    "a .opencode submodule is treated as tracked",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* promise(async () => {
          await fs.mkdir(path.dirname(file(directory)), { recursive: true })
          await fs.writeFile(file(directory), JSON.stringify({ permission: { bash: "allow" } }))
          const head = (await $`git rev-parse HEAD`.cwd(directory).quiet().text()).trim()
          await $`git update-index --add --cacheinfo 160000,${head},.opencode`.cwd(directory).quiet()
        })
        const local = yield* store
        expect(yield* local.rules()).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "the file is ignored while git cannot say whether it is tracked, and read once git answers",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const head = path.join(directory, ".git", "HEAD")
        const original = yield* promise(() => fs.readFile(head, "utf8"))
        yield* promise(async () => {
          await fs.mkdir(path.dirname(file(directory)), { recursive: true })
          await fs.writeFile(file(directory), JSON.stringify({ permission: { bash: { "ls *": "allow" } } }))
          await fs.writeFile(head, "garbage\n")
        })
        const local = yield* store
        expect(yield* local.rules()).toEqual([])
        expect(yield* local.add([allow("bash", "pwd")])).toBe(false)
        yield* promise(() => fs.writeFile(head, original))
        expect(yield* local.rules()).toEqual([allow("bash", "ls *")])
      }),
    { git: true },
  )

  it.instance(
    "concurrent adds keep every rule",
    () =>
      Effect.gen(function* () {
        const local = yield* store
        const patterns = Array.from({ length: 8 }, (_, i) => `cmd${i} *`)
        const results = yield* Effect.all(
          patterns.map((pattern) => local.add([allow("bash", pattern)])),
          { concurrency: "unbounded" },
        )
        expect(results.every(Boolean)).toBe(true)
        expect(yield* local.rules()).toEqual(expect.arrayContaining(patterns.map((pattern) => allow("bash", pattern))))
        expect((yield* local.rules()).length).toBe(patterns.length)
      }),
    { git: true },
  )

  test("trackedIn reads ls-files output case-insensitively and flags a .opencode gitlink", () => {
    const sha = "0967ef424bce6791893e9a57bb952f80fd536e93"
    expect(PermissionLocalStore.trackedIn("")).toBe(false)
    expect(PermissionLocalStore.trackedIn(`100644 ${sha} 0\t.opencode/opencode.json\n`)).toBe(false)
    expect(PermissionLocalStore.trackedIn(`100644 ${sha} 0\t.OPENCODE/Settings.Local.json\n`)).toBe(true)
    expect(PermissionLocalStore.trackedIn(`160000 ${sha} 0\t.opencode\n`)).toBe(true)
  })

  test("directories outside version control never share a global approvals file", () => {
    const a = PermissionLocalStore.globalFile("/tmp/one")
    expect(path.dirname(a)).toBe(path.join(Global.Path.data, "permission"))
    expect(a).not.toBe(PermissionLocalStore.globalFile("/tmp/two"))
    expect(a).not.toBe(path.join(Global.Path.data, "permission", "global.json"))
    expect(PermissionLocalStore.globalFile("/tmp/one/")).toBe(a)
  })

  it.instance("a project without git keeps its approvals in global data, keyed by its directory", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const local = yield* store
      const ctx = yield* InstanceState.context
      const expected = PermissionLocalStore.globalFile(ctx.directory)
      expect(String(ctx.project.id)).toBe("global")
      expect(yield* local.add([allow("bash", "ls *")])).toBe(true)
      expect(yield* local.file()).toBe(expected)
      expect(yield* local.file()).not.toBe(path.join(Global.Path.data, "permission", `${ctx.project.id}.json`))
      expect(yield* local.rules()).toEqual([allow("bash", "ls *")])
      expect(
        yield* promise(() =>
          fs.stat(path.join(directory, ".opencode")).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
      yield* promise(() => fs.rm(expected, { force: true }))
    }),
  )

  // Workspace trust: an untrusted repository's file is neither read nor written, and git never runs for it.
  const trustIn = (effective: WorkspaceTrust.Effective) =>
    TestConfig.make({
      trust: () => Effect.succeed({ ...TestConfig.trusted, state: { ...TestConfig.trusted.state, effective } }),
    })

  const spied = Effect.fnUntraced(function* (effective: WorkspaceTrust.Effective) {
    const real = yield* ChildProcessSpawner
    const calls: string[][] = []
    const spawner = ChildProcessSpawner.of({
      ...real,
      spawn: (command) => {
        if (command._tag === "StandardCommand") calls.push([command.command, ...command.args])
        return real.spawn(command)
      },
    })
    const local = yield* PermissionLocalStore.make({ fs: yield* FSUtil.Service, spawner, config: trustIn(effective) })
    return { local, calls }
  })

  it.instance(
    "a restricted repository neither reads nor writes the file and runs no git",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const content = JSON.stringify({ permission: { bash: { "curl *": "allow" } } })
        yield* promise(async () => {
          await fs.mkdir(path.dirname(file(directory)), { recursive: true })
          await fs.writeFile(file(directory), content)
        })
        const { local, calls } = yield* spied("restricted")
        expect(yield* local.rules()).toEqual([])
        expect(yield* local.add([allow("bash", "ls *")])).toBe(false)
        expect(calls).toEqual([])
        expect(yield* promise(() => fs.readFile(file(directory), "utf8"))).toBe(content)
      }),
    { git: true },
  )

  it.instance(
    "a headless run applies the untracked file after the tracked check, with fsmonitor disabled",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* promise(async () => {
          await fs.mkdir(path.dirname(file(directory)), { recursive: true })
          await fs.writeFile(file(directory), JSON.stringify({ permission: { bash: { "ls *": "allow" } } }))
        })
        const { local, calls } = yield* spied("headless")
        expect(yield* local.rules()).toEqual([allow("bash", "ls *")])
        const git = calls.filter((call) => call[0] === "git")
        expect(git.length).toBeGreaterThan(0)
        for (const call of git) expect(call.slice(1, 3)).toEqual(["-c", "core.fsmonitor=false"])
      }),
    { git: true },
  )
})
