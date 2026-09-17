import { describe, expect, test } from "bun:test"
import { advertisesPermissionModes, detectPermissionModes } from "./permission-modes"

const noWait = () => Promise.resolve()

describe("detectPermissionModes", () => {
  test("a v1 server that advertises permissionModes supports modes", async () => {
    const result = await detectPermissionModes({
      protocol: Promise.resolve("v1"),
      health: async () => ({ healthy: true, version: "1.0.0", permissionModes: true }),
      wait: noWait,
    })
    expect(result).toBe(true)
  })

  test("a stock v1 server without the flag does not support modes", async () => {
    const result = await detectPermissionModes({
      protocol: Promise.resolve("v1"),
      health: async () => ({ healthy: true, version: "1.18.4" }),
      wait: noWait,
    })
    expect(result).toBe(false)
  })

  test("v2 servers never support modes and are not probed", async () => {
    let probes = 0
    const result = await detectPermissionModes({
      protocol: Promise.resolve("v2"),
      health: async () => {
        probes++
        return { permissionModes: true }
      },
      wait: noWait,
    })
    expect(result).toBe(false)
    expect(probes).toBe(0)
  })

  test("retries a failed health request, but not an answer without the flag", async () => {
    let probes = 0
    const result = await detectPermissionModes({
      protocol: Promise.resolve("v1"),
      health: async () => {
        probes++
        if (probes < 3) throw new Error("starting")
        return { healthy: true, permissionModes: true }
      },
      wait: noWait,
    })
    expect(result).toBe(true)
    expect(probes).toBe(3)
  })

  test("gives up after the attempts run out", async () => {
    const result = await detectPermissionModes({
      protocol: Promise.resolve("v1"),
      health: async () => {
        throw new Error("down")
      },
      attempts: 2,
      wait: noWait,
    })
    expect(result).toBe(false)
  })

  test("only a health body with permissionModes true counts", () => {
    expect(advertisesPermissionModes({ healthy: true, version: "1.18.4" })).toBe(false)
    expect(advertisesPermissionModes(undefined)).toBe(false)
    expect(advertisesPermissionModes({ permissionModes: true })).toBe(true)
  })
})
