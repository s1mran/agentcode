import { describe, expect, test } from "bun:test"
import type { PromptInputV2PersistedState, PromptInputV2Suggestion } from "./types"
import { createPromptInputV2InteractionState, highlightedSuggestionID, transitionPromptInputV2 } from "./machine"

const command: PromptInputV2Suggestion = {
  id: "review",
  kind: "command",
  label: "/review",
}

function persisted(value = ""): PromptInputV2PersistedState {
  return {
    prompt: [{ type: "text", content: value, start: 0, end: value.length }],
    cursor: value.length,
    context: { items: [] },
  }
}

describe("prompt input v2 interaction machine", () => {
  test("opens inline commands only when slash is the entire prompt", () => {
    const state = createPromptInputV2InteractionState()
    const open = transitionPromptInputV2(state, { type: "input.changed", value: "/re" }, persisted())
    const closed = transitionPromptInputV2(state, { type: "input.changed", value: "explain /re" }, persisted())

    expect(open.state.popover).toEqual({ type: "command-inline", query: "re" })
    expect(closed.state.popover).toEqual({ type: "closed" })
  })

  test("completes nested slash command names", () => {
    const open = transitionPromptInputV2(
      createPromptInputV2InteractionState(),
      { type: "input.changed", value: "/review/" },
      persisted(),
    )
    const item = { ...command, label: "/review/nested" }
    const selected = transitionPromptInputV2(open.state, { type: "popover.select", item }, persisted("/review/"))

    expect(open.state.popover).toEqual({ type: "command-inline", query: "review/" })
    expect(selected.commands).toContainEqual({ type: "draft.setText", value: "/review/nested " })
  })

  test("opens context completion at the cursor", () => {
    const value = "alpha @sr omega"
    const input = persisted(value)
    input.cursor = 9

    const result = transitionPromptInputV2(
      createPromptInputV2InteractionState(),
      { type: "input.changed", value, persist: false },
      input,
    )

    expect(result.state.popover).toEqual({ type: "context", query: "sr" })
  })

  test("enters shell mode from an initial exclamation mark", () => {
    const result = transitionPromptInputV2(
      createPromptInputV2InteractionState(),
      { type: "input.changed", value: "!", persist: false },
      persisted("!"),
    )

    expect(result.state.mode).toBe("shell")
    expect(result.commands).toContainEqual({ type: "draft.setText", value: "" })
  })

  test("leaves shell mode with escape", () => {
    const state = { ...createPromptInputV2InteractionState(), mode: "shell" as const }
    const result = transitionPromptInputV2(
      state,
      { type: "key.down", key: "Escape", ctrl: false, composing: false, ids: [] },
      persisted(),
    )

    expect(result.state.mode).toBe("normal")
    expect(result.handled).toBeTrue()
  })

  test("leaves shell mode with backspace when empty", () => {
    const state = { ...createPromptInputV2InteractionState(), mode: "shell" as const }
    const result = transitionPromptInputV2(
      state,
      { type: "key.down", key: "Backspace", ctrl: false, composing: false, ids: [], empty: true },
      persisted(),
    )

    expect(result.state.mode).toBe("normal")
    expect(result.handled).toBeTrue()
  })

  test("closes a popover with ctrl-g before stopping a run", () => {
    const state = {
      ...createPromptInputV2InteractionState(),
      popover: { type: "context" as const, query: "", activeID: "first" },
    }
    const result = transitionPromptInputV2(
      state,
      { type: "key.down", key: "g", ctrl: true, composing: false, ids: ["first"] },
      persisted(),
    )

    expect(result.state.popover).toEqual({ type: "closed" })
    expect(result.handled).toBeTrue()
  })

  test("opens the searchable command menu for a populated draft", () => {
    const result = transitionPromptInputV2(
      createPromptInputV2InteractionState(),
      { type: "commands.open" },
      persisted("existing text"),
    )

    expect(result.state.popover).toEqual({ type: "command-menu", query: "" })
    expect(result.state.focus).toBe("command-search")
  })

  test("prepends a menu command and preserves existing text as arguments", () => {
    const open = transitionPromptInputV2(
      createPromptInputV2InteractionState(),
      { type: "commands.open" },
      persisted("existing text"),
    )
    const selected = transitionPromptInputV2(
      open.state,
      { type: "popover.select", item: command },
      persisted("existing text"),
    )

    expect(selected.commands).toContainEqual({ type: "draft.setText", value: "/review existing text" })
    expect(selected.state.popover).toEqual({ type: "closed" })
  })

  test("stores selected context files as prompt file parts", () => {
    const item: PromptInputV2Suggestion = {
      id: "src/index.ts",
      kind: "file",
      label: "index.ts",
      path: "src/index.ts",
    }
    const state = {
      ...createPromptInputV2InteractionState(),
      popover: { type: "context" as const, query: "index" },
    }

    const selected = transitionPromptInputV2(state, { type: "popover.select", item }, persisted("@index"))

    expect(selected.commands).toContainEqual({ type: "mention.add", item })
  })

  test("loops active popover items with arrow keys", () => {
    const state = {
      ...createPromptInputV2InteractionState(),
      popover: { type: "context" as const, query: "", activeID: "second" },
    }
    const result = transitionPromptInputV2(
      state,
      { type: "key.down", key: "ArrowDown", ctrl: false, composing: false, ids: ["first", "second"] },
      persisted(),
    )

    expect(result.state.popover).toEqual({ type: "context", query: "", activeID: "first" })
    expect(result.handled).toBeTrue()
  })

  test("Enter on a partial command name closes the popover unhandled so submit can report it", () => {
    const state = {
      ...createPromptInputV2InteractionState(),
      popover: { type: "command-inline" as const, query: "compa", activeID: "session.compact" },
    }
    const result = transitionPromptInputV2(
      state,
      { type: "key.down", key: "Enter", ctrl: false, composing: false, ids: ["session.compact"] },
      persisted("/compa"),
    )

    expect(result.state.popover).toEqual({ type: "closed" })
    expect(result.handled).toBeFalse()
    expect(result.commands).toEqual([])
  })

  test("Enter selects the exact command match", () => {
    const state = {
      ...createPromptInputV2InteractionState(),
      popover: { type: "command-inline" as const, query: "compact", activeID: "custom.compactor" },
    }
    const result = transitionPromptInputV2(
      state,
      {
        type: "key.down",
        key: "Enter",
        ctrl: false,
        composing: false,
        ids: ["custom.compactor", "session.compact"],
        exactID: "session.compact",
      },
      persisted("/compact"),
    )

    expect(result.handled).toBeTrue()
    expect(result.commands).toEqual([{ type: "suggestion.select", id: "session.compact", via: "enter" }])
  })

  test("ArrowDown then Enter selects the active command", () => {
    const state = {
      ...createPromptInputV2InteractionState(),
      popover: { type: "command-inline" as const, query: "co", activeID: "first" },
    }
    const ids = ["first", "second"]
    const key = (name: string) => ({ type: "key.down" as const, key: name, ctrl: false, composing: false, ids })
    // Nothing is highlighted for a partial name, so the first ArrowDown highlights the first row.
    const moved = transitionPromptInputV2(state, key("ArrowDown"), persisted("/co"))
    const again = transitionPromptInputV2(moved.state, key("ArrowDown"), persisted("/co"))
    const result = transitionPromptInputV2(again.state, key("Enter"), persisted("/co"))

    expect(moved.state.popover).toEqual({ type: "command-inline", query: "co", activeID: "first", explicit: true })
    expect(again.state.popover).toEqual({ type: "command-inline", query: "co", activeID: "second", explicit: true })
    expect(result.commands).toEqual([{ type: "suggestion.select", id: "second", via: "enter" }])
  })

  test("pointer hover marks a command as explicitly picked", () => {
    const state = {
      ...createPromptInputV2InteractionState(),
      popover: { type: "command-inline" as const, query: "", activeID: "first" },
    }
    const hovered = transitionPromptInputV2(state, { type: "popover.active", id: "second" }, persisted("/"))
    const same = transitionPromptInputV2(state, { type: "popover.active", id: "first" }, persisted("/"))

    expect(hovered.state.popover).toEqual({ type: "command-inline", query: "", activeID: "second", explicit: true })
    expect(same.state.popover).toEqual({ type: "command-inline", query: "", activeID: "first", explicit: true })
  })

  test("a new result list drops the explicit pick when the active command is gone", () => {
    const state = {
      ...createPromptInputV2InteractionState(),
      popover: { type: "command-inline" as const, query: "c", activeID: "second", explicit: true },
    }
    const kept = transitionPromptInputV2(state, { type: "popover.results", ids: ["first", "second"] }, persisted())
    const dropped = transitionPromptInputV2(state, { type: "popover.results", ids: ["first"] }, persisted())

    expect(kept.state.popover).toEqual(state.popover)
    expect(dropped.state.popover).toEqual({ type: "command-inline", query: "c", activeID: "first" })
    expect("explicit" in dropped.state.popover).toBeFalse()
  })

  test("Tab selects the active suggestion for completion only", () => {
    const state = {
      ...createPromptInputV2InteractionState(),
      popover: { type: "command-inline" as const, query: "comp", activeID: "session.compact" },
    }
    const result = transitionPromptInputV2(
      state,
      { type: "key.down", key: "Tab", ctrl: false, composing: false, ids: ["session.compact"] },
      persisted("/comp"),
    )

    expect(result.handled).toBeTrue()
    expect(result.commands).toEqual([{ type: "suggestion.select", id: "session.compact", via: "tab" }])
  })

  test("keeps the command popover closed for paths that match no command", () => {
    const result = transitionPromptInputV2(
      createPromptInputV2InteractionState(),
      { type: "input.changed", value: "/Users/me/x", triggers: ["review"] },
      persisted(),
    )

    expect(result.state.popover).toEqual({ type: "closed" })
  })

  test("opens the command popover for a nested command prefix", () => {
    const result = transitionPromptInputV2(
      createPromptInputV2InteractionState(),
      { type: "input.changed", value: "/review/", triggers: ["review/nested"] },
      persisted(),
    )

    expect(result.state.popover).toEqual({ type: "command-inline", query: "review/" })
  })

  test("Enter on an empty command query is handled and does nothing", () => {
    const state = {
      ...createPromptInputV2InteractionState(),
      popover: { type: "command-inline" as const, query: "", activeID: "first" },
    }
    const result = transitionPromptInputV2(
      state,
      { type: "key.down", key: "Enter", ctrl: false, composing: false, ids: ["first"] },
      persisted("/"),
    )

    expect(result.handled).toBeTrue()
    expect(result.commands).toEqual([])
    expect(result.state.popover).toEqual(state.popover)
  })
  test("Enter in the searchable command menu runs the highlighted row for a partial query", () => {
    const state = {
      ...createPromptInputV2InteractionState(),
      popover: { type: "command-menu" as const, query: "comp", activeID: "session.compact" },
    }
    const result = transitionPromptInputV2(
      state,
      { type: "key.down", key: "Enter", ctrl: false, composing: false, ids: ["session.compact"] },
      persisted("draft text"),
    )

    expect(result.handled).toBeTrue()
    expect(result.commands).toEqual([{ type: "suggestion.select", id: "session.compact", via: "enter" }])
  })

  test("the inline command popover highlights only the row Enter would run", () => {
    const inline = { type: "command-inline" as const, query: "rev", activeID: "review" }
    expect(highlightedSuggestionID(inline)).toBeUndefined()
    expect(highlightedSuggestionID({ ...inline, explicit: true })).toBe("review")
    expect(highlightedSuggestionID({ ...inline, query: "review" }, "review")).toBe("review")
    expect(highlightedSuggestionID({ type: "command-menu", query: "rev", activeID: "review" })).toBe("review")
    expect(highlightedSuggestionID({ type: "context", query: "", activeID: "file:a" })).toBe("file:a")
    expect(highlightedSuggestionID({ type: "closed" })).toBeUndefined()
  })

  test("ArrowDown from an unhighlighted inline popover lands on the first row", () => {
    const state = {
      ...createPromptInputV2InteractionState(),
      popover: { type: "command-inline" as const, query: "", activeID: "first" },
    }
    const down = transitionPromptInputV2(
      state,
      { type: "key.down", key: "ArrowDown", ctrl: false, composing: false, ids: ["first", "second"] },
      persisted("/"),
    )
    const up = transitionPromptInputV2(
      state,
      { type: "key.down", key: "ArrowUp", ctrl: false, composing: false, ids: ["first", "second"] },
      persisted("/"),
    )

    expect(down.state.popover).toEqual({ type: "command-inline", query: "", activeID: "first", explicit: true })
    expect(up.state.popover).toEqual({ type: "command-inline", query: "", activeID: "second", explicit: true })
  })
})
