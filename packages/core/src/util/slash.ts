// Slash command parsing shared by the desktop composers and the engine, so the rules for what counts as a command,
// an unknown command or plain text cannot drift between them.

/** Commands a single message can run: the head plus up to five chained ones (`/a /b do XYZ`). */
export const MAX_SKILL_CHAIN = 6

export type SlashParse = { name: string; args: string }

/** Splits `/name args` into the command name and its arguments; undefined when the text is not a slash command. */
export function parseSlash(text: string): SlashParse | undefined {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text)
  if (!match?.[1]) return
  return { name: match[1], args: (match[2] ?? "").trim() }
}

/** Whether a slash name could be a command: letters, digits and `_` followed by `_ : . - /` separators too. */
export function looksLikeCommandName(name: string) {
  return /^[\p{L}\p{N}_][\p{L}\p{N}_:.\-/]*$/u.test(name)
}

/** Whether a slash name reads as a file path (`/Users/me/x.ts`, `/tmp/x`, `./a`, `~/b`, `foo.ts`) rather than a command. */
export function isPathLikeSlash(name: string) {
  if (name.includes("/") || name.includes("\\")) return true
  if (name.startsWith(".") || name.startsWith("~")) return true
  return /\.[A-Za-z0-9]{1,8}$/.test(name)
}

export type SlashEntry = { trigger: string; aliases?: readonly string[] }

/** Case-insensitive match of a typed name against a command's trigger or any of its aliases. */
export function slashNameMatches(entry: SlashEntry, query: string) {
  const needle = query.toLowerCase()
  if (entry.trigger.toLowerCase() === needle) return true
  return !!entry.aliases?.some((alias) => alias.toLowerCase() === needle)
}

/** Whether typing `/query` should open the slash popover; path-like input that matches no command keeps it closed. */
export function shouldOpenSlashPopover(query: string, triggers?: readonly string[]) {
  if (!triggers) return true
  if (query === "") return true
  const needle = query.toLowerCase()
  if (triggers.some((trigger) => trigger.toLowerCase().startsWith(needle))) return true
  return looksLikeCommandName(query) && !isPathLikeSlash(query)
}

export type SlashBuiltin = {
  id: string
  /** The slash name first, then its aliases. */
  names: readonly string[]
  disabled?: boolean
  takesArguments?: boolean
}

export type SlashResolution =
  | { type: "text" }
  | { type: "server"; name: string; args: string }
  | { type: "builtin"; id: string; name: string; args: string }
  | { type: "no-arguments"; id: string; name: string }
  | { type: "unavailable"; name: string }
  | { type: "unknown"; name: string }

/**
 * Finds the server command a typed name means: the exact-case name first, then the one command whose name matches
 * ignoring case. An ambiguous case-insensitive name matches none, so the result is always the command's real name.
 */
export function findServerCommand<T extends { name: string }>(commands: readonly T[], name: string): T | undefined {
  const exact = commands.find((command) => command.name === name)
  if (exact) return exact
  const needle = name.toLowerCase()
  const matches = commands.filter((command) => command.name.toLowerCase() === needle)
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * Decides what a submitted message is. Server commands (commands, skills, MCP prompts) win over client built-ins with
 * the same name, matched as `findServerCommand` does and reported by their real name; a name that matches nothing is
 * unknown unless it reads as a path, which is sent as text.
 */
export function resolveSlash(
  text: string,
  input: { commands: readonly { name: string }[]; builtins: readonly SlashBuiltin[] },
): SlashResolution {
  const parsed = parseSlash(text)
  if (!parsed) return { type: "text" }
  const { name, args } = parsed
  const server = findServerCommand(input.commands, name)
  if (server) return { type: "server", name: server.name, args }
  const needle = name.toLowerCase()
  const matches = input.builtins.filter((builtin) => builtin.names.some((item) => item.toLowerCase() === needle))
  const enabled = matches.find((builtin) => !builtin.disabled)
  if (enabled) {
    if (args && !enabled.takesArguments) return { type: "no-arguments", id: enabled.id, name }
    return { type: "builtin", id: enabled.id, name, args }
  }
  if (matches.length > 0) return { type: "unavailable", name }
  if (!looksLikeCommandName(name) || isPathLikeSlash(name)) return { type: "text" }
  return { type: "unknown", name }
}

/**
 * Takes the leading `/name` tokens of a command's arguments while they name chainable commands, up to `max` of them.
 * `rest` is the remaining text, which every command in the chain receives.
 */
export function splitSlashChain(
  args: string,
  chainable: (name: string) => boolean,
  max = MAX_SKILL_CHAIN - 1,
): { names: string[]; rest: string } {
  const names: string[] = []
  let rest = args.trimStart()
  while (names.length < max) {
    const match = /^\/(\S+)(?:\s+|$)/.exec(rest)
    if (!match?.[1] || !chainable(match[1])) break
    names.push(match[1])
    rest = rest.slice(match[0].length)
  }
  return { names, rest: rest.trim() }
}
