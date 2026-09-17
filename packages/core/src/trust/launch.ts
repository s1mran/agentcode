export * as WorkspaceTrustLaunch from "./launch"

/**
 * How an engine treats a folder nobody has decided about yet, and whether a stored decision applies at all. Set per
 * process in OPENCODE_WORKSPACE_TRUST, or in memory by a CLI entry point (`run --trust`, `acp`, `agentcode trust`).
 *
 * - `prompt` (default): an untrusted or unknown folder runs restricted until a client records a decision. The repo's
 *   plugins, custom tools, MCP servers, allow rules, shell commands and other executable settings are held. Nothing
 *   waits for the answer, so no entry point can hang.
 * - `headless`: Claude Code `-p` parity. Project plugins, tools, MCP servers, commands and agents load; project allow
 *   rules and `default_permission_mode: acceptEdits` do not.
 * - `trusted`: full trust for this process only. Never written to the trust store.
 * - `untrusted`: restricted even when a stored decision says trusted, for CI on fork pull requests.
 *
 * The variable is this engine's setting only. `claim()` moves it out of the environment so a child process (a shell
 * command, an MCP or language server, a nested agentcode) never inherits a `trusted` policy it did not ask for.
 */
export const ENV_KEY = "OPENCODE_WORKSPACE_TRUST"

export const POLICIES = ["prompt", "headless", "trusted", "untrusted"] as const
export type Policy = (typeof POLICIES)[number]

let override: Policy | undefined
let claimed: string | undefined
let invalid: string | undefined
let warned = false

export function isPolicy(value: unknown): value is Policy {
  return typeof value === "string" && (POLICIES as readonly string[]).includes(value)
}

/** Sets the policy for this process in memory, ahead of the variable. `undefined` clears the override. */
export function set(policy: Policy | undefined) {
  override = policy
}

/** Moves the variable out of `process.env` into this module. `read()` keeps returning it. */
export function claim() {
  const value = process.env[ENV_KEY]
  if (value === undefined) return
  claimed = value
  delete process.env[ENV_KEY]
}

/** Forgets the override and any claimed value (tests only; a CLI process claims once at startup). */
export function reset() {
  override = undefined
  claimed = undefined
}

/** The value `claim()` moved out of the environment, for handing to a worker that runs this same engine. */
export function claimedValue(): string | undefined {
  return claimed
}

/** The raw variable while it is set, otherwise the value `claim()` took. */
export function raw(): string | undefined {
  return process.env[ENV_KEY] ?? claimed
}

/** The policy from the variable alone, or undefined when it is unset or not a policy. */
export function fromEnv(): Policy | undefined {
  const value = raw()?.trim().toLowerCase()
  if (!value) return
  if (isPolicy(value)) return value
  invalid = raw()
}

/** The effective policy: the in-memory override, then the variable, then `prompt`. */
export function read(): Policy {
  if (override) return override
  return fromEnv() ?? "prompt"
}

/** The invalid variable value, once per process, so a caller can log it where logs go. */
export function takeWarning(): string | undefined {
  if (warned || invalid === undefined) return
  warned = true
  return invalid
}

/** A copy of `env` without the variable, for a child process environment built from this process's own. */
export function inherited(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { [ENV_KEY]: _policy, ...rest } = env
  return rest
}
