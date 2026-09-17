import { describe, expect, test } from "bun:test"
import {
  findServerCommand,
  isPathLikeSlash,
  looksLikeCommandName,
  MAX_SKILL_CHAIN,
  parseSlash,
  resolveSlash,
  shouldOpenSlashPopover,
  slashNameMatches,
  splitSlashChain,
  type SlashBuiltin,
} from "@opencode-ai/core/util/slash"

const builtins: SlashBuiltin[] = [
  { id: "session.compact", names: ["compact", "summarize"], takesArguments: true },
  { id: "session.undo", names: ["undo", "rewind", "checkpoint"] },
  { id: "session.share", names: ["share"], disabled: true },
]

describe("parseSlash", () => {
  test("splits the name from its arguments", () => {
    expect(parseSlash("/model kimi")).toEqual({ name: "model", args: "kimi" })
    expect(parseSlash("/compact")).toEqual({ name: "compact", args: "" })
  })

  test("keeps newlines inside the arguments", () => {
    expect(parseSlash("/cmd\nline two")).toEqual({ name: "cmd", args: "line two" })
    expect(parseSlash("/cmd first\nsecond ")).toEqual({ name: "cmd", args: "first\nsecond" })
  })

  test("returns undefined for a bare slash or leading whitespace", () => {
    expect(parseSlash("/")).toBeUndefined()
    expect(parseSlash(" /x")).toBeUndefined()
    expect(parseSlash("hello /x")).toBeUndefined()
  })
})

describe("command names and paths", () => {
  test("isPathLikeSlash", () => {
    expect(isPathLikeSlash("Users/me/x")).toBe(true)
    expect(isPathLikeSlash("tmp/x")).toBe(true)
    expect(isPathLikeSlash("foo.ts")).toBe(true)
    expect(isPathLikeSlash("~/x")).toBe(true)
    expect(isPathLikeSlash("tmp")).toBe(false)
    expect(isPathLikeSlash("frontend:component")).toBe(false)
    expect(isPathLikeSlash("compact")).toBe(false)
  })

  test("looksLikeCommandName", () => {
    expect(looksLikeCommandName("frontend:component")).toBe(true)
    expect(looksLikeCommandName("mcp__server__prompt")).toBe(true)
    expect(looksLikeCommandName("**")).toBe(false)
    expect(looksLikeCommandName("-x")).toBe(false)
  })

  test("slashNameMatches triggers and aliases case-insensitively", () => {
    expect(slashNameMatches({ trigger: "compact", aliases: ["summarize"] }, "Summarize")).toBe(true)
    expect(slashNameMatches({ trigger: "compact" }, "COMPACT")).toBe(true)
    expect(slashNameMatches({ trigger: "compact" }, "compa")).toBe(false)
  })
})

describe("resolveSlash", () => {
  test("a server command beats the built-in with the same name", () => {
    expect(resolveSlash("/compact focus", { commands: [{ name: "compact" }], builtins })).toEqual({
      type: "server",
      name: "compact",
      args: "focus",
    })
  })

  test("an alias resolves to its built-in", () => {
    expect(resolveSlash("/summarize auth flow", { commands: [], builtins })).toEqual({
      type: "builtin",
      id: "session.compact",
      name: "summarize",
      args: "auth flow",
    })
  })

  test("a disabled built-in is unavailable", () => {
    expect(resolveSlash("/share", { commands: [], builtins })).toEqual({ type: "unavailable", name: "share" })
  })

  test("arguments to a built-in that takes none are reported", () => {
    expect(resolveSlash("/undo now", { commands: [], builtins })).toEqual({
      type: "no-arguments",
      id: "session.undo",
      name: "undo",
    })
    expect(resolveSlash("/rewind", { commands: [], builtins })).toMatchObject({ type: "builtin", id: "session.undo" })
  })

  test("paths and non-command names are text", () => {
    expect(resolveSlash("/Users/me/a.ts explain", { commands: [], builtins })).toEqual({ type: "text" })
    expect(resolveSlash("/**", { commands: [], builtins })).toEqual({ type: "text" })
    expect(resolveSlash("plain text", { commands: [], builtins })).toEqual({ type: "text" })
  })

  test("a near miss is unknown", () => {
    expect(resolveSlash("/compa", { commands: [], builtins })).toEqual({ type: "unknown", name: "compa" })
    expect(resolveSlash("/tmp", { commands: [], builtins })).toEqual({ type: "unknown", name: "tmp" })
  })

  test("a server command typed with different capitals resolves to its real name", () => {
    expect(resolveSlash("/Review focus on auth", { commands: [{ name: "review" }], builtins })).toEqual({
      type: "server",
      name: "review",
      args: "focus on auth",
    })
    expect(resolveSlash("/REVIEW", { commands: [{ name: "review" }], builtins })).toEqual({
      type: "server",
      name: "review",
      args: "",
    })
  })

  test("an exact-case server command wins, and an ambiguous case-insensitive name matches none", () => {
    const commands = [{ name: "Deploy" }, { name: "deploy" }]
    expect(resolveSlash("/deploy", { commands, builtins })).toMatchObject({ type: "server", name: "deploy" })
    expect(resolveSlash("/Deploy", { commands, builtins })).toMatchObject({ type: "server", name: "Deploy" })
    expect(resolveSlash("/DEPLOY", { commands, builtins })).toEqual({ type: "unknown", name: "DEPLOY" })
    expect(findServerCommand(commands, "DEPLOY")).toBeUndefined()
    expect(findServerCommand([{ name: "review" }], "Review")).toEqual({ name: "review" })
  })

  test("a nested server command name that looks like a path still runs", () => {
    expect(resolveSlash("/frontend/component x", { commands: [{ name: "frontend/component" }], builtins })).toEqual({
      type: "server",
      name: "frontend/component",
      args: "x",
    })
  })
})

describe("shouldOpenSlashPopover", () => {
  test("opens for an empty query and for prefixes of a trigger", () => {
    expect(shouldOpenSlashPopover("", ["review"])).toBe(true)
    expect(shouldOpenSlashPopover("review/", ["review/nested"])).toBe(true)
    expect(shouldOpenSlashPopover("rev")).toBe(true)
  })

  test("stays closed for paths that match no command", () => {
    expect(shouldOpenSlashPopover("Users/me", ["review"])).toBe(false)
    expect(shouldOpenSlashPopover("tmp/x", ["review"])).toBe(false)
    expect(shouldOpenSlashPopover("compa", ["review"])).toBe(true)
  })
})

describe("splitSlashChain", () => {
  const chainable = (name: string) => ["a", "b", "c", "d", "e", "f", "g"].includes(name)

  test("takes leading chainable names and leaves the rest", () => {
    expect(splitSlashChain("/b /c hello world", chainable)).toEqual({ names: ["b", "c"], rest: "hello world" })
    expect(splitSlashChain("/b", chainable)).toEqual({ names: ["b"], rest: "" })
  })

  test("stops at a name that is not chainable", () => {
    expect(splitSlashChain("/b /review /c text", chainable)).toEqual({ names: ["b"], rest: "/review /c text" })
    expect(splitSlashChain("/zzz text", chainable)).toEqual({ names: [], rest: "/zzz text" })
  })

  test("caps the chain at five extra names", () => {
    const result = splitSlashChain("/a /b /c /d /e /f /g go", chainable)
    expect(result.names).toEqual(["a", "b", "c", "d", "e"])
    expect(result.names.length).toBe(MAX_SKILL_CHAIN - 1)
    expect(result.rest).toBe("/f /g go")
  })

  test("keeps quotes and newlines in the rest", () => {
    expect(splitSlashChain('/b "quoted arg"\nnext line', chainable)).toEqual({
      names: ["b"],
      rest: '"quoted arg"\nnext line',
    })
    expect(splitSlashChain("/b\nfocus", chainable)).toEqual({ names: ["b"], rest: "focus" })
  })
})
