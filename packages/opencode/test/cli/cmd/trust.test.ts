// Subprocess tests for `agentcode trust` and `agentcode mcp reset-project-choices`. stdin is not a terminal here, so
// trusting requires --yes and fails fast without it.
import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"

const env = {
  OPENCODE_WORKSPACE_TRUST: "",
  OPENCODE_DISABLE_PROJECT_CONFIG: "false",
}

const setup = (home: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.join(home, "work", "project"), { recursive: true })
    // Decisions are keyed and displayed by real path (/var is /private/var on macOS).
    const project = await fs.realpath(path.join(home, "work", "project"))
    await fs.writeFile(
      path.join(project, "opencode.json"),
      JSON.stringify({
        permission: { bash: { "git *": "allow" } },
        mcp: { srv: { type: "local", command: ["not-a-real-mcp-server"], enabled: false } },
      }),
    )
    const store = path.join(home, ".local/share", "agentcode", "trust", "workspaces.json")
    const read = () =>
      fs
        .readFile(store, "utf8")
        .then(
          (text) => JSON.parse(text) as { workspaces: Record<string, { path: string; trusted: boolean; mcp: any }> },
        )
        .catch(() => undefined)
    const entry = async () => Object.values((await read())?.workspaces ?? {}).find((item) => item.path === project)
    return { project, store, read, entry }
  })

describe("agentcode trust", () => {
  cliIt.live(
    "requires --yes without a terminal, then persists, revokes, lists and forgets decisions",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const fx = yield* setup(home)
        const refused = yield* opencode.spawn(["trust", fx.project], { env, timeoutMs: 60_000 })
        expect(refused.exitCode).not.toBe(0)
        expect(refused.stderr + refused.stdout).toContain("pass --yes to trust non-interactively")
        expect(yield* Effect.promise(fx.read)).toBeUndefined()

        const trusted = yield* opencode.spawn(["trust", fx.project, "--yes"], { env, timeoutMs: 60_000 })
        opencode.expectExit(trusted, 0)
        expect(trusted.stderr + trusted.stdout).toContain("Allow rules:")
        const first = yield* Effect.promise(fx.entry)
        expect(first?.trusted).toBe(true)
        expect(Object.keys(first?.mcp.approved ?? {})).toEqual(["srv"])

        const status = yield* opencode.spawn(["trust", fx.project, "--status", "--format", "json"], {
          env,
          timeoutMs: 60_000,
        })
        opencode.expectExit(status, 0)
        const parsed = JSON.parse(status.stdout)
        expect(parsed).toMatchObject({ status: "trusted", effective: "full", policy: "prompt", held: [] })
        // A trusted folder's configuration loads: it is reported as supplied, never as held.
        expect(parsed.supplies).toContainEqual(expect.objectContaining({ kind: "mcp", name: "srv" }))

        const reset = yield* opencode.spawn(["mcp", "reset-project-choices"], {
          env,
          timeoutMs: 60_000,
        })
        opencode.expectExit(reset, 0)

        const resetHere = yield* opencode.spawn(["trust", fx.project, "--reset-mcp"], { env, timeoutMs: 60_000 })
        opencode.expectExit(resetHere, 0)
        expect((yield* Effect.promise(fx.entry))?.mcp).toEqual({ approved: {}, rejected: [] })

        const revoked = yield* opencode.spawn(["trust", fx.project, "--revoke"], { env, timeoutMs: 60_000 })
        opencode.expectExit(revoked, 0)
        expect((yield* Effect.promise(fx.entry))?.trusted).toBe(false)

        const listed = yield* opencode.spawn(["trust", "--list", "--format", "json"], { env, timeoutMs: 60_000 })
        opencode.expectExit(listed, 0)
        expect(JSON.parse(listed.stdout)).toContainEqual(expect.objectContaining({ path: fx.project, trusted: false }))

        const forgot = yield* opencode.spawn(["trust", fx.project, "--forget"], { env, timeoutMs: 60_000 })
        opencode.expectExit(forgot, 0)
        expect(yield* Effect.promise(fx.entry)).toBeUndefined()
      }),
    180_000,
  )
})
