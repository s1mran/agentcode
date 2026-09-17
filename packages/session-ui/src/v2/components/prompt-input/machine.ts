import { shouldOpenSlashPopover } from "@opencode-ai/core/util/slash"
import type { PromptInputV2HistoryEntry, PromptInputV2PersistedState, PromptInputV2Suggestion } from "./types"

/** How a suggestion was chosen: Enter runs, Tab only completes, click runs. */
export type PromptInputV2SelectVia = "enter" | "tab" | "click"

export type PromptInputV2InteractionState = {
  mode: "normal" | "shell"
  // `explicit` marks a command the user picked with the arrow keys, ctrl-n/p or the pointer; only then does Enter run
  // the active item instead of an exact name match.
  popover:
    | { type: "closed" }
    | { type: "context"; query: string; activeID?: string }
    | { type: "command-inline"; query: string; activeID?: string; explicit?: boolean }
    | { type: "command-menu"; query: string; activeID?: string; explicit?: boolean }
  drag: "idle" | "active"
  focus: "editor" | "command-search" | "external"
  activeContextID?: string
  historyIndex: number
  savedHistory?: PromptInputV2HistoryEntry
}

export type PromptInputV2InteractionEvent =
  | { type: "input.changed"; value: string; persist?: boolean; triggers?: readonly string[] }
  | { type: "commands.open" }
  | { type: "context.open" }
  | { type: "popover.query"; value: string }
  | { type: "popover.results"; ids: string[] }
  | { type: "popover.active"; id: string }
  | { type: "popover.close" }
  | { type: "popover.select"; item: PromptInputV2Suggestion; via?: PromptInputV2SelectVia }
  | {
      type: "key.down"
      key: string
      ctrl: boolean
      composing: boolean
      ids: string[]
      empty?: boolean
      /** The command whose name or alias exactly matches the command popover's query. */
      exactID?: string
    }
  | { type: "mode.shell" }
  | { type: "mode.normal" }
  | { type: "drag.enter" }
  | { type: "drag.leave" }
  | { type: "focus.editor" }
  | { type: "focus.external" }
  | { type: "context.active"; id: string }

export type PromptInputV2InteractionCommand =
  | { type: "draft.setText"; value: string }
  | { type: "mention.add"; item: PromptInputV2Suggestion }
  | { type: "popover.filter"; popover: "command" | "context"; query: string }
  | { type: "suggestion.select"; id: string; via: PromptInputV2SelectVia }
  | { type: "focus.editor" }
  | { type: "focus.command-search" }

export type PromptInputV2Transition = {
  state: PromptInputV2InteractionState
  commands: PromptInputV2InteractionCommand[]
  handled: boolean
}

export function createPromptInputV2InteractionState(): PromptInputV2InteractionState {
  return {
    mode: "normal",
    popover: { type: "closed" },
    drag: "idle",
    focus: "external",
    historyIndex: -1,
  }
}

export function transitionPromptInputV2(
  state: PromptInputV2InteractionState,
  event: PromptInputV2InteractionEvent,
  persisted: PromptInputV2PersistedState,
): PromptInputV2Transition {
  if (event.type === "input.changed") {
    return inputChanged(state, event.value, event.persist !== false, persisted.cursor, event.triggers)
  }
  if (event.type === "commands.open") return openCommands(state, persisted)
  if (event.type === "context.open") return openContext(state, persisted)
  if (event.type === "popover.query") return queryChanged(state, event.value)
  if (event.type === "popover.results") return resultsChanged(state, event.ids)
  if (event.type === "popover.active") return activeChanged(state, event.id)
  if (event.type === "popover.close") return changed({ ...state, popover: { type: "closed" } })
  if (event.type === "popover.select") return suggestionSelected(state, event.item, persisted)
  if (event.type === "key.down") return keyDown(state, event)
  if (event.type === "mode.shell") return changed({ ...state, mode: "shell", popover: { type: "closed" } })
  if (event.type === "mode.normal") return changed({ ...state, mode: "normal" })
  if (event.type === "drag.enter") return changed({ ...state, drag: "active" })
  if (event.type === "drag.leave") return changed({ ...state, drag: "idle" })
  if (event.type === "focus.editor") return changed({ ...state, focus: "editor" })
  if (event.type === "context.active") {
    return changed({ ...state, activeContextID: state.activeContextID === event.id ? undefined : event.id })
  }
  return changed({ ...state, focus: "external" })
}

function inputChanged(
  state: PromptInputV2InteractionState,
  value: string,
  persist: boolean,
  cursor: number | undefined,
  triggers: readonly string[] | undefined,
): PromptInputV2Transition {
  const setText: PromptInputV2InteractionCommand[] = persist ? [{ type: "draft.setText", value }] : []
  if (state.mode === "normal" && value === "!") {
    return changed({ ...state, mode: "shell", popover: { type: "closed" }, focus: "editor" }, [
      { type: "draft.setText", value: "" },
    ])
  }
  const context = value.slice(0, cursor ?? value.length).match(/(?:^|\s)@([^\s@]*)$/)
  if (context) {
    const query = context[1] ?? ""
    return changed({ ...state, popover: { type: "context", query }, focus: "editor" }, [
      ...setText,
      { type: "popover.filter", popover: "context", query },
    ])
  }

  const command = value.match(/^\/(\S*)$/)
  // A path such as `/Users/me/a.ts` keeps the popover closed so Enter sends it as text.
  if (command && shouldOpenSlashPopover(command[1] ?? "", triggers)) {
    const query = command[1] ?? ""
    return changed({ ...state, popover: { type: "command-inline", query }, focus: "editor" }, [
      ...setText,
      { type: "popover.filter", popover: "command", query },
    ])
  }

  return changed(
    { ...state, popover: state.popover.type === "command-menu" ? state.popover : { type: "closed" }, focus: "editor" },
    setText,
  )
}

function openCommands(
  state: PromptInputV2InteractionState,
  persisted: PromptInputV2PersistedState,
): PromptInputV2Transition {
  if (!populated(persisted)) {
    return changed({ ...state, popover: { type: "command-inline", query: "" }, focus: "editor" }, [
      { type: "draft.setText", value: promptText(persisted) + "/" },
      { type: "popover.filter", popover: "command", query: "" },
      { type: "focus.editor" },
    ])
  }
  return changed({ ...state, popover: { type: "command-menu", query: "" }, focus: "command-search" }, [
    { type: "popover.filter", popover: "command", query: "" },
    { type: "focus.command-search" },
  ])
}

function openContext(
  state: PromptInputV2InteractionState,
  persisted: PromptInputV2PersistedState,
): PromptInputV2Transition {
  return changed({ ...state, popover: { type: "context", query: "" }, focus: "editor" }, [
    { type: "draft.setText", value: promptText(persisted) + "@" },
    { type: "popover.filter", popover: "context", query: "" },
    { type: "focus.editor" },
  ])
}

function queryChanged(state: PromptInputV2InteractionState, query: string): PromptInputV2Transition {
  if (state.popover.type === "closed") return unchanged(state)
  const popover = state.popover.type === "context" ? "context" : "command"
  return changed({ ...state, popover: { ...activate(state.popover, undefined), query } }, [
    { type: "popover.filter", popover, query },
  ])
}

function resultsChanged(state: PromptInputV2InteractionState, ids: string[]): PromptInputV2Transition {
  if (state.popover.type === "closed") return unchanged(state)
  const activeID = state.popover.activeID && ids.includes(state.popover.activeID) ? state.popover.activeID : ids[0]
  if (activeID === state.popover.activeID) return unchanged(state)
  return changed({ ...state, popover: activate(state.popover, activeID) })
}

function activeChanged(state: PromptInputV2InteractionState, id: string): PromptInputV2Transition {
  if (state.popover.type === "closed") return unchanged(state)
  // Pointer hover over a command is an explicit pick.
  const explicit = state.popover.type !== "context"
  if (state.popover.activeID === id && (!explicit || popoverExplicit(state.popover))) return unchanged(state)
  return changed({ ...state, popover: activate(state.popover, id, explicit) })
}

function suggestionSelected(
  state: PromptInputV2InteractionState,
  item: PromptInputV2Suggestion,
  persisted: PromptInputV2PersistedState,
): PromptInputV2Transition {
  const current = promptText(persisted)
  const commands: PromptInputV2InteractionCommand[] = []
  if (item.kind === "command") {
    commands.push({
      type: "draft.setText",
      value:
        state.popover.type === "command-menu"
          ? current.trim()
            ? `${item.label} ${current.trim()}`
            : `${item.label} `
          : replaceTrigger(current, "/", `${item.label} `),
    })
  } else {
    commands.push({ type: "mention.add", item })
  }
  commands.push({ type: "focus.editor" })
  return changed({ ...state, popover: { type: "closed" }, focus: "editor" }, commands)
}

function keyDown(
  state: PromptInputV2InteractionState,
  event: Extract<PromptInputV2InteractionEvent, { type: "key.down" }>,
): PromptInputV2Transition {
  if (event.ctrl && event.key.toLowerCase() === "g") {
    if (state.popover.type === "closed") return unchanged(state)
    return changed({ ...state, popover: { type: "closed" }, focus: "editor" }, [{ type: "focus.editor" }], true)
  }
  if (state.popover.type === "closed") {
    if (state.mode === "shell" && (event.key === "Escape" || (event.key === "Backspace" && event.empty))) {
      return changed({ ...state, mode: "normal" }, [], true)
    }
    return unchanged(state)
  }
  if (event.key === "Escape") {
    return changed({ ...state, popover: { type: "closed" }, focus: "editor" }, [{ type: "focus.editor" }], true)
  }
  if (event.key === "Tab") {
    if (!state.popover.activeID) return unchanged(state, true)
    return unchanged(state, true, [{ type: "suggestion.select", id: state.popover.activeID, via: "tab" }])
  }
  if (event.key === "Enter" && !event.composing) {
    if (state.popover.type === "context") {
      if (!state.popover.activeID) return unchanged(state, true)
      return unchanged(state, true, [{ type: "suggestion.select", id: state.popover.activeID, via: "enter" }])
    }
    // Enter runs the highlighted row: in the searchable menu the active row, in the inline popover only a picked
    // command or an exact name, so a partial `/name` is left for submit to report as unknown.
    const target = highlightedSuggestionID(state.popover, event.exactID)
    if (target) return unchanged(state, true, [{ type: "suggestion.select", id: target, via: "enter" }])
    if (state.popover.type === "command-inline" && state.popover.query) {
      return changed({ ...state, popover: { type: "closed" } }, [], false)
    }
    return unchanged(state, true)
  }
  const direction =
    event.key === "ArrowDown" || (event.ctrl && event.key === "n")
      ? 1
      : event.key === "ArrowUp" || (event.ctrl && event.key === "p")
        ? -1
        : 0
  if (!direction || event.ids.length === 0) return unchanged(state)
  // Arrows move from the highlighted row, so the first press in an unhighlighted inline popover lands on the first row.
  const highlighted = highlightedSuggestionID(state.popover, event.exactID)
  const current = highlighted ? event.ids.indexOf(highlighted) : -1
  const index =
    current < 0
      ? direction === 1
        ? 0
        : event.ids.length - 1
      : (current + direction + event.ids.length) % event.ids.length
  return changed(
    { ...state, popover: activate(state.popover, event.ids[index], state.popover.type !== "context") },
    [],
    true,
  )
}

/**
 * The suggestion to show as highlighted, which is the one Enter runs: the active row of the context popover and the
 * searchable command menu, and in the inline command popover only a picked command or the exact name match.
 */
export function highlightedSuggestionID(popover: PromptInputV2InteractionState["popover"], exactID?: string) {
  if (popover.type === "closed") return
  if (popover.type !== "command-inline" || popover.explicit) return popover.activeID ?? exactID
  return exactID
}

type OpenPopover = Exclude<PromptInputV2InteractionState["popover"], { type: "closed" }>

function popoverExplicit(popover: OpenPopover) {
  return popover.type !== "context" && !!popover.explicit
}

/** Sets the active item; `explicit` is kept on command popovers only when true, and dropped otherwise. */
function activate(popover: OpenPopover, activeID: string | undefined, explicit = false): OpenPopover {
  if (popover.type === "context") return { ...popover, activeID }
  const { explicit: _previous, ...rest } = popover
  return explicit ? { ...rest, activeID, explicit: true } : { ...rest, activeID }
}

function promptText(persisted: PromptInputV2PersistedState) {
  return persisted.prompt.map((part) => (part.type === "text" ? part.content : "")).join("")
}

function populated(persisted: PromptInputV2PersistedState) {
  return (
    !!promptText(persisted).trim() ||
    persisted.context.items.length > 0 ||
    persisted.prompt.some((part) => part.type === "file" || part.type === "image")
  )
}

function replaceTrigger(value: string, trigger: "@" | "/", replacement: string) {
  const index = trigger === "/" ? value.indexOf(trigger) : value.lastIndexOf(trigger)
  return index < 0 ? replacement : value.slice(0, index) + replacement
}

function changed(
  state: PromptInputV2InteractionState,
  commands: PromptInputV2InteractionCommand[] = [],
  handled = false,
): PromptInputV2Transition {
  return { state, commands, handled }
}

function unchanged(
  state: PromptInputV2InteractionState,
  handled = false,
  commands: PromptInputV2InteractionCommand[] = [],
): PromptInputV2Transition {
  return { state, commands, handled }
}
