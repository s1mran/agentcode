import { describe, expect, test } from "bun:test"
import { PermissionLaunchMode } from "@opencode-ai/core/permission/launch-mode"

describe("PermissionLaunchMode", () => {
  test("inherited drops only the launch mode and leaves the source alone", () => {
    const env = { PATH: "/bin", OPENCODE_PERMISSION_MODE: "bypassPermissions" }
    expect(PermissionLaunchMode.inherited(env)).toEqual({ PATH: "/bin" })
    expect(env.OPENCODE_PERMISSION_MODE).toBe("bypassPermissions")
  })

  test("read returns the variable while it is set", () => {
    const previous = process.env.OPENCODE_PERMISSION_MODE
    process.env.OPENCODE_PERMISSION_MODE = "plan"
    try {
      expect(PermissionLaunchMode.read()).toBe("plan")
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_PERMISSION_MODE
      else process.env.OPENCODE_PERMISSION_MODE = previous
    }
  })

  test("a claiming worker keeps the mode but spawns nothing that inherits it", async () => {
    const worker = new Worker(new URL("./fixture/launch-mode-worker.ts", import.meta.url), {
      env: { ...process.env, OPENCODE_PERMISSION_MODE: "bypassPermissions" },
    })
    try {
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout waiting for the worker")), 10_000)
        worker.onmessage = (event) => {
          clearTimeout(timer)
          resolve(event.data)
        }
        worker.onerror = (event) => {
          clearTimeout(timer)
          reject(event.error ?? new Error(event.message))
        }
      })
      expect(result).toEqual({
        // Without the claim a `{ ...process.env }` copy passes the mode on; this is what the claim prevents.
        beforeClaim: "bypassPermissions",
        env: null,
        read: "bypassPermissions",
        copied: "",
        shell: "",
        claimedTwice: "bypassPermissions",
      })
    } finally {
      worker.terminate()
    }
  })
})
