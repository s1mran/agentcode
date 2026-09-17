import { describe, expect, test } from "bun:test"
import { toggleMcp } from "./mcp"

describe("toggleMcp", () => {
  test("runs the status action before refreshing the owning query", async () => {
    const calls: string[] = []
    const input = (status: "connected" | "needs_auth" | "disabled") => ({
      status,
      connect: async () => {
        calls.push("connect")
      },
      disconnect: async () => {
        calls.push("disconnect")
      },
      authenticate: async () => {
        calls.push("authenticate")
      },
      refresh: async () => {
        calls.push("refresh")
      },
    })

    await toggleMcp(input("connected"))
    expect(calls).toEqual(["disconnect", "refresh"])

    calls.length = 0
    await toggleMcp(input("needs_auth"))
    expect(calls).toEqual(["authenticate", "refresh"])

    calls.length = 0
    await toggleMcp(input("disabled"))
    expect(calls).toEqual(["connect", "refresh"])
  })

  test("does not toggle a server while its connection is pending", async () => {
    const calls: string[] = []
    await toggleMcp({
      status: "pending",
      connect: async () => {
        calls.push("connect")
      },
      disconnect: async () => {
        calls.push("disconnect")
      },
      authenticate: async () => {
        calls.push("authenticate")
      },
      refresh: async () => {
        calls.push("refresh")
      },
    })
    expect(calls).toEqual([])
  })
})

describe("toggleMcp workspace trust", () => {
  test("a server pending approval or rejected never connects; approval is delegated", async () => {
    for (const status of ["pending_approval", "rejected"] as const) {
      const calls: string[] = []
      const record = (name: string) => async () => {
        calls.push(name)
      }
      await toggleMcp({
        status,
        connect: record("connect"),
        disconnect: record("disconnect"),
        authenticate: record("authenticate"),
        refresh: record("refresh"),
      })
      expect(calls).toEqual([])
      await toggleMcp({
        status,
        connect: record("connect"),
        disconnect: record("disconnect"),
        authenticate: record("authenticate"),
        refresh: record("refresh"),
        approve: record("approve"),
      })
      expect(calls).toEqual(["approve"])
    }
  })
})
