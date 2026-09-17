import { describe, expect, test } from "bun:test"
import type { Message, Part as PartType } from "@opencode-ai/sdk/v2"
import { checkpointNotice, unrestorableCounts } from "./checkpoint-notice"

const patch = (id: string, messageID: string, extra: Partial<Extract<PartType, { type: "patch" }>> = {}) =>
  ({ id, sessionID: "ses_1", messageID, type: "patch", hash: "abc", files: [], ...extra }) as PartType

const message = (id: string, role: "user" | "assistant") => ({ id, sessionID: "ses_1", role }) as Message

describe("checkpointNotice", () => {
  test("ignores non-patch parts and patch parts without skipped files", () => {
    expect(
      checkpointNotice({ id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "hi" } as PartType),
    ).toBeUndefined()
    expect(checkpointNotice(patch("prt_2", "msg_1", { files: ["/p/a.txt"] }))).toBeUndefined()
    expect(checkpointNotice(patch("prt_3", "msg_1", { skipped: [] }))).toBeUndefined()
  })

  test("returns skipped files and the off reason", () => {
    expect(
      checkpointNotice(
        patch("prt_4", "msg_1", {
          hash: "",
          skipped: [{ file: "/home/me/a.txt", reason: "unavailable" }],
          unavailable: "home",
        }),
      ),
    ).toEqual({ unavailable: "home", skipped: [{ file: "/home/me/a.txt", reason: "unavailable" }] })
  })
})

describe("unrestorableCounts", () => {
  const messages = [
    message("msg_01", "user"),
    message("msg_02", "assistant"),
    message("msg_03", "user"),
    message("msg_04", "assistant"),
    message("msg_05", "assistant"),
  ]
  const parts = {
    msg_02: [patch("prt_a", "msg_02", { skipped: [{ file: "/p/early.bin", reason: "large" }] })],
    msg_04: [
      patch("prt_b", "msg_04", {
        skipped: [
          { file: "/p/big.bin", reason: "large" },
          { file: "/p/node_modules/x.js", reason: "ignored" },
        ],
      }),
    ],
    msg_05: [
      patch("prt_c", "msg_05", { skipped: [{ file: "/p/big.bin", reason: "large" }] }),
      patch("prt_d", "msg_05", { files: ["/p/a.txt"] }),
    ],
  }

  test("dedupes files and counts only messages at or after the user message", () => {
    const counts = unrestorableCounts(messages, parts)
    expect(counts.get("msg_03")).toBe(2)
    expect(counts.get("msg_01")).toBe(3)
    expect(unrestorableCounts(messages.toReversed(), parts)).toEqual(counts)
  })

  test("is zero when nothing was skipped", () => {
    const counts = unrestorableCounts(messages, { msg_04: [patch("prt_e", "msg_04", { files: ["/p/a.txt"] })] })
    expect(counts.get("msg_01")).toBe(0)
    expect(counts.get("msg_03")).toBe(0)
  })

  test("reads each assistant message's parts once for the whole session", () => {
    const long = Array.from({ length: 200 }, (_, i) =>
      message(`msg_${String(i).padStart(4, "0")}`, i % 2 === 0 ? "user" : "assistant"),
    )
    let reads = 0
    const tracked = new Proxy({} as Record<string, PartType[]>, {
      get: (_, key) => {
        reads += 1
        return key === "msg_0199"
          ? [patch("prt_z", "msg_0199", { skipped: [{ file: "/p/z.bin", reason: "large" }] })]
          : []
      },
    })
    const counts = unrestorableCounts(long, tracked)
    expect(reads).toBe(100)
    expect(counts.get("msg_0000")).toBe(1)
    expect(counts.size).toBe(100)
  })
})
