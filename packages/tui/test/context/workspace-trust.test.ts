import { describe, expect, test } from "bun:test"
import type { TrustHeldItem } from "@opencode-ai/sdk/v2"
import { isHeldMcpStatus, shouldAskTrust, trustPayload, trustSummary } from "../../src/context/workspace-trust"

const held: TrustHeldItem[] = [
  { kind: "plugin", spec: "a", source: "/repo" },
  { kind: "plugin", spec: "b", source: "/repo" },
  {
    kind: "mcp",
    name: "github",
    type: "local",
    command: ["npx", "server"],
    source: "/repo/opencode.json",
    reason: "untrusted",
    fingerprint: "f",
  },
  { kind: "permission", permission: "bash", pattern: "git *", source: "/repo/opencode.json" },
]

describe("tui workspace trust", () => {
  test("asks only about an undecided folder under the prompt policy", () => {
    expect(shouldAskTrust({ status: "unknown", policy: "prompt" })).toBe(true)
    expect(shouldAskTrust({ status: "trusted", policy: "prompt" })).toBe(false)
    expect(shouldAskTrust({ status: "untrusted", policy: "prompt" })).toBe(false)
    expect(shouldAskTrust({ status: "unknown", policy: "trusted" })).toBe(false)
    expect(shouldAskTrust(undefined)).toBe(false)
  })

  test("summarizes held items and builds the decision body", () => {
    expect(trustSummary(held)).toEqual(["2 plugins", "1 MCP server: github", "1 allow rule"])
    expect(trustPayload("trust", { held, sessionOnly: false })).toEqual({
      trusted: true,
      remember: true,
      mcp: { approve: ["github"] },
    })
    expect(trustPayload("restricted", { held, sessionOnly: true })).toEqual({ trusted: false, remember: false })
  })

  test("held MCP statuses are never toggled", () => {
    expect(isHeldMcpStatus("pending_approval")).toBe(true)
    expect(isHeldMcpStatus("rejected")).toBe(true)
    expect(isHeldMcpStatus("disabled")).toBe(false)
  })
})
