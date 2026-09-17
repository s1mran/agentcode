import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { text } from "node:stream/consumers"
import { spawn } from "../../src/lsp/launch"
import { tmpdir } from "../fixture/fixture"

describe("lsp.launch", () => {
  test("spawns cmd scripts with spaces on Windows", async () => {
    if (process.platform !== "win32") return

    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "with space")
    const file = path.join(dir, "echo cmd.cmd")

    await fs.mkdir(dir, { recursive: true })
    await Bun.write(file, "@echo off\r\nif %~1==--stdio exit /b 0\r\nexit /b 7\r\n")

    const proc = spawn(file, ["--stdio"])

    expect(await proc.exited).toBe(0)
  })

  test("does not pass the launch permission mode to the server", async () => {
    const previous = process.env.OPENCODE_PERMISSION_MODE
    process.env.OPENCODE_PERMISSION_MODE = "bypassPermissions"
    try {
      const script =
        "process.stdout.write(JSON.stringify([process.env.OPENCODE_PERMISSION_MODE ?? null, process.env.LSP_EXTRA ?? null]))"
      const inherited = spawn(process.execPath, ["-e", script])
      expect(JSON.parse(await text(inherited.stdout))).toEqual([null, null])
      expect(await inherited.exited).toBe(0)

      // Servers pass `{ ...process.env, ...extra }`; the extra variables still arrive.
      const merged = spawn(process.execPath, ["-e", script], { env: { ...process.env, LSP_EXTRA: "kept" } })
      expect(JSON.parse(await text(merged.stdout))).toEqual([null, "kept"])
      expect(await merged.exited).toBe(0)
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_PERMISSION_MODE
      else process.env.OPENCODE_PERMISSION_MODE = previous
    }
  })
})
