import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { EditTool } from "../../src/tool/edit"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import * as Tool from "../../src/tool/tool"
import { testEffect } from "../lib/effect"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { FileReads } from "../../src/session/file-reads"
import { ReadTool } from "../../src/tool/read"
import { Instruction } from "../../src/session/instruction"
import { Session } from "../../src/session/session"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Config } from "@/config/config"
import { TestConfig } from "../fixture/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"

const ctx = {
  sessionID: SessionID.make("ses_test-edit-session"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const layer = LayerNode.compile(
  LayerNode.group([LSP.node, FSUtil.node, Format.node, EventV2Bridge.node, Truncate.node, Agent.node]),
)

const it = testEffect(layer)

const init = Effect.fn("EditToolTest.init")(function* () {
  const info = yield* EditTool
  return yield* info.init()
})

const run = Effect.fn("EditToolTest.run")(function* (
  args: Tool.InferParameters<typeof EditTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const fail = Effect.fn("EditToolTest.fail")(function* (args: Tool.InferParameters<typeof EditTool>) {
  const exit = yield* run(args).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected edit to fail")
})

const put = Effect.fn("EditToolTest.put")(function* (p: string, content: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})

const load = Effect.fn("EditToolTest.load")(function* (p: string) {
  const fs = yield* FSUtil.Service
  return yield* fs.readFileString(p)
})

const loadRaw = Effect.fn("EditToolTest.loadRaw")(function* (p: string) {
  return yield* Effect.promise(() => fs.readFile(p, "utf-8"))
})

const makeDirectory = Effect.fn("EditToolTest.makeDirectory")(function* (p: string) {
  const fs = yield* FSUtil.Service
  yield* fs.makeDirectory(p)
})

const onceBus = Effect.fn("EditToolTest.onceBus")(function* (def: typeof Watcher.Event.Updated) {
  const events = yield* EventV2Bridge.Service
  const deferred = yield* Deferred.make<void>()
  const unsub = yield* events.listen((event) => {
    if (event.type === def.type) Deferred.doneUnsafe(deferred, Effect.void)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => unsub)
  return deferred
})

describe("tool.edit", () => {
  describe("creating new files", () => {
    it.instance("creates new file when oldString is empty", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "newfile.txt")
        const result = yield* run({ filePath: filepath, oldString: "", newString: "new content" })

        expect(result.metadata.diff).toContain("new content")
        expect(yield* load(filepath)).toBe("new content")
      }),
    )

    it.instance("rejects empty oldString on existing files and leaves content unchanged", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.cs")
        const bom = String.fromCharCode(0xfeff)
        const original = `${bom}using System;\n`
        yield* put(filepath, original)

        expect((yield* fail({ filePath: filepath, oldString: "", newString: "using Up;\n" })).message).toContain(
          "oldString cannot be empty",
        )

        const content = yield* loadRaw(filepath)
        expect(content).toBe(original)
      }),
    )

    it.instance("creates new file with nested directories", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "nested", "dir", "file.txt")

        yield* run({ filePath: filepath, oldString: "", newString: "nested file" })

        expect(yield* load(filepath)).toBe("nested file")
      }),
    )

    it.instance("emits add event for new files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const updated = yield* onceBus(Watcher.Event.Updated)

        yield* run({ filePath: path.join(test.directory, "new.txt"), oldString: "", newString: "content" })
        yield* Deferred.await(updated)
      }),
    )
  })

  describe("editing existing files", () => {
    it.instance("replaces text in existing file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        yield* put(filepath, "old content here")

        const result = yield* run({ filePath: filepath, oldString: "old content", newString: "new content" })

        expect(result.output).toContain("Edit applied successfully")
        expect(yield* load(filepath)).toBe("new content here")
      }),
    )

    it.instance("replaces the first visible line in BOM files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.cs")
        const bom = String.fromCharCode(0xfeff)
        yield* put(filepath, `${bom}using System;\nclass Test {}\n`)

        const result = yield* run({ filePath: filepath, oldString: "using System;", newString: "using Up;" })

        expect(result.metadata.diff).toContain("-using System;")
        expect(result.metadata.diff).toContain("+using Up;")
        expect(result.metadata.diff).not.toContain(bom)

        const content = yield* loadRaw(filepath)
        expect(content.charCodeAt(0)).toBe(0xfeff)
        expect(content.slice(1)).toBe("using Up;\nclass Test {}\n")
      }),
    )

    it.instance("throws error when file does not exist", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        expect(
          (yield* fail({ filePath: path.join(test.directory, "nonexistent.txt"), oldString: "old", newString: "new" }))
            .message,
        ).toContain("not found")
      }),
    )

    it.instance("throws error when oldString equals newString", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "content")

        expect((yield* fail({ filePath: filepath, oldString: "same", newString: "same" })).message).toContain(
          "identical",
        )
      }),
    )

    it.instance("throws error when oldString not found in file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "actual content")

        expect(yield* fail({ filePath: filepath, oldString: "not in file", newString: "replacement" })).toBeInstanceOf(
          Error,
        )
      }),
    )

    it.instance("rejects loose block-anchor matches and leaves content unchanged", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.ts")
        const original = [
          "function configure() {",
          "  keepImportantState()",
          "  removeAllUserData()",
          "  archiveBackups()",
          "  auditLog()",
          "}",
        ].join("\n")
        yield* put(filepath, original)

        expect(
          (yield* fail({
            filePath: filepath,
            oldString: ["function configure() {", "  const enabled = true", "}"].join("\n"),
            newString: ["function configure() {", "  const enabled = false", "}"].join("\n"),
          })).message,
        ).toContain("Could not find oldString")
        expect(yield* load(filepath)).toBe(original)
      }),
    )

    it.instance("rejects block-anchor matches with unrelated middle content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.ts")
        const original = ["function configure() {", "  removeAllUserData()", "}"].join("\n")
        yield* put(filepath, original)

        expect(
          (yield* fail({
            filePath: filepath,
            oldString: ["function configure() {", "  const enabled = true", "}"].join("\n"),
            newString: ["function configure() {", "  const enabled = false", "}"].join("\n"),
          })).message,
        ).toContain("Could not find oldString")
        expect(yield* load(filepath)).toBe(original)
      }),
    )

    it.instance("replaces all occurrences with replaceAll option", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "foo bar foo baz foo")

        yield* run({ filePath: filepath, oldString: "foo", newString: "qux", replaceAll: true })

        expect(yield* load(filepath)).toBe("qux bar qux baz qux")
      }),
    )

    it.instance("emits change event for existing files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "original")
        const updated = yield* onceBus(Watcher.Event.Updated)

        yield* run({ filePath: filepath, oldString: "original", newString: "modified" })
        yield* Deferred.await(updated)
      }),
    )
  })

  describe("edge cases", () => {
    it.instance("handles multiline replacements", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "line1\nline2\nline3")

        yield* run({ filePath: filepath, oldString: "line2", newString: "new line 2\nextra line" })

        expect(yield* load(filepath)).toBe("line1\nnew line 2\nextra line\nline3")
      }),
    )

    it.instance("handles CRLF line endings", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "line1\r\nold\r\nline3")

        yield* run({ filePath: filepath, oldString: "old", newString: "new" })

        expect(yield* load(filepath)).toBe("line1\r\nnew\r\nline3")
      }),
    )

    it.instance("throws error when oldString equals newString", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "content")

        expect((yield* fail({ filePath: filepath, oldString: "", newString: "" })).message).toContain("identical")
      }),
    )

    it.instance("throws error when path is directory", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const dirpath = path.join(test.directory, "adir")
        yield* makeDirectory(dirpath)

        expect((yield* fail({ filePath: dirpath, oldString: "old", newString: "new" })).message).toContain("directory")
      }),
    )

    it.instance("tracks file diff statistics", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "line1\nline2\nline3")

        const result = yield* run({ filePath: filepath, oldString: "line2", newString: "new line a\nnew line b" })

        expect(result.metadata.filediff).toBeDefined()
        expect(result.metadata.filediff.file).toBe(filepath)
        expect(result.metadata.filediff.additions).toBeGreaterThan(0)
      }),
    )
  })

  describe("line endings", () => {
    const old = "alpha\nbeta\ngamma"
    const next = "alpha\nbeta-updated\ngamma"
    const alt = "alpha\nbeta\nomega"

    const normalize = (text: string, ending: "\n" | "\r\n") => {
      const normalized = text.replaceAll("\r\n", "\n")
      if (ending === "\n") return normalized
      return normalized.replaceAll("\n", "\r\n")
    }

    const count = (content: string) => {
      const crlf = content.match(/\r\n/g)?.length ?? 0
      const lf = content.match(/\n/g)?.length ?? 0
      return {
        crlf,
        lf: lf - crlf,
      }
    }

    const expectLf = (content: string) => {
      const counts = count(content)
      expect(counts.crlf).toBe(0)
      expect(counts.lf).toBeGreaterThan(0)
    }

    const expectCrlf = (content: string) => {
      const counts = count(content)
      expect(counts.lf).toBe(0)
      expect(counts.crlf).toBeGreaterThan(0)
    }

    type Input = {
      content: string
      oldString: string
      newString: string
      replaceAll?: boolean
    }

    const apply = Effect.fn("EditToolTest.lineEndings.apply")(function* (input: Input) {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "test.txt")
      yield* put(filePath, input.content)
      yield* run({
        filePath,
        oldString: input.oldString,
        newString: input.newString,
        replaceAll: input.replaceAll,
      })
      return yield* load(filePath)
    })

    it.instance("preserves LF with LF multi-line strings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\n"),
          newString: normalize(next, "\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF with CRLF multi-line strings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\r\n"),
          newString: normalize(next, "\r\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("preserves LF when old/new use CRLF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\r\n"),
          newString: normalize(next, "\r\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF when old/new use LF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\n"),
          newString: normalize(next, "\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("preserves LF when newString uses CRLF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\n"),
          newString: normalize(next, "\r\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF when newString uses LF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\r\n"),
          newString: normalize(next, "\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("preserves LF with mixed old/new line endings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: "alpha\nbeta\r\ngamma",
          newString: "alpha\r\nbeta\nomega",
        })
        expect(output).toBe(normalize(alt + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF with mixed old/new line endings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: "alpha\r\nbeta\ngamma",
          newString: "alpha\nbeta\r\nomega",
        })
        expect(output).toBe(normalize(alt + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("replaceAll preserves LF for multi-line blocks", () =>
      Effect.gen(function* () {
        const blockOld = "alpha\nbeta"
        const blockNew = "alpha\nbeta-updated"
        const content = normalize(blockOld + "\n" + blockOld + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(blockOld, "\n"),
          newString: normalize(blockNew, "\n"),
          replaceAll: true,
        })
        expect(output).toBe(normalize(blockNew + "\n" + blockNew + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("replaceAll preserves CRLF for multi-line blocks", () =>
      Effect.gen(function* () {
        const blockOld = "alpha\nbeta"
        const blockNew = "alpha\nbeta-updated"
        const content = normalize(blockOld + "\n" + blockOld + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(blockOld, "\r\n"),
          newString: normalize(blockNew, "\r\n"),
          replaceAll: true,
        })
        expect(output).toBe(normalize(blockNew + "\n" + blockNew + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )
  })

  describe("concurrent editing", () => {
    it.instance("preserves concurrent edits to different sections of the same file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "top = 0\nmiddle = keep\nbottom = 0\n")

        const firstAsk = yield* Deferred.make<void>()
        let asks = 0
        const delayedCtx = {
          ...ctx,
          ask: () =>
            Effect.gen(function* () {
              asks++
              if (asks !== 1) return
              yield* Deferred.succeed(firstAsk, undefined)
              yield* Effect.sleep("50 millis")
            }),
        }

        const first = yield* run(
          {
            filePath: filepath,
            oldString: "top = 0",
            newString: "top = 1",
          },
          delayedCtx,
        ).pipe(Effect.forkScoped)

        yield* Deferred.await(firstAsk)
        yield* Effect.all([
          Fiber.join(first),
          run(
            {
              filePath: filepath,
              oldString: "bottom = 0",
              newString: "bottom = 2",
            },
            delayedCtx,
          ),
        ])

        expect(yield* load(filepath)).toBe("top = 1\nmiddle = keep\nbottom = 2\n")
      }),
    )
  })
})

// Read-before-edit ledger (session/file-reads.ts). The blocks above run without the FileReads service, so they keep
// the pre-ledger behaviour; these compile it in, with the read tool, as the tool registry does.
const ledgerNodes = [
  LSP.node,
  FSUtil.node,
  Format.node,
  EventV2Bridge.node,
  Truncate.node,
  Agent.node,
  FileReads.node,
  CrossSpawnSpawner.node,
  Instruction.node,
  Ripgrep.node,
  Session.node,
] as const
const ledger = testEffect(LayerNode.compile(LayerNode.group([...ledgerNodes])))
const unchecked = testEffect(
  LayerNode.compile(LayerNode.group([...ledgerNodes]), [
    [RuntimeFlags.node, RuntimeFlags.layer({ disableFileReadCheck: true })],
  ]),
)

// Project config formatters are held until the folder is trusted, so the formatter comes from the config service.
const formatted = testEffect(
  LayerNode.compile(LayerNode.group([...ledgerNodes]), [
    [
      Config.node,
      TestConfig.layer({
        get: () =>
          Effect.succeed({
            formatter: { custom: { command: ["sh", "-c", 'printf "formatted\\n" > "$FILE"'], extensions: [".txt"] } },
          } as ConfigV1.Info),
      }),
    ],
  ]),
)

const ledgerCtx = (messageID = "msg_ledger", extra: Partial<Tool.Context> = {}): Tool.Context => ({
  ...ctx,
  sessionID: SessionID.make("ses_test-edit-ledger"),
  messageID: MessageID.make(messageID),
  messages: [],
  ...extra,
})

const readWith = Effect.fn("EditToolTest.read")(function* (
  filePath: string,
  next: Tool.Context,
  range: { offset?: number; limit?: number } = {},
) {
  const info = yield* ReadTool
  const tool = yield* info.init()
  return yield* tool.execute({ filePath, ...range }, next)
})

const failWith = Effect.fn("EditToolTest.failWith")(function* (
  args: Tool.InferParameters<typeof EditTool>,
  next: Tool.Context,
) {
  const exit = yield* run(args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected edit to fail")
})

const external = (filepath: string, content: string) =>
  Effect.promise(async () => {
    await fs.writeFile(filepath, content)
    const later = new Date(Date.now() + 10_000)
    await fs.utimes(filepath, later, later)
  })

describe("tool.edit read ledger", () => {
  ledger.instance("fails on an existing file that was not read and leaves it unchanged", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "unread.txt")
      yield* put(filepath, "alpha\nbeta\n")

      const err = yield* failWith({ filePath: filepath, oldString: "beta", newString: "gamma" }, ledgerCtx())
      expect(err.message).toContain("must read")
      expect(yield* load(filepath)).toBe("alpha\nbeta\n")
    }),
  )

  ledger.instance("allows edits after a read, and consecutive edits without a re-read", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "read.txt")
      yield* put(filepath, "alpha\nbeta\ngamma\n")
      const next = ledgerCtx()

      yield* readWith(filepath, next)
      const first = yield* run({ filePath: filepath, oldString: "beta", newString: "BETA" }, next)
      expect(first.metadata.ledger?.[0]?.full).toBe(true)
      yield* run({ filePath: filepath, oldString: "gamma", newString: "GAMMA" }, next)
      expect(yield* load(filepath)).toBe("alpha\nBETA\nGAMMA\n")
    }),
  )

  ledger.instance("creates a new file without a read", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "brand-new.txt")
      yield* run({ filePath: filepath, oldString: "", newString: "hello\n" }, ledgerCtx())
      expect(yield* load(filepath)).toBe("hello\n")
      yield* run({ filePath: filepath, oldString: "hello", newString: "bye" }, ledgerCtx())
      expect(yield* load(filepath)).toBe("bye\n")
    }),
  )

  ledger.instance("a partial read allows edits only inside the lines read", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "big.txt")
      yield* put(filepath, Array.from({ length: 3000 }, (_, i) => `row ${i + 1}`).join("\n") + "\n")
      const next = ledgerCtx()

      yield* readWith(filepath, next, { offset: 1, limit: 100 })
      yield* run({ filePath: filepath, oldString: "row 50\n", newString: "row fifty\n" }, next)
      const err = yield* failWith({ filePath: filepath, oldString: "row 2500\n", newString: "row x\n" }, next)
      expect(err.message).toContain("only read lines 1-100")
      expect(err.message).toContain("2500")
    }),
  )

  ledger.instance("applies an exact edit to a file changed on disk and notes it", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "changed.txt")
      yield* put(filepath, "one\ntwo\nthree\nfour\n")
      const next = ledgerCtx()

      yield* readWith(filepath, next)
      yield* external(filepath, "one\ntwo\nthree\nFOUR (external)\n")
      const result = yield* run({ filePath: filepath, oldString: "two", newString: "TWO" }, next)
      expect(result.output).toContain("changed on disk")
      expect(yield* load(filepath)).toBe("one\nTWO\nthree\nFOUR (external)\n")

      // Only the edited line counts as seen now.
      const err = yield* failWith({ filePath: filepath, oldString: "three", newString: "THREE" }, next)
      expect(err.message).toContain("only read lines 2")
    }),
  )

  ledger.instance("a partial read of a file changed on disk never lets an exact match reach unread lines", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "partial-changed.txt")
      const rows = Array.from({ length: 2000 }, (_, i) => `row ${i + 1}`)
      yield* put(filepath, rows.join("\n") + "\n")
      const next = ledgerCtx()

      yield* readWith(filepath, next, { offset: 1, limit: 50 })
      const refused = yield* failWith({ filePath: filepath, oldString: "row 1500\n", newString: "row x\n" }, next)
      expect(refused.message).toContain("only read lines 1-50")

      // An unrelated outside change must not turn the refusal into an allowed edit.
      yield* external(filepath, rows.map((row, i) => (i === 9 ? "row ten (editor)" : row)).join("\n") + "\n")
      const changed = yield* failWith({ filePath: filepath, oldString: "row 1500\n", newString: "row x\n" }, next)
      expect(changed.message).toContain("modified since you last read it")
      expect(yield* load(filepath)).toContain("row 1500\n")

      // Re-reading just the lines to change is enough.
      yield* readWith(filepath, next, { offset: 1495, limit: 10 })
      yield* run({ filePath: filepath, oldString: "row 1500\n", newString: "row x\n" }, next)
      expect(yield* load(filepath)).toContain("row x\n")
    }),
  )

  ledger.instance("an insertion just above a ranged read counts as inside it", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "insert.txt")
      yield* put(filepath, Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n") + "\n")
      const next = ledgerCtx()

      yield* readWith(filepath, next, { offset: 3, limit: 3 })
      yield* run({ filePath: filepath, oldString: "line3\n", newString: "inserted\nline3\n" }, next)
      expect(yield* load(filepath)).toContain("line2\ninserted\nline3\n")
      // Directly below the range too; far away still fails.
      yield* run({ filePath: filepath, oldString: "line5\n", newString: "line5\nafter\n" }, next)
      const err = yield* failWith({ filePath: filepath, oldString: "line9\n", newString: "line9\nx\n" }, next)
      expect(err.message).toContain("only read lines 3-7")
      expect(err.message).toContain("Read lines 11 ")
    }),
  )

  ledger.instance("asks for a re-read when a changed file no longer matches oldString exactly once", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "ambiguous.txt")
      yield* put(filepath, "value = 1\nother = 2\n")
      const next = ledgerCtx()

      yield* readWith(filepath, next)
      yield* external(filepath, "value = 1\nvalue = 1\nother = 2\n")
      const twice = yield* failWith({ filePath: filepath, oldString: "value = 1", newString: "value = 3" }, next)
      expect(twice.message).toContain("modified since you last read it")

      const fuzzy = yield* failWith({ filePath: filepath, oldString: "  other = 2", newString: "other = 4" }, next)
      expect(fuzzy.message).toContain("modified since you last read it")
      expect(yield* load(filepath)).toBe("value = 1\nvalue = 1\nother = 2\n")
    }),
  )

  ledger.instance("a touch without a content change is not a change", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "touched.txt")
      yield* put(filepath, "same\n")
      const next = ledgerCtx()

      yield* readWith(filepath, next)
      const later = new Date(Date.now() + 10_000)
      yield* Effect.promise(() => fs.utimes(filepath, later, later))
      const result = yield* run({ filePath: filepath, oldString: "same", newString: "new" }, next)
      expect(result.output).not.toContain("changed on disk")
    }),
  )

  ledger.instance("never overwrites a change made while the permission prompt was open", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "race.txt")
      yield* put(filepath, "before\n")
      const next = ledgerCtx("msg_ledger", {
        ask: () => Effect.promise(() => fs.writeFile(filepath, "external change\n")),
      })

      yield* readWith(filepath, ledgerCtx())
      const err = yield* failWith({ filePath: filepath, oldString: "before", newString: "after" }, next)
      expect(err.message).toContain("changed while waiting for approval")
      expect(yield* load(filepath)).toBe("external change\n")
    }),
  )

  it.instance("the approval re-check also runs without the ledger", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "race-plain.txt")
      yield* put(filepath, "before\n")
      const next = { ...ctx, ask: () => Effect.promise(() => fs.writeFile(filepath, "external change\n")) }

      const err = yield* failWith({ filePath: filepath, oldString: "before", newString: "after" }, next)
      expect(err.message).toContain("changed while waiting for approval")
      expect(yield* load(filepath)).toBe("external change\n")
    }),
  )

  formatted.instance("reports a formatter rewrite and refreshes the ledger", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "format.txt")
      yield* put(filepath, "a\nb\n")
      const next = ledgerCtx()

      yield* readWith(filepath, next)
      const result = yield* run({ filePath: filepath, oldString: "a", newString: "c" }, next)
      expect(result.output).toContain("the formatter (custom) rewrote")
      expect(yield* load(filepath)).toBe("formatted\n")

      const again = yield* run({ filePath: filepath, oldString: "formatted", newString: "done" }, next)
      expect(again.output).toContain("Edit applied successfully")
    }),
  )

  unchecked.instance("OPENCODE_DISABLE_FILE_READ_CHECK allows an edit without a read", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "flag.txt")
      yield* put(filepath, "alpha\n")
      const result = yield* run({ filePath: filepath, oldString: "alpha", newString: "beta" }, ledgerCtx())
      expect(result.output).toContain("Edit applied successfully")
      expect(result.metadata.ledger?.length).toBe(1)
    }),
  )
})
