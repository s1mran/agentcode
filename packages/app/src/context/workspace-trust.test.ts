import { describe, expect, test } from "bun:test"
import type { TrustHeldItem } from "@opencode-ai/sdk/v2/client"
import {
  advertisesWorkspaceTrust,
  groupHeld,
  isRestricted,
  queuedTrustDialogApplies,
  serverWorkspaceTrust,
  trustDialogs,
  shouldAskTrust,
  trustPayload,
  trustPrompts,
} from "./workspace-trust"

const held: TrustHeldItem[] = [
  { kind: "plugin", spec: "file:///repo/.opencode/plugins/a.ts", source: "/repo/.opencode" },
  {
    kind: "mcp",
    name: "keep",
    type: "local",
    command: ["node", "a.js"],
    source: "/repo/opencode.json",
    reason: "untrusted",
    fingerprint: "a",
  },
  {
    kind: "mcp",
    name: "drop",
    type: "remote",
    url: "https://mcp.example",
    source: "/repo/opencode.json",
    reason: "untrusted",
    fingerprint: "b",
  },
  { kind: "permission", permission: "bash", pattern: "git *", source: "/repo/opencode.json" },
]

describe("workspace trust gate", () => {
  test("asks only for an unknown folder under the prompt policy on a server that advertises trust, once", () => {
    const unknown = { status: "unknown", policy: "prompt" } as const
    expect(shouldAskTrust({ supported: true, info: unknown, asked: false })).toBe(true)
    expect(shouldAskTrust({ supported: true, info: unknown, asked: true })).toBe(false)
    expect(shouldAskTrust({ supported: false, info: unknown, asked: false })).toBe(false)
    expect(shouldAskTrust({ supported: true, info: { status: "trusted", policy: "prompt" }, asked: false })).toBe(false)
    expect(shouldAskTrust({ supported: true, info: { status: "untrusted", policy: "prompt" }, asked: false })).toBe(
      false,
    )
    expect(shouldAskTrust({ supported: true, info: { status: "unknown", policy: "headless" }, asked: false })).toBe(
      false,
    )
    expect(shouldAskTrust({ supported: true, info: undefined, asked: false })).toBe(false)

    const key = trustPrompts.key("scope", "/repo")
    expect(trustPrompts.has(key)).toBe(false)
    trustPrompts.add(key)
    expect(trustPrompts.has(key)).toBe(true)
  })

  test("restricted only on servers that advertise trust", () => {
    expect(isRestricted({ supported: true, info: { effective: "restricted" } })).toBe(true)
    expect(isRestricted({ supported: false, info: { effective: "restricted" } })).toBe(false)
    expect(isRestricted({ supported: true, info: { effective: "full" } })).toBe(false)
  })

  test("Trust folder approves checked servers and rejects unchecked ones; Restricted sends only the decision", () => {
    expect(trustPayload({ trusted: true, sessionOnly: false, held, unchecked: new Set(["drop"]) })).toEqual({
      trusted: true,
      remember: true,
      mcp: { approve: ["keep"], reject: ["drop"] },
    })
    expect(trustPayload({ trusted: false, sessionOnly: false, held, unchecked: new Set() })).toEqual({
      trusted: false,
      remember: true,
    })
    // The home folder is trusted for the session only.
    expect(trustPayload({ trusted: true, sessionOnly: true, held: [], unchecked: new Set() })).toEqual({
      trusted: true,
      remember: false,
      mcp: { approve: [], reject: [] },
    })
  })

  test("groups held items for the dialog", () => {
    const groups = groupHeld(held)
    expect(groups.code.map((item) => item.kind)).toEqual(["plugin"])
    expect(groups.mcp.map((item) => item.name)).toEqual(["keep", "drop"])
    expect(groups.permission).toHaveLength(1)
    expect(groups.command).toEqual([])
  })

  test("detects the capability from the health body, never on v2 or servers without the flag", async () => {
    expect(advertisesWorkspaceTrust({ workspaceTrust: true })).toBe(true)
    expect(advertisesWorkspaceTrust({ healthy: true, version: "1" })).toBe(false)
    const server = (protocol: "v1" | "v2", body: object) => ({
      protocol: Promise.resolve(protocol),
      client: { global: { health: () => Promise.resolve({ data: body as never }) } },
    })
    expect(await serverWorkspaceTrust(server("v1", { healthy: true, workspaceTrust: true }))).toBe(true)
    expect(await serverWorkspaceTrust(server("v1", { healthy: true }))).toBe(false)
    expect(await serverWorkspaceTrust(server("v2", { healthy: true, workspaceTrust: true }))).toBe(false)
  })
})

describe("queued trust dialogs", () => {
  test("a queued ask is dropped once another folder of the same repository was decided", () => {
    const unknown = { status: "unknown", policy: "prompt", effective: "restricted" } as const
    expect(queuedTrustDialogApplies({ automatic: true, fresh: unknown })).toBe(true)
    // The first worktree's dialog trusted the repository: the second one must not ask (and overwrite) again.
    expect(
      queuedTrustDialogApplies({ automatic: true, fresh: { status: "trusted", policy: "prompt", effective: "full" } }),
    ).toBe(false)
    expect(
      queuedTrustDialogApplies({
        automatic: true,
        fresh: { status: "untrusted", policy: "prompt", effective: "restricted" },
      }),
    ).toBe(false)
    expect(queuedTrustDialogApplies({ automatic: true })).toBe(false)
    // Opened from the restricted notice: still shown while restricted, dropped once trusted.
    expect(
      queuedTrustDialogApplies({
        automatic: false,
        fresh: { status: "untrusted", policy: "prompt", effective: "restricted" },
      }),
    ).toBe(true)
    expect(
      queuedTrustDialogApplies({ automatic: false, fresh: { status: "trusted", policy: "prompt", effective: "full" } }),
    ).toBe(false)
  })

  test("folders sharing one trust root queue a single dialog", () => {
    expect(trustDialogs.claim("/repo")).toBe(true)
    expect(trustDialogs.claim("/repo")).toBe(false)
    expect(trustDialogs.claim("/other")).toBe(true)
    trustDialogs.release("/repo")
    trustDialogs.release("/other")
    expect(trustDialogs.claim("/repo")).toBe(true)
    trustDialogs.release("/repo")
  })
})
