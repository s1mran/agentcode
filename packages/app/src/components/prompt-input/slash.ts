import type { Accessor } from "solid-js"
import { resolveSlash, type SlashResolution } from "@opencode-ai/core/util/slash"
import { slashBuiltins, type CommandCatalogItem, type CommandOption } from "@/context/command"
import { isBuiltinPlanCommand } from "./permission-mode-controls"
import type { SlashCommand } from "./slash-popover"

/**
 * Engine commands that ship with AgentCode, by name and the descriptions the engine gives them. The engine sends no
 * built-in flag, and a user command, skill or MCP prompt with the same name replaces the built-in, so the name alone
 * does not identify one.
 */
export const ENGINE_BUILTIN_COMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["init", new Set(["initialize project with a CLAUDE.md guide", "initialize project with an AGENTS.md guide"])],
  ["review", new Set(["review changes [commit|branch|pr], defaults to uncommitted"])],
])

function isEngineBuiltin(command: SlashServerCommand) {
  if (command.source && command.source !== "command") return false
  return !!command.description && !!ENGINE_BUILTIN_COMMANDS.get(command.name)?.has(command.description)
}

type SlashKey =
  | "prompt.slash.badge.builtin"
  | "prompt.slash.badge.custom"
  | "prompt.slash.badge.skill"
  | "prompt.slash.badge.mcp"
  | "prompt.slash.hint.arguments"
  | "prompt.slash.hint.positional"
  | "prompt.slash.unknown.title"
  | "prompt.slash.unknown.description"
  | "prompt.slash.unavailable.title"
  | "prompt.slash.noArguments.title"

export type SlashTranslate = (key: SlashKey, params?: Record<string, string | number>) => string

/** A server command as the composers read it from sync; `source` and `hints` are absent on servers that omit them. */
export type SlashServerCommand = {
  name: string
  description?: string
  agent?: string
  template?: unknown
  source?: "command" | "mcp" | "skill"
  hints?: readonly string[]
}

/** The argument placeholders a template uses, the same way the engine's Command.hints reads them. */
export function templateHints(template: unknown) {
  if (typeof template !== "string") return []
  const numbered = [...new Set(template.match(/\$\d+/g) ?? [])].sort()
  return template.includes("$ARGUMENTS") ? [...numbered, "$ARGUMENTS"] : numbered
}

/** The menu hint for a command's placeholders: `[arguments]` for $ARGUMENTS, `<arg1> <arg2>` for positionals. */
export function formatSlashHints(hints: readonly string[], t: SlashTranslate) {
  if (hints.includes("$ARGUMENTS")) return t("prompt.slash.hint.arguments")
  const positional = hints.filter((hint) => /^\$\d+$/.test(hint))
  if (positional.length === 0) return
  return positional.map((hint) => t("prompt.slash.hint.positional", { n: hint.slice(1) })).join(" ")
}

function customBadge(command: SlashServerCommand): SlashKey {
  if (command.source === "skill") return "prompt.slash.badge.skill"
  if (command.source === "mcp") return "prompt.slash.badge.mcp"
  const template = typeof command.template === "string" ? command.template : undefined
  if (isEngineBuiltin(command) || isBuiltinPlanCommand({ ...command, template })) {
    return "prompt.slash.badge.builtin"
  }
  return "prompt.slash.badge.custom"
}

/**
 * The slash menu for both composers: server commands first, then the desktop built-ins. A server command shadows a
 * built-in (or alias) with the same name, as it does when the name is typed.
 */
export function buildSlashCommands(input: {
  options: CommandOption[]
  commands: readonly SlashServerCommand[]
  t: SlashTranslate
}): SlashCommand[] {
  const names = new Set(input.commands.map((command) => command.name))
  // The engine's plan command stays listed so picking it inserts `/plan `; submit turns it into Plan mode.
  const custom = input.commands.map((command): SlashCommand => {
    // Without `hints` a template that is not a string (an MCP prompt's lazy template reaches JSON as `{}`) says nothing
    // about arguments, so the command counts as taking some: picking it inserts `/name ` instead of running it bare.
    const known = command.hints ?? (typeof command.template === "string" ? templateHints(command.template) : undefined)
    const hints = known ? [...known] : ["$ARGUMENTS"]
    return {
      id: `custom.${command.name}`,
      trigger: command.name,
      aliases: [],
      keywords: "",
      title: command.name,
      description: command.description,
      type: "custom",
      source: command.source,
      hints,
      hint: known ? formatSlashHints(known, input.t) : undefined,
      badge: input.t(customBadge(command)),
    }
  })
  const builtin = input.options
    .filter((option) => !option.disabled && !option.id.startsWith("suggested.") && !!option.slash)
    .filter((option) => !names.has(option.slash!))
    .map((option): SlashCommand => {
      const aliases = (option.slashAliases ?? []).filter((alias) => !names.has(alias))
      return {
        id: option.id,
        trigger: option.slash!,
        aliases,
        keywords: aliases.join(" "),
        title: option.title,
        description: option.description,
        keybind: option.keybind,
        type: "builtin",
        hint: option.argumentHint,
        badge: input.t("prompt.slash.badge.builtin"),
      }
    })
  return [...custom, ...builtin]
}

/**
 * Resolves a submitted message against the server commands and the registered built-ins. Built-ins that are known from
 * the command catalog but not registered on this page (session commands on a new-session draft) count as unavailable.
 */
export function createSlashResolver(input: {
  options: Accessor<CommandOption[]>
  commands: Accessor<readonly { name: string }[]>
  catalog?: Accessor<(CommandCatalogItem & { id: string })[]>
}) {
  return (text: string): SlashResolution => {
    const builtins = slashBuiltins(input.options())
    const registered = new Set(builtins.map((builtin) => builtin.id))
    const known = (input.catalog?.() ?? [])
      .filter((item) => !!item.slash && !registered.has(item.id))
      .map((item) => ({ id: item.id, names: [item.slash!], disabled: true }))
    return resolveSlash(text, { commands: input.commands(), builtins: [...builtins, ...known] })
  }
}

/** Every slash name the menu can match, aliases included. */
export function slashTriggers(list: readonly { trigger: string; aliases?: readonly string[] }[]) {
  return list.flatMap((item) => [item.trigger, ...(item.aliases ?? [])])
}

/** The error toast for a slash message that cannot run, or undefined when it can be sent. */
export function slashResolutionToast(resolution: SlashResolution, t: SlashTranslate) {
  if (resolution.type === "unknown") {
    return {
      variant: "error" as const,
      title: t("prompt.slash.unknown.title", { name: resolution.name }),
      description: t("prompt.slash.unknown.description"),
    }
  }
  if (resolution.type === "unavailable") {
    return { variant: "error" as const, title: t("prompt.slash.unavailable.title", { name: resolution.name }) }
  }
  if (resolution.type === "no-arguments") {
    return { variant: "error" as const, title: t("prompt.slash.noArguments.title", { name: resolution.name }) }
  }
}
