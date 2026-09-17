import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2"
import { applyLaunchPermissionMode, autoReplyAllowed, autoReplyTracker } from "../../src/context/permission-auto"

function assistant(input: { agent: string; permissionMode?: string }) {
  return { id: "msg_1", sessionID: "ses_1", role: "assistant", ...input } as unknown as Message
}

function lookup(input: { cached?: Message; fetched?: Message | Error }) {
  const fetches: string[] = []
  return {
    fetches,
    lookup: {
      cached: () => input.cached,
      fetch: (_sessionID: string, messageID: string) => {
        fetches.push(messageID)
        if (input.fetched instanceof Error) return Promise.reject(input.fetched)
        return Promise.resolve(input.fetched)
      },
    },
  }
}

const tool = { messageID: "msg_1", callID: "call_1" }

describe("autoReplyAllowed", () => {
  test("a floor request always needs a person, without looking up the message", async () => {
    const { fetches, lookup: l } = lookup({
      fetched: assistant({ agent: "build", permissionMode: "bypassPermissions" }),
    })
    const request = {
      sessionID: "ses_1",
      tool,
      guard: { level: "floor" as const, category: "protected_path" as const, reason: "writes to .git/config" },
    }
    expect(await autoReplyAllowed(request, l)).toBe(false)
    expect(fetches).toEqual([])
  })

  test("a request without a tool call is approved", async () => {
    expect(await autoReplyAllowed({ sessionID: "ses_1" }, lookup({}).lookup)).toBe(true)
  })

  test("a request raised in plan mode or by the plan agent is shown", async () => {
    const planMode = lookup({ cached: assistant({ agent: "build", permissionMode: "plan" }) })
    expect(await autoReplyAllowed({ sessionID: "ses_1", tool }, planMode.lookup)).toBe(false)
    expect(planMode.fetches).toEqual([])

    const planAgent = lookup({ fetched: assistant({ agent: "plan", permissionMode: "default" }) })
    expect(await autoReplyAllowed({ sessionID: "ses_1", tool }, planAgent.lookup)).toBe(false)
    expect(planAgent.fetches).toEqual(["msg_1"])
  })

  test("a build request is approved from the store or the server", async () => {
    expect(
      await autoReplyAllowed(
        { sessionID: "ses_1", tool },
        lookup({ cached: assistant({ agent: "build", permissionMode: "default" }) }).lookup,
      ),
    ).toBe(true)
    expect(
      await autoReplyAllowed(
        { sessionID: "ses_1", tool },
        lookup({ fetched: assistant({ agent: "build", permissionMode: "acceptEdits" }) }).lookup,
      ),
    ).toBe(true)
  })

  test("a message that cannot be read is shown to the user", async () => {
    expect(await autoReplyAllowed({ sessionID: "ses_1", tool }, lookup({}).lookup)).toBe(false)
    expect(await autoReplyAllowed({ sessionID: "ses_1", tool }, lookup({ fetched: new Error("offline") }).lookup)).toBe(
      false,
    )
    const user = { id: "msg_1", sessionID: "ses_1", role: "user", agent: "build" } as unknown as Message
    expect(await autoReplyAllowed({ sessionID: "ses_1", tool }, lookup({ cached: user }).lookup)).toBe(false)
  })
})

describe("autoReplyTracker", () => {
  test("applies the decision of a request nobody else answered", async () => {
    const tracker = autoReplyTracker()
    const applied: boolean[] = []
    await tracker.decide("per_1", Promise.resolve(false), (allowed) => applied.push(allowed))
    await tracker.decide("per_2", Promise.resolve(true), (allowed) => applied.push(allowed))
    expect(applied).toEqual([false, true])
  })

  test("drops the decision of a request answered while its lookup was running", async () => {
    const tracker = autoReplyTracker()
    const applied: string[] = []
    const lookup = Promise.withResolvers<boolean>()
    const other = Promise.withResolvers<boolean>()
    const stale = tracker.decide("per_1", lookup.promise, () => applied.push("per_1"))
    const live = tracker.decide("per_2", other.promise, () => applied.push("per_2"))

    tracker.replied("per_1")
    lookup.resolve(false)
    other.resolve(false)
    await Promise.all([stale, live])
    expect(applied).toEqual(["per_2"])

    // A later ask with the same id is decided again.
    await tracker.decide("per_1", Promise.resolve(false), () => applied.push("per_1 again"))
    expect(applied).toEqual(["per_2", "per_1 again"])
  })

  test("a failed decision shows the request instead of approving it", async () => {
    const tracker = autoReplyTracker()
    const applied: boolean[] = []
    await tracker.decide("per_1", Promise.reject(new Error("offline")), (allowed) => applied.push(allowed))
    expect(applied).toEqual([false])
  })
})

describe("applyLaunchPermissionMode", () => {
  test("sends nothing without a launch mode", async () => {
    const calls: unknown[] = []
    const update = (input: unknown) => {
      calls.push(input)
      return Promise.resolve({ data: {} })
    }
    expect(await applyLaunchPermissionMode(update, "ses_1", undefined)).toBeUndefined()
    expect(calls).toEqual([])
  })

  test("stores the mode on the opened session", async () => {
    const calls: unknown[] = []
    const update = (input: unknown) => {
      calls.push(input)
      return Promise.resolve({ data: {} })
    }
    expect(await applyLaunchPermissionMode(update, "ses_1", "acceptEdits")).toBeUndefined()
    expect(calls).toEqual([{ sessionID: "ses_1", permissionMode: "acceptEdits" }])
  })

  test("returns the server's refusal, a thrown error, or a generic message", async () => {
    const refused = () =>
      Promise.resolve({ error: { name: "BadRequest", data: { message: "bypassPermissions is disabled" } } })
    expect(await applyLaunchPermissionMode(refused, "ses_1", "bypassPermissions")).toBe("bypassPermissions is disabled")

    const thrown = () => Promise.reject(new Error("connection closed"))
    expect(await applyLaunchPermissionMode(thrown, "ses_1", "plan")).toBe("connection closed")

    const opaque = () => Promise.resolve({ error: "nope" })
    expect(await applyLaunchPermissionMode(opaque, "ses_1", "dontAsk")).toBe("permission mode dontAsk was not applied")
  })
})
