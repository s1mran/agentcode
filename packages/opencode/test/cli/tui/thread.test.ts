import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import yargs from "yargs"
import { tmpdir } from "../../fixture/fixture"
import { TuiThreadCommand, resolveThreadDirectory } from "../../../src/cli/cmd/tui"
import { cliIt } from "../../lib/cli-process"

describe("tui thread", () => {
  test("loads the TUI integration lazily", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui.ts", import.meta.url)).text()

    expect(source).toContain('await import("../tui/layer")')
    expect(source).toMatch(/await import\(["']@\/plugin\/tui\/runtime["']\)/)
    expect(source).not.toContain('import("./app")')
  })

  test("forwards the CLI environment to the TUI worker", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui.ts", import.meta.url)).text()

    // workerEnv copies every defined variable and adds only an explicit --permission-mode (see run-permission-mode.test).
    expect(source).toMatch(/new Worker\(file, \{\s*env: workerEnv\(process\.env, permission\.mode\)/)
    expect(source).toMatch(/Object\.fromEntries\(\s*Object\.entries\(env\)/)
  })

  async function check(project?: string) {
    await using tmp = await tmpdir({ git: true })
    const link = path.join(path.dirname(tmp.path), path.basename(tmp.path) + "-link")
    const type = process.platform === "win32" ? "junction" : "dir"

    try {
      await fs.symlink(tmp.path, link, type)
      expect(resolveThreadDirectory(project, link, tmp.path)).toBe(tmp.path)
    } finally {
      await fs.rm(link, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  test("uses the real cwd when PWD points at a symlink", async () => {
    await check()
  })

  test("uses the real cwd after resolving a relative project from PWD", async () => {
    await check(".")
  })

  test("resolves a relative mini project from PWD when cwd differs", async () => {
    await using pwd = await tmpdir({ git: true })
    await using cwd = await tmpdir({ git: true })

    expect(resolveThreadDirectory(".", pwd.path, cwd.path)).toBe(pwd.path)
    expect(resolveThreadDirectory(undefined, pwd.path, cwd.path)).toBe(cwd.path)
  })

  test("parses supported --no-replay forms", async () => {
    for (const option of ["--no-replay", "--no-replay=true", "--noReplay"]) {
      const args = await yargs([])
        .command({ ...TuiThreadCommand, handler: () => {} })
        .exitProcess(false)
        .parse(["--mini", option, "--replay-limit", "10"])

      expect(args.replay === false || args.noReplay === true).toBe(true)
      expect(args.replayLimit).toBe(10)
    }
  })

  test("preserves boolean negation for existing options", async () => {
    const args = await yargs([])
      .command({ ...TuiThreadCommand, handler: () => {} })
      .exitProcess(false)
      .parse(["--mdns", "--no-mdns"])

    expect(args.mdns).toBe(false)
  })

  cliIt.live("rejects mini-only options without --mini", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["--replay-limit", "10"])

      opencode.expectExit(result, 1)
      expect(result.stderr).toContain("--replay-limit requires --mini")
    }),
  )

  cliIt.live("routes attached sessions to mini mode", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["attach", "http://127.0.0.1:1", "--mini"])

      opencode.expectExit(result, 1)
      expect(result.stderr).toContain("--mini requires a TTY stdout")
    }),
  )

  cliIt.live("rejects network options in mini mode", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["--mini", "--port", "4096"])

      opencode.expectExit(result, 1)
      expect(result.stderr).toContain("--port cannot be used with --mini")
    }),
  )
})

describe("tui worker workspace trust", () => {
  test("the worker claims OPENCODE_WORKSPACE_TRUST at startup, and the launcher forwards a claimed policy", async () => {
    const worker = await Bun.file(new URL("../../../src/cli/tui/worker.ts", import.meta.url)).text()
    expect(worker).toContain("WorkspaceTrustLaunch.claim()")
    const index = await Bun.file(new URL("../../../src/index.ts", import.meta.url)).text()
    expect(index).toContain("WorkspaceTrustLaunch.claim()")

    const { WorkspaceTrustLaunch } = await import("@opencode-ai/core/trust/launch")
    const { workerEnv } = await import("../../../src/cli/cmd/tui")
    const previous = process.env.OPENCODE_WORKSPACE_TRUST
    process.env.OPENCODE_WORKSPACE_TRUST = "untrusted"
    try {
      WorkspaceTrustLaunch.claim()
      expect(process.env.OPENCODE_WORKSPACE_TRUST).toBeUndefined()
      expect(WorkspaceTrustLaunch.inherited({ PATH: "/bin", OPENCODE_WORKSPACE_TRUST: "x" })).toEqual({ PATH: "/bin" })
      expect(workerEnv({ PATH: "/bin" }, undefined)).toEqual({ PATH: "/bin", OPENCODE_WORKSPACE_TRUST: "untrusted" })
      expect(WorkspaceTrustLaunch.read()).toBe("untrusted")
    } finally {
      WorkspaceTrustLaunch.reset()
      if (previous === undefined) delete process.env.OPENCODE_WORKSPACE_TRUST
      else process.env.OPENCODE_WORKSPACE_TRUST = previous
    }
  })
})
