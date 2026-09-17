import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Deferred, Effect, Fiber } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { FileReads } from "../../src/session/file-reads"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(FileReads.node))

const view = (input: Partial<FileReads.View> = {}): FileReads.View => ({
  file: "/tmp/x.txt",
  mtimeMs: 1,
  size: 10,
  ranges: [],
  full: false,
  source: "read",
  time: 1,
  ...input,
})

const tmp = () =>
  Effect.acquireRelease(
    Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "file-reads-"))),
    (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
  )

type Part = Record<string, unknown>
const message = (id: string, created: number, parts: Part[]) =>
  ({
    info: { id, sessionID: "ses_a", role: "assistant", time: { created } },
    parts,
  }) as unknown as SessionV1.WithParts

const toolPart = (ledger: FileReads.View[], compacted?: number): Part => ({
  type: "tool",
  tool: "read",
  state: {
    status: "completed",
    input: {},
    output: "",
    title: "",
    metadata: { ledger },
    time: { start: 1, end: 2, ...(compacted ? { compacted } : {}) },
  },
})

describe("FileReads helpers", () => {
  test("countLines matches the read tool's line splitting", () => {
    expect(FileReads.countLines("")).toBe(0)
    expect(FileReads.countLines("a")).toBe(1)
    expect(FileReads.countLines("a\n")).toBe(1)
    expect(FileReads.countLines("a\n\nb")).toBe(3)
    expect(FileReads.countLines("a\r\nb\r\n")).toBe(2)
    expect(FileReads.countLines("a\rb")).toBe(2)
    expect(FileReads.countLines("\n")).toBe(1)
  })

  test("merge unions ranges of one version and replaces a different version", () => {
    const first = view({ ranges: [[1, 2000]], lines: 3500 })
    const second = view({ ranges: [[2001, 3500]], lines: 3500, time: 2 })
    const merged = FileReads.merge(first, second)
    expect(merged.full).toBe(true)

    const other = view({ ranges: [[2001, 3500]], lines: 3500, mtimeMs: 5, size: 11, time: 2 })
    const replaced = FileReads.merge(first, other)
    expect(replaced.full).toBe(false)
    expect(replaced.ranges).toEqual([[2001, 3500]])

    const hashed = FileReads.merge(
      view({ ranges: [[1, 2]], hash: "abc", mtimeMs: 1 }),
      view({ ranges: [[3, 4]], hash: "abc", mtimeMs: 9 }),
    )
    expect(hashed.ranges).toEqual([[1, 4]])
  })

  test("touched and covers", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`)
    const text = lines.join("\n") + "\n"
    const replaced = text.replace("line 50\n", "changed\n")
    expect(FileReads.touched(text, replaced)).toEqual([50])
    const inserted = text.replace("line 10\n", "line 10\nnew\n")
    expect(FileReads.touched(text, inserted)).toEqual([10])
    const removed = text.replace("line 3\nline 4\nline 5\n", "")
    expect(FileReads.touched(text, removed)).toEqual([3, 4, 5])
    // A pure insertion needs either neighbour: the line below it counts when that one was read.
    expect(FileReads.touched(text, inserted, { full: false, ranges: [[11, 20]] })).toEqual([11])
    expect(FileReads.touched(text, inserted, { full: false, ranges: [[1, 10]] })).toEqual([10])
    expect(FileReads.touched(text, inserted, { full: false, ranges: [[30, 40]] })).toEqual([10])
    expect(FileReads.covers({ full: false, ranges: [[40, 60]] }, [50])).toBe(true)
    expect(FileReads.covers({ full: false, ranges: [[40, 60]] }, [70])).toBe(false)
    expect(FileReads.covers({ full: true, ranges: [] }, [70])).toBe(true)
  })

  test("remap keeps seen lines through authored and formatter changes", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n") + "\n"
    const inserted = before.replace("l5\n", "l5\na\nb\nc\n")
    const authored = FileReads.remap(view({ ranges: [[1, 10]] }), before, inserted, true)
    expect(authored.ranges).toEqual([[1, 13]])

    // An unauthored hunk that rewrites a seen line into two lines stays seen, a full view stays full.
    const formatted = before.replace("l2\n", "l2a\nl2b\n")
    expect(FileReads.remap(view({ ranges: [[1, 10]] }), before, formatted, false).ranges).toEqual([[1, 11]])
    expect(FileReads.remap(view({ full: true }), before, formatted, false).full).toBe(true)

    // An unauthored hunk over an unseen line is not seen.
    const unseen = before.replace("l20\n", "x20\n")
    expect(FileReads.remap(view({ ranges: [[1, 10]] }), before, unseen, false).ranges).toEqual([[1, 10]])
  })

  test("shellView maps viewer output to lines", () => {
    expect(FileReads.shellView("cat", ["cat", "f"], "", 30)).toBe("full")
    expect(FileReads.shellView("head", ["head", "-n", "20", "f"], "", 30)).toEqual([[1, 20]])
    expect(FileReads.shellView("head", ["head", "f"], "", 30)).toEqual([[1, 10]])
    expect(FileReads.shellView("head", ["head", "-c", "5", "f"], "", 30)).toBeUndefined()
    expect(FileReads.shellView("tail", ["tail", "-n", "+5", "f"], "", 30)).toEqual([[5, 30]])
    expect(FileReads.shellView("tail", ["tail", "-3", "f"], "", 30)).toEqual([[28, 30]])
    expect(FileReads.shellView("sed", ["sed", "-n", "10,20p", "f"], "", 30)).toEqual([[10, 20]])
    expect(FileReads.shellView("sed", ["sed", "-n", "5,$p", "f"], "", 30)).toEqual([[5, 30]])
    expect(FileReads.shellView("grep", ["grep", "-n", "foo", "f"], "3:foo\n7-bar", 30)).toEqual([
      [3, 3],
      [7, 7],
    ])
    expect(FileReads.shellView("grep", ["grep", "foo", "f"], "foo", 30)).toBeUndefined()
    expect(FileReads.shellView("grep", ["grep", "-c", "foo", "f"], "3", 30)).toBeUndefined()
    expect(FileReads.shellView("cat", ["cat", "-v", "f"], "", 30)).toBeUndefined()
    expect(FileReads.shellView("rg", ["rg", "-n", "foo", "f"], "2:foo", 30)).toEqual([[2, 2]])
    expect(FileReads.shellView("rg", ["rg", "-n", "-r", "x", "foo", "f"], "2:x", 30)).toBeUndefined()
  })

  test("printed checks the claimed lines really reached the output", () => {
    const text = "alpha\nbeta x\n\ngamma\n"
    expect(FileReads.printed("alpha\nbeta x\n\ngamma\n", text, [[1, 4]])).toBe(true)
    expect(FileReads.printed("     1\talpha\n     2\tbeta x\n", text, [[1, 2]])).toBe(true)
    expect(
      FileReads.printed("2:beta x\n4:gamma\n", text, [
        [2, 2],
        [4, 4],
      ]),
    ).toBe(true)
    expect(FileReads.printed("(no output)", text, [[1, 4]])).toBe(false)
    expect(
      FileReads.printed("gamma\nalpha\n", text, [
        [1, 1],
        [4, 4],
      ]),
    ).toBe(false)
    expect(FileReads.printed("alpha\n", text, [[1, 2]])).toBe(false)
  })
  test("messages name the missing lines", () => {
    expect(FileReads.partialError("/f", { ranges: [[1, 100]] }, [2500])).toContain("only read lines 1-100")
    expect(FileReads.partialError("/f", { ranges: [[1, 100]] })).toContain("read the whole file")
    // After a compaction the read is gone from context, not necessarily never made.
    expect(FileReads.unreadError("/f", "edit")).toContain("no longer in your context")
  })
})

describe("FileReads service", () => {
  it.live("status reads views from history", () =>
    Effect.gen(function* () {
      const reads = yield* FileReads.Service
      const file = FileReads.key("/tmp/ledger-history.txt")
      const seen = view({ file, full: true, hash: "h1", lines: 3 })
      const ctx = { sessionID: "ses_a", messageID: "msg_now" }
      const current = { mtimeMs: 1, size: 10, hash: "h1" }

      expect(
        (yield* reads.status({ ...ctx, messages: [message("msg_1", 1, [toolPart([seen])])] }, file, current)).kind,
      ).toBe("fresh")
      expect(
        (yield* reads.status({ ...ctx, messages: [message("msg_1", 1, [toolPart([seen], 5)])] }, file, current)).kind,
      ).toBe("unread")
      expect(
        (yield* reads.status(
          { ...ctx, messages: [message("msg_1", 1, [toolPart([{ ...seen, source: "write" }], 5)])] },
          file,
          current,
        )).kind,
      ).toBe("fresh")
      const synthetic = { type: "text", synthetic: true, text: "", metadata: { ledger: [seen] } }
      expect((yield* reads.status({ ...ctx, messages: [message("msg_1", 1, [synthetic])] }, file, current)).kind).toBe(
        "fresh",
      )

      // Compaction reorders messages: the newest view still wins.
      const older = view({ file, full: true, hash: "h0", lines: 3, time: 1 })
      const newer = view({ file, full: true, hash: "h1", lines: 3, time: 9 })
      const messages = [message("msg_2", 9, [toolPart([newer])]), message("msg_1", 1, [toolPart([older])])]
      expect((yield* reads.status({ ...ctx, messages }, file, current)).kind).toBe("fresh")
      expect(FileReads.scan(messages)).toBe(FileReads.scan(messages))
    }),
  )

  it.live("overlay entries count only while their message is visible, per session", () =>
    Effect.gen(function* () {
      const reads = yield* FileReads.Service
      const file = FileReads.key("/tmp/ledger-overlay.txt")
      const current = { mtimeMs: 1, size: 10, hash: "h1" }
      const m1 = [message("msg_1", 1, [])]
      yield* reads.record({ sessionID: "ses_a", messageID: "msg_2" }, [view({ file, full: true, hash: "h1" })])

      expect((yield* reads.status({ sessionID: "ses_b", messageID: "msg_2", messages: m1 }, file, current)).kind).toBe(
        "unread",
      )
      expect((yield* reads.status({ sessionID: "ses_a", messageID: "msg_2", messages: m1 }, file, current)).kind).toBe(
        "fresh",
      )
      // msg_2 was reverted: the next step no longer sees it.
      expect((yield* reads.status({ sessionID: "ses_a", messageID: "msg_3", messages: m1 }, file, current)).kind).toBe(
        "unread",
      )
      expect((yield* reads.status({ sessionID: "ses_a", messageID: "msg_2", messages: m1 }, file, current)).kind).toBe(
        "unread",
      )
    }),
  )

  it.live("an overlay entry stops counting once its step is over, so a pruned result is unread", () =>
    Effect.gen(function* () {
      const reads = yield* FileReads.Service
      const file = FileReads.key("/tmp/ledger-pruned.txt")
      const current = { mtimeMs: 1, size: 10, hash: "h1" }
      const seen = view({ file, full: true, hash: "h1" })
      yield* reads.record({ sessionID: "ses_prune", messageID: "msg_2" }, [seen])

      // The next step sees msg_2 in history with its read result pruned: same answer as after a restart.
      const pruned = [message("msg_2", 2, [toolPart([seen], 5)])]
      expect(
        (yield* reads.status({ sessionID: "ses_prune", messageID: "msg_3", messages: pruned }, file, current)).kind,
      ).toBe("unread")
      const kept = [message("msg_2", 2, [toolPart([seen])])]
      expect(
        (yield* reads.status({ sessionID: "ses_prune", messageID: "msg_3", messages: kept }, file, current)).kind,
      ).toBe("fresh")
    }),
  )

  it.live("status tells a touch from a real change", () =>
    Effect.gen(function* () {
      const reads = yield* FileReads.Service
      const dir = yield* tmp()
      const file = path.join(dir, "a.txt")
      yield* Effect.promise(() => fs.writeFile(file, "one\ntwo\n"))
      const snap = yield* reads.snapshot(file)
      const ctx = { sessionID: "ses_touch", messageID: "msg_1", messages: [] }
      yield* reads.record(ctx, [
        view({ file: FileReads.key(file), mtimeMs: snap.mtimeMs, size: snap.size, hash: snap.hash, full: true }),
      ])

      yield* Effect.promise(() => fs.utimes(file, new Date(), new Date(Date.now() + 5000)))
      expect((yield* reads.status(ctx, file, yield* reads.snapshot(file))).kind).toBe("fresh")

      yield* Effect.promise(() => fs.writeFile(file, "one\nTWO\n"))
      expect((yield* reads.status(ctx, file, yield* reads.snapshot(file))).kind).toBe("changed")
    }),
  )

  it.live("withLock serializes one file across symlinks and never deadlocks", () =>
    Effect.gen(function* () {
      const dir = yield* tmp()
      const a = path.join(dir, "a.txt")
      const b = path.join(dir, "b.txt")
      const link = path.join(dir, "link.txt")
      yield* Effect.promise(() => fs.writeFile(a, "a"))
      yield* Effect.promise(() => fs.writeFile(b, "b"))
      yield* Effect.promise(() => fs.symlink(a, link))
      expect(FileReads.key(link)).toBe(FileReads.key(a))

      const order: string[] = []
      const gate = yield* Deferred.make<void>()
      const first = yield* FileReads.withLock(
        [a],
        Effect.gen(function* () {
          order.push("first:start")
          yield* Deferred.await(gate)
          order.push("first:end")
        }),
      ).pipe(Effect.forkScoped)
      yield* Effect.sleep("10 millis")
      const second = yield* FileReads.withLock(
        [link],
        Effect.sync(() => order.push("second")),
      ).pipe(Effect.forkScoped)
      yield* Effect.sleep("10 millis")
      expect(order).toEqual(["first:start"])
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      expect(order).toEqual(["first:start", "first:end", "second"])

      const both = yield* Effect.all(
        [FileReads.withLock([b, a], Effect.sleep("5 millis")), FileReads.withLock([a, b], Effect.sleep("5 millis"))],
        { concurrency: "unbounded" },
      ).pipe(Effect.timeout("2 seconds"))
      expect(both.length).toBe(2)
    }),
  )

  it.live("key is stable for a file that does not exist yet", () =>
    Effect.gen(function* () {
      const dir = yield* tmp()
      const file = path.join(dir, "new.txt")
      const before = FileReads.key(file)
      yield* Effect.promise(() => fs.writeFile(file, "x"))
      expect(FileReads.key(file)).toBe(before)
    }),
  )
})

const disabled = testEffect(
  LayerNode.compile(FileReads.node, [[RuntimeFlags.node, RuntimeFlags.layer({ disableFileReadCheck: true })]]),
)

describe("FileReads flag", () => {
  disabled.live("OPENCODE_DISABLE_FILE_READ_CHECK turns enforcement off", () =>
    Effect.gen(function* () {
      expect((yield* FileReads.Service).enforce).toBe(false)
    }),
  )
})
