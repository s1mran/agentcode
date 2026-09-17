export * as CredentialEnv from "./credential-env"

import { PermissionLaunchMode } from "@opencode-ai/core/permission/launch-mode"
import { WorkspaceTrustLaunch } from "@opencode-ai/core/trust/launch"

/**
 * Credential handling for configuration a repository supplies.
 *
 * - `stripCredentials` builds the environment of an MCP server a project config declares: every credential-like name is
 *   removed, trusted folder or not, so a repo cannot start a process that reads the user's keys from its environment.
 *   The server's own `environment` entries still apply on top.
 * - In restricted mode, `COVERED` names and every credential-like name read as empty when project config text
 *   substitutes them with `{env:NAME}`. A trusted folder or a headless run substitutes them normally, like Claude Code.
 */

const CREDENTIAL = /TOKEN|SECRET|PASSWORD|PASSWD|KEY|AUTH|CREDENTIAL/i

// Names that match the pattern but carry no secret: identities, sockets and paths a process running as the user can
// reach anyway, and tool settings. Stripping them only breaks servers (git over ssh, X11). GIT_CONFIG_KEY_<n> is kept
// for Claude Code parity.
const SAFE = new Set([
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
  "KEYTIMEOUT",
  "SSH_AUTH_SOCK",
  "XAUTHORITY",
  "GPG_AGENT_INFO",
  "TOKENIZERS_PARALLELISM",
])

const FIXED = [
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
  "OPENCODE_CONSOLE_TOKEN",
  PermissionLaunchMode.ENV_KEY,
  WorkspaceTrustLaunch.ENV_KEY,
]
const FIXED_UPPER = new Set(FIXED.map((name) => name.toUpperCase()))

const PROXY = new Set(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"])

/** Whether a proxy URL carries a user name or password (`http://user:pass@proxy:8080`). */
function hasUserinfo(value: string) {
  try {
    const url = new URL(value.includes("://") ? value : `http://${value}`)
    return url.username !== "" || url.password !== ""
  } catch {
    return /@/.test(value)
  }
}

export function isCredentialName(name: string) {
  const upper = name.toUpperCase()
  if (/^GIT_CONFIG_KEY_\d+$/.test(upper)) return false
  if (SAFE.has(upper)) return false
  return CREDENTIAL.test(name)
}

/**
 * Whether a child process built from project config must not receive `name` set to `value`. A proxy variable is kept
 * unless its URL carries credentials, so servers still work behind a corporate proxy.
 */
export function isStripped(name: string, value = "") {
  const upper = name.toUpperCase()
  if (PROXY.has(upper)) return hasUserinfo(value)
  return FIXED_UPPER.has(upper) || isCredentialName(name)
}

/** A copy of `env` without credential-like names, the fixed list, proxies with credentials or undefined values. */
export function stripCredentials(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !isStripped(entry[0], entry[1]),
    ),
  )
}

/** The names `stripCredentials` removes from `env`, for a log line when a server fails without them. */
export function strippedNames(env: NodeJS.ProcessEnv) {
  return Object.entries(env)
    .filter((entry) => entry[1] !== undefined && isStripped(entry[0], entry[1]))
    .map((entry) => entry[0])
    .sort()
}

/** Provider and cloud credentials that read as empty in restricted project config substitutions. */
export const COVERED: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GEMINI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AZURE_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AGENTCODE_API_KEY",
  "OPENCODE_API_KEY",
  "OPENCODE_CONSOLE_TOKEN",
  "OPENCODE_SERVER_PASSWORD",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "CEREBRAS_API_KEY",
  "PERPLEXITY_API_KEY",
  "MOONSHOT_API_KEY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
])

export function isCovered(name: string) {
  return COVERED.has(name.toUpperCase())
}
