import { describe, expect, test } from "bun:test"
import type { CommandOption } from "@/context/command"
import {
  buildSlashCommands,
  createSlashResolver,
  formatSlashHints,
  slashResolutionToast,
  slashTriggers,
  templateHints,
  type SlashTranslate,
} from "./slash"

const t: SlashTranslate = (key, params) => (params ? `${key}:${Object.values(params).join(",")}` : key)

const options: CommandOption[] = [
  { id: "session.new", title: "New session", slash: "new", slashAliases: ["clear", "reset"] },
  {
    id: "session.compact",
    title: "Compact",
    slash: "compact",
    slashAliases: ["summarize"],
    argumentHint: "[focus instructions]",
    keybind: "mod+k",
  },
  { id: "session.share", title: "Share", slash: "share", disabled: true },
  { id: "suggested.session.new", title: "New session", slash: "new" },
  { id: "review.toggle", title: "Toggle review" },
]

describe("buildSlashCommands", () => {
  test("badges every row by source", () => {
    const list = buildSlashCommands({
      options,
      t,
      commands: [
        { name: "frontend", source: "skill", hints: [] },
        { name: "github:issue", source: "mcp", hints: ["$1", "$2"] },
        { name: "deploy", source: "command", hints: ["$ARGUMENTS"] },
        {
          name: "init",
          source: "command",
          template: "Create CLAUDE.md\n$ARGUMENTS",
          description: "initialize project with a CLAUDE.md guide",
        },
        {
          name: "review",
          source: "command",
          hints: ["$ARGUMENTS"],
          description: "review changes [commit|branch|pr], defaults to uncommitted",
        },
        { name: "plan", source: "command", agent: "plan", template: "$ARGUMENTS\n", hints: ["$ARGUMENTS"] },
      ],
    })

    expect(list.map((item) => [item.trigger, item.badge])).toEqual([
      ["frontend", "prompt.slash.badge.skill"],
      ["github:issue", "prompt.slash.badge.mcp"],
      ["deploy", "prompt.slash.badge.custom"],
      ["init", "prompt.slash.badge.builtin"],
      ["review", "prompt.slash.badge.builtin"],
      ["plan", "prompt.slash.badge.builtin"],
      ["new", "prompt.slash.badge.builtin"],
      ["compact", "prompt.slash.badge.builtin"],
    ])
    expect(list.find((item) => item.trigger === "github:issue")?.hint).toBe(
      "prompt.slash.hint.positional:1 prompt.slash.hint.positional:2",
    )
    expect(list.find((item) => item.trigger === "init")?.hints).toEqual(["$ARGUMENTS"])
    expect(list.find((item) => item.trigger === "compact")).toMatchObject({
      type: "builtin",
      aliases: ["summarize"],
      keywords: "summarize",
      hint: "[focus instructions]",
      keybind: "mod+k",
    })
  })

  test("an MCP prompt whose arguments did not reach the client counts as taking arguments", () => {
    // v1 bootstrap drops `hints` and `source`, and an MCP prompt's lazy template serializes to `{}`.
    const list = buildSlashCommands({
      options: [],
      t,
      commands: [
        { name: "github:create_issue", template: {} },
        { name: "notes", template: "Summarize my notes" },
      ],
    })
    const mcp = list.find((item) => item.trigger === "github:create_issue")
    expect(mcp?.hints?.length).toBeGreaterThan(0)
    expect(mcp?.hint).toBeUndefined()
    expect(list.find((item) => item.trigger === "notes")?.hints).toEqual([])
  })

  test("a user command that replaces init or review is not badged built-in", () => {
    const list = buildSlashCommands({
      options: [],
      t,
      commands: [
        { name: "review", template: "My own review of $ARGUMENTS", description: "team review checklist" },
        { name: "init", template: "Set up the repo" },
      ],
    })
    expect(list.map((item) => [item.trigger, item.badge])).toEqual([
      ["review", "prompt.slash.badge.custom"],
      ["init", "prompt.slash.badge.custom"],
    ])
  })

  test("a user plan command is custom", () => {
    const list = buildSlashCommands({
      options: [],
      t,
      commands: [{ name: "plan", source: "command", template: "Write a plan for $ARGUMENTS" }],
    })
    expect(list[0]?.badge).toBe("prompt.slash.badge.custom")
  })

  test("a server command hides the built-in and alias it shadows", () => {
    const list = buildSlashCommands({ options, t, commands: [{ name: "new" }, { name: "summarize" }] })

    expect(list.filter((item) => item.type === "builtin").map((item) => item.trigger)).toEqual(["compact"])
    expect(list.find((item) => item.id === "session.compact")?.aliases).toEqual([])

    const clear = buildSlashCommands({ options, t, commands: [{ name: "clear" }] })
    expect(clear.find((item) => item.id === "session.new")).toMatchObject({ aliases: ["reset"], keywords: "reset" })
    expect(slashTriggers(clear)).toEqual(["clear", "new", "reset", "compact", "summarize"])
  })
})

describe("formatSlashHints", () => {
  test("formats $ARGUMENTS and positional placeholders", () => {
    const en: SlashTranslate = (key, params) =>
      key === "prompt.slash.hint.arguments" ? "[arguments]" : `<arg${params?.n}>`
    expect(formatSlashHints(["$ARGUMENTS"], en)).toBe("[arguments]")
    expect(formatSlashHints(["$1", "$2"], en)).toBe("<arg1> <arg2>")
    expect(formatSlashHints(["$1", "$ARGUMENTS"], en)).toBe("[arguments]")
    expect(formatSlashHints([], en)).toBeUndefined()
  })

  test("reads placeholders from a template like the engine", () => {
    expect(templateHints("Fix $2 then $1 with $ARGUMENTS and $1")).toEqual(["$1", "$2", "$ARGUMENTS"])
    expect(templateHints(undefined)).toEqual([])
  })
})

describe("createSlashResolver", () => {
  test("resolves built-ins, aliases, server commands and catalog-only commands", () => {
    const resolve = createSlashResolver({
      options: () => options,
      commands: () => [{ name: "review" }],
      catalog: () => [
        { id: "session.undo", title: "Undo", slash: "undo" },
        { id: "session.compact", title: "Compact", slash: "compact" },
      ],
    })

    expect(resolve("/clear")).toEqual({ type: "builtin", id: "session.new", name: "clear", args: "" })
    expect(resolve("/new now")).toEqual({ type: "no-arguments", id: "session.new", name: "new" })
    expect(resolve("/compact focus")).toMatchObject({ type: "builtin", id: "session.compact", args: "focus" })
    expect(resolve("/review HEAD")).toEqual({ type: "server", name: "review", args: "HEAD" })
    expect(resolve("/share")).toEqual({ type: "unavailable", name: "share" })
    expect(resolve("/undo")).toEqual({ type: "unavailable", name: "undo" })
    expect(resolve("/revie")).toEqual({ type: "unknown", name: "revie" })
  })
})

describe("slashResolutionToast", () => {
  test("describes resolutions that cannot run", () => {
    expect(slashResolutionToast({ type: "unknown", name: "x" }, t)).toEqual({
      variant: "error",
      title: "prompt.slash.unknown.title:x",
      description: "prompt.slash.unknown.description",
    })
    expect(slashResolutionToast({ type: "unavailable", name: "x" }, t)?.title).toBe("prompt.slash.unavailable.title:x")
    expect(slashResolutionToast({ type: "no-arguments", id: "a", name: "x" }, t)?.title).toBe(
      "prompt.slash.noArguments.title:x",
    )
    expect(slashResolutionToast({ type: "server", name: "x", args: "" }, t)).toBeUndefined()
    expect(slashResolutionToast({ type: "text" }, t)).toBeUndefined()
  })
})
