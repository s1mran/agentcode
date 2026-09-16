import { describe, expect, test } from "bun:test"
import path from "path"
import { InstructionFile } from "@opencode-ai/core/instruction-file"

describe("InstructionFile.names", () => {
  test("lists AGENTS.md followed by the Claude Code files", () => {
    expect(InstructionFile.names({ claude: true })).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      path.join(".claude", "CLAUDE.md"),
      "CLAUDE.local.md",
    ])
  })

  test("lists only AGENTS.md when Claude Code files are disabled", () => {
    expect(InstructionFile.names({ claude: false })).toEqual(["AGENTS.md"])
  })
})

describe("InstructionFile.ancestors", () => {
  test.skipIf(process.platform === "win32")("orders directories from the filesystem root down", () => {
    expect(InstructionFile.ancestors("/a/b/c")).toEqual(["/", "/a", "/a/b", "/a/b/c"])
  })
})

describe("InstructionFile.stripComments", () => {
  test("removes a single-line block comment", () => {
    expect(InstructionFile.stripComments("<!-- note -->\nkeep")).toBe("keep")
  })

  test("removes a multi-line block comment", () => {
    expect(InstructionFile.stripComments("before\n<!--\nhidden\n-->\nafter")).toBe("before\nafter")
  })

  test("keeps comments inside fenced code blocks", () => {
    expect(InstructionFile.stripComments("```\n<!-- x -->\n```")).toBe("```\n<!-- x -->\n```")
    expect(InstructionFile.stripComments("~~~md\n<!-- x -->\n~~~")).toBe("~~~md\n<!-- x -->\n~~~")
  })

  test("keeps inline comments", () => {
    expect(InstructionFile.stripComments("text <!-- inline --> text")).toBe("text <!-- inline --> text")
  })

  test("keeps an unterminated comment and the lines after it", () => {
    expect(InstructionFile.stripComments("<!-- open\nstill here")).toBe("<!-- open\nstill here")
  })

  test("keeps a comment followed by text on the closing line", () => {
    expect(InstructionFile.stripComments("<!-- a --> trailing\nnext")).toBe("<!-- a --> trailing\nnext")
  })
})

describe("InstructionFile.references", () => {
  test("finds relative, home, absolute and bare references", () => {
    expect(InstructionFile.references("@docs/a.md and @~/x.md\n@/abs/y.md @README")).toEqual([
      "docs/a.md",
      "~/x.md",
      "/abs/y.md",
      "README",
    ])
  })

  test("trims trailing punctuation", () => {
    expect(InstructionFile.references("see @README.")).toEqual(["README"])
  })

  test("ignores references inside code spans", () => {
    expect(InstructionFile.references("`@span.md` and ``@double` span.md``")).toEqual([])
  })

  test("ignores references inside fenced code blocks", () => {
    expect(InstructionFile.references("```\n@fenced.md\n```\n@after.md")).toEqual(["after.md"])
  })

  test("ignores references inside code nested in list items and blockquotes", () => {
    expect(InstructionFile.references("- item\n\n    ```\n    @inside.md\n    ```\n- @item.md")).toEqual(["item.md"])
    expect(InstructionFile.references("> ```\n> @q.md\n> ```\n> @quote.md")).toEqual(["quote.md"])
  })

  test("ignores references inside indented code blocks", () => {
    expect(InstructionFile.references("para\n\n    @indented.md\n\n@after.md")).toEqual(["after.md"])
  })

  test("ignores references inside code spans that cross a line break", () => {
    expect(InstructionFile.references("text `start\n@x.md end` @y.md")).toEqual(["y.md"])
  })

  test("does not treat a code span as whitespace", () => {
    expect(InstructionFile.references("`cmd`@y.md and @z.md`x`")).toEqual(["z.md"])
  })

  test("keeps paragraph continuations and closes a fence with its list item", () => {
    expect(InstructionFile.references("para\n    @cont.md")).toEqual(["cont.md"])
    expect(InstructionFile.references("- ```\n@after.md")).toEqual(["after.md"])
  })

  test("ignores email addresses", () => {
    expect(InstructionFile.references("mail me@example.com")).toEqual([])
  })

  test("unescapes spaces", () => {
    expect(InstructionFile.references("@my\\ file.md")).toEqual(["my file.md"])
  })
})

describe("InstructionFile.target", () => {
  test("resolves relative references against the importing directory", () => {
    expect(InstructionFile.target("docs/a.md", "/p/sub", "/home/u")).toBe(path.resolve("/p/sub", "docs/a.md"))
  })

  test("expands ~/ with the home directory", () => {
    expect(InstructionFile.target("~/x.md", "/p", "/home/u")).toBe(path.join("/home/u", "x.md"))
  })

  test("passes absolute paths through", () => {
    expect(InstructionFile.target("/abs/y.md", "/p", "/home/u")).toBe(path.resolve("/abs/y.md"))
  })
})
