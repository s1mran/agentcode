// Subprocess tests for workspace trust in `opencode run` (non-interactive). A run never prompts: it is headless by
// default (project plugins load, project allow rules do not, one stderr warning), --trust trusts for this run only,
// and OPENCODE_WORKSPACE_TRUST=untrusted holds the project's plugins. Nothing is ever written to the trust store.
import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Effect } from "effect"
import { cliIt, testModelID } from "../../lib/cli-process"

const exists = (file: string) =>
  fs
    .stat(file)
    .then(() => true)
    .catch(() => false)

const setup = (home: string) =>
  Effect.promise(async () => {
    const project = path.join(home, "project")
    const marker = path.join(home, "plugin-imported.txt")
    await fs.mkdir(project, { recursive: true })
    const plugin = path.join(project, "marker-plugin.ts")
    await fs.writeFile(
      plugin,
      `import fs from "fs"\nfs.writeFileSync(${JSON.stringify(marker)}, "imported")\nexport default async () => ({})\n`,
    )
    await fs.writeFile(
      path.join(project, "opencode.json"),
      JSON.stringify({ plugin: [pathToFileURL(plugin).href], permission: { bash: { "printf *": "allow" } } }),
    )
    return {
      project,
      marker,
      store: path.join(home, ".local/share", "agentcode", "trust", "workspaces.json"),
    }
  })

// The test process runs with OPENCODE_WORKSPACE_TRUST=trusted (test preload); an empty value restores the default.
const env = (extra: Record<string, string> = {}) => ({
  OPENCODE_WORKSPACE_TRUST: "",
  OPENCODE_PURE: "false",
  OPENCODE_DISABLE_PROJECT_CONFIG: "false",
  ...extra,
})

const args = (project: string, extra: string[] = []) => [
  "run",
  "--model",
  testModelID,
  "--dir",
  project,
  ...extra,
  "hi",
]

describe("opencode run workspace trust", () => {
  cliIt.live(
    "a non-interactive run is headless: plugins load, allow rules are ignored with a warning, nothing is saved",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const fx = yield* setup(home)
        yield* llm.text("done")
        const result = yield* opencode.spawn(args(fx.project), { env: env(), timeoutMs: 90_000 })
        opencode.expectExit(result, 0)
        expect(result.stderr).toContain("this workspace has not been trusted: 1 project allow rule ignored")
        expect(yield* Effect.promise(() => exists(fx.marker))).toBe(true)
        expect(yield* Effect.promise(() => exists(fx.store))).toBe(false)
      }),
    120_000,
  )

  cliIt.live(
    "--trust applies the project's allow rules for this run only, without a warning or a saved decision",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const fx = yield* setup(home)
        yield* llm.text("done")
        const result = yield* opencode.spawn(args(fx.project, ["--trust"]), { env: env(), timeoutMs: 90_000 })
        opencode.expectExit(result, 0)
        expect(result.stderr).not.toContain("has not been trusted")
        expect(yield* Effect.promise(() => exists(fx.store))).toBe(false)
      }),
    120_000,
  )

  cliIt.live(
    "OPENCODE_WORKSPACE_TRUST=untrusted holds the project's plugins",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const fx = yield* setup(home)
        yield* llm.text("done")
        const result = yield* opencode.spawn(args(fx.project), {
          env: env({ OPENCODE_WORKSPACE_TRUST: "untrusted" }),
          timeoutMs: 90_000,
        })
        opencode.expectExit(result, 0)
        expect(result.stderr).toContain("restricted mode")
        expect(yield* Effect.promise(() => exists(fx.marker))).toBe(false)
      }),
    120_000,
  )

  cliIt.live(
    "--trust with --attach is refused instead of silently doing nothing on the attached server",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const fx = yield* setup(home)
        const result = yield* opencode.spawn(
          ["run", "--attach", "http://127.0.0.1:9", "--dir", fx.project, "--trust", "hi"],
          { env: env(), timeoutMs: 60_000 },
        )
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr + result.stdout).toContain("--trust cannot be used with --attach")
      }),
    90_000,
  )
})
