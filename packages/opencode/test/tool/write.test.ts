import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import path from "path"
import fs from "fs/promises"
import { WriteTool } from "../../src/tool/write"
import { EditTool } from "../../src/tool/edit"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { FileReads } from "../../src/session/file-reads"
import { ReadTool } from "../../src/tool/read"
import { Instruction } from "../../src/session/instruction"
import { Session } from "../../src/session/session"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Config } from "@/config/config"
import { TestConfig } from "../fixture/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"

const ctx = {
  sessionID: SessionID.make("ses_test-write-session"),
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

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      LSP.node,
      FSUtil.node,
      EventV2Bridge.node,
      Format.node,
      CrossSpawnSpawner.node,
      Truncate.node,
      Agent.node,
    ]),
  ),
)

const init = Effect.fn("WriteToolTest.init")(function* () {
  const info = yield* WriteTool
  return yield* info.init()
})

const run = Effect.fn("WriteToolTest.run")(function* (
  args: Tool.InferParameters<typeof WriteTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

describe("tool.write", () => {
  describe("new file creation", () => {
    it.instance("writes content to new file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "newfile.txt")
        const result = yield* run({ filePath: filepath, content: "Hello, World!" })

        expect(result.output).toContain("Wrote file successfully")
        expect(result.metadata.exists).toBe(false)

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(content).toBe("Hello, World!")
      }),
    )

    it.instance("creates parent directories if needed", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "nested", "deep", "file.txt")
        yield* run({ filePath: filepath, content: "nested content" })

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(content).toBe("nested content")
      }),
    )

    it.instance("handles relative paths by resolving to instance directory", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* run({ filePath: "relative.txt", content: "relative content" })

        const content = yield* Effect.promise(() => fs.readFile(path.join(test.directory, "relative.txt"), "utf-8"))
        expect(content).toBe("relative content")
      }),
    )
  })

  describe("existing file overwrite", () => {
    it.instance("overwrites existing file content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        yield* Effect.promise(() => fs.writeFile(filepath, "old content", "utf-8"))
        const result = yield* run({ filePath: filepath, content: "new content" })

        expect(result.output).toContain("Wrote file successfully")
        expect(result.metadata.exists).toBe(true)

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(content).toBe("new content")
      }),
    )

    it.instance("preserves BOM when overwriting existing files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.cs")
        const bom = String.fromCharCode(0xfeff)
        yield* Effect.promise(() => fs.writeFile(filepath, `${bom}using System;\n`, "utf-8"))

        yield* run({ filePath: filepath, content: "using Up;\n" })

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(content.charCodeAt(0)).toBe(0xfeff)
        expect(content.slice(1)).toBe("using Up;\n")
      }),
    )

    it.instance(
      "restores BOM after formatter strips it",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const filepath = path.join(test.directory, "formatted.cs")
          const bom = String.fromCharCode(0xfeff)
          yield* Effect.promise(() => fs.writeFile(filepath, `${bom}using System;\n`, "utf-8"))

          yield* run({ filePath: filepath, content: "using Up;\n" })

          const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
          expect(content.charCodeAt(0)).toBe(0xfeff)
          expect(content.slice(1)).toBe("using Up;\n")
        }),
      {
        config: {
          formatter: {
            stripbom: {
              extensions: [".cs"],
              command: [
                "node",
                "-e",
                "const fs = require('fs'); const file = process.argv[1]; let text = fs.readFileSync(file, 'utf8'); if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); fs.writeFileSync(file, text, 'utf8')",
                "$FILE",
              ],
            },
          },
        },
      },
    )

    it.instance("returns diff in metadata for existing files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* Effect.promise(() => fs.writeFile(filepath, "old", "utf-8"))
        const result = yield* run({ filePath: filepath, content: "new" })

        expect(result.metadata).toHaveProperty("filepath", filepath)
        expect(result.metadata).toHaveProperty("exists", true)
      }),
    )
  })

  describe("file permissions", () => {
    it.instance("sets file permissions when writing sensitive data", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "sensitive.json")
        yield* run({ filePath: filepath, content: JSON.stringify({ secret: "data" }) })

        if (process.platform !== "win32") {
          const stats = yield* Effect.promise(() => fs.stat(filepath))
          expect(stats.mode & 0o777).toBe(0o644)
        }
      }),
    )
  })

  describe("content types", () => {
    it.instance("writes JSON content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "data.json")
        const data = { key: "value", nested: { array: [1, 2, 3] } }
        yield* run({ filePath: filepath, content: JSON.stringify(data, null, 2) })

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(JSON.parse(content)).toEqual(data)
      }),
    )

    it.instance("writes binary-safe content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "binary.bin")
        const content = "Hello\x00World\x01\x02\x03"
        yield* run({ filePath: filepath, content })

        const buf = yield* Effect.promise(() => fs.readFile(filepath))
        expect(buf.toString()).toBe(content)
      }),
    )

    it.instance("writes empty content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "empty.txt")
        yield* run({ filePath: filepath, content: "" })

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(content).toBe("")

        const stats = yield* Effect.promise(() => fs.stat(filepath))
        expect(stats.size).toBe(0)
      }),
    )

    it.instance("writes multi-line content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "multiline.txt")
        const lines = ["Line 1", "Line 2", "Line 3", ""].join("\n")
        yield* run({ filePath: filepath, content: lines })

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(content).toBe(lines)
      }),
    )

    it.instance("handles different line endings", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "crlf.txt")
        const content = "Line 1\r\nLine 2\r\nLine 3"
        yield* run({ filePath: filepath, content })

        const buf = yield* Effect.promise(() => fs.readFile(filepath))
        expect(buf.toString()).toBe(content)
      }),
    )
  })

  describe("error handling", () => {
    it.instance("throws error when OS denies write access", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const readonlyPath = path.join(test.directory, "readonly.txt")
        yield* Effect.promise(() => fs.writeFile(readonlyPath, "test", "utf-8"))
        yield* Effect.promise(() => fs.chmod(readonlyPath, 0o444))
        const exit = yield* run({ filePath: readonlyPath, content: "new content" }).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }),
    )
  })

  describe("title generation", () => {
    it.instance("returns relative path as title", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "src", "components", "Button.tsx")
        yield* Effect.promise(() => fs.mkdir(path.dirname(filepath), { recursive: true }))

        const result = yield* run({ filePath: filepath, content: "export const Button = () => {}" })
        expect(result.title).toEndWith(path.join("src", "components", "Button.tsx"))
      }),
    )
  })
})

// Read-before-write ledger (session/file-reads.ts), compiled in with the read tool as the tool registry does.
const ledgerNodes = [
  LSP.node,
  FSUtil.node,
  EventV2Bridge.node,
  Format.node,
  CrossSpawnSpawner.node,
  Truncate.node,
  Agent.node,
  FileReads.node,
  Instruction.node,
  Ripgrep.node,
  Session.node,
] as const
const ledger = testEffect(LayerNode.compile(LayerNode.group([...ledgerNodes])))
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

const ledgerCtx = (extra: Partial<Tool.Context> = {}): Tool.Context => ({
  ...ctx,
  sessionID: SessionID.make("ses_test-write-ledger"),
  messageID: MessageID.make("msg_ledger"),
  messages: [],
  ...extra,
})

const readWith = Effect.fn("WriteToolTest.read")(function* (
  filePath: string,
  next: Tool.Context,
  range: { offset?: number; limit?: number } = {},
) {
  const info = yield* ReadTool
  const tool = yield* info.init()
  return yield* tool.execute({ filePath, ...range }, next)
})

const failWith = Effect.fn("WriteToolTest.failWith")(function* (
  args: Tool.InferParameters<typeof WriteTool>,
  next: Tool.Context,
) {
  const exit = yield* run(args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected write to fail")
})

const text = (filepath: string) => Effect.promise(() => fs.readFile(filepath, "utf-8"))

describe("tool.write read ledger", () => {
  ledger.instance("overwriting an unread file fails and leaves it unchanged", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "unread.txt")
      yield* Effect.promise(() => fs.writeFile(filepath, "keep\n"))

      const err = yield* failWith({ filePath: filepath, content: "replaced\n" }, ledgerCtx())
      expect(err.message).toContain("must read")
      expect(yield* text(filepath)).toBe("keep\n")
    }),
  )

  ledger.instance("a full read allows the overwrite, a partial read does not", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const whole = path.join(test.directory, "whole.txt")
      const part = path.join(test.directory, "part.txt")
      yield* Effect.promise(() => fs.writeFile(whole, "a\nb\nc\n"))
      yield* Effect.promise(() => fs.writeFile(part, "a\nb\nc\n"))
      const next = ledgerCtx()

      yield* readWith(whole, next)
      yield* run({ filePath: whole, content: "new\n" }, next)
      expect(yield* text(whole)).toBe("new\n")

      yield* readWith(part, next, { offset: 1, limit: 2 })
      const err = yield* failWith({ filePath: part, content: "new\n" }, next)
      expect(err.message).toContain("read the whole file")
    }),
  )

  ledger.instance("an edit after a partial read does not make the whole file read (write.txt)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "edited.txt")
      yield* Effect.promise(() =>
        fs.writeFile(filepath, Array.from({ length: 300 }, (_, i) => `row ${i + 1}`).join("\n") + "\n"),
      )
      const next = ledgerCtx()
      const edit = yield* (yield* EditTool).init()

      yield* readWith(filepath, next, { offset: 1, limit: 100 })
      yield* edit.execute({ filePath: filepath, oldString: "row 50\n", newString: "row fifty\n" }, next)
      const err = yield* failWith({ filePath: filepath, content: "new\n" }, next)
      expect(err.message).toContain("only read lines 1-100")
      expect(err.message).toContain("read the whole file")
    }),
  )

  ledger.instance("new files need no read, and a later write of the same file needs none either", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "fresh.txt")
      const next = ledgerCtx()
      const first = yield* run({ filePath: filepath, content: "one\n" }, next)
      expect(first.metadata.ledger?.[0]?.full).toBe(true)
      yield* run({ filePath: filepath, content: "two\n" }, next)
      expect(yield* text(filepath)).toBe("two\n")
    }),
  )

  ledger.instance("a file changed since the read must be read again", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "changed.txt")
      yield* Effect.promise(() => fs.writeFile(filepath, "v1\n"))
      const next = ledgerCtx()
      yield* readWith(filepath, next)
      yield* Effect.promise(() => fs.writeFile(filepath, "v2 external\n"))

      const err = yield* failWith({ filePath: filepath, content: "v3\n" }, next)
      expect(err.message).toContain("modified since")
      expect(yield* text(filepath)).toBe("v2 external\n")
    }),
  )

  ledger.instance("writes to one file run one after the other", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "locked.txt")
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const asks: string[] = []
      const first = yield* run(
        { filePath: filepath, content: "first\n" },
        ledgerCtx({
          ask: () =>
            Effect.gen(function* () {
              asks.push("first")
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
            }),
        }),
      ).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      const second = yield* run(
        { filePath: filepath, content: "second\n" },
        ledgerCtx({ ask: () => Effect.sync(() => void asks.push("second")) }),
      ).pipe(Effect.forkScoped)
      yield* Effect.sleep("30 millis")
      expect(asks).toEqual(["first"])
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      expect(asks).toEqual(["first", "second"])
      expect(yield* text(filepath)).toBe("second\n")
    }),
  )

  formatted.instance("notes a formatter rewrite", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "format.txt")
      const next = ledgerCtx()
      const result = yield* run({ filePath: filepath, content: "raw\n" }, next)
      expect(result.output).toContain("the formatter (custom) rewrote")
      expect(yield* text(filepath)).toBe("formatted\n")
      yield* run({ filePath: filepath, content: "again\n" }, next)
    }),
  )
})
