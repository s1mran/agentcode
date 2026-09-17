export * as PermissionLaunchMode from "./launch-mode"

/**
 * The permission mode an engine was launched with. `agentcode --permission-mode` hands it to the worker in this
 * variable, and config reads it as the global-scope default_permission_mode. It is that engine's setting only: a child
 * process that inherits it (a terminal, a shell command, an MCP or language server, an install script) would start any
 * nested agent in the parent's mode, bypassPermissions included, without the user choosing that.
 */
export const ENV_KEY = "OPENCODE_PERMISSION_MODE"

let claimed: string | undefined

/**
 * Moves the variable out of `process.env` into this module, so no child process can inherit it whichever way its
 * environment is built (`{ ...process.env }` copies, extendEnv, Bun's `$`, PTYs). The worker calls this at startup.
 * `read()` keeps returning the value, because config is loaded again for every instance.
 */
export function claim() {
  const value = process.env[ENV_KEY]
  if (value === undefined) return
  claimed = value
  delete process.env[ENV_KEY]
}

/** The launch mode, unvalidated: the variable while it is set, otherwise the value `claim()` took. */
export function read(): string | undefined {
  return process.env[ENV_KEY] ?? claimed
}

/** A copy of `env` without the variable, for a child process environment built from this process's own. */
export function inherited(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { [ENV_KEY]: _mode, ...rest } = env
  return rest
}
