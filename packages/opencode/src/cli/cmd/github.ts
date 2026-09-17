import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd } from "../effect-cmd"
import { WorkspaceTrustLaunch } from "@opencode-ai/core/trust/launch"

export { extractResponseText, formatPromptTooLargeError, parseGitHubRemote } from "./github.shared"

/** The workspace trust policy for `github run`: headless in GitHub Actions unless OPENCODE_WORKSPACE_TRUST is set. */
export function githubTrustPolicy(env: NodeJS.ProcessEnv = process.env): WorkspaceTrustLaunch.Policy | undefined {
  if (WorkspaceTrustLaunch.fromEnv()) return undefined
  return env.GITHUB_ACTIONS === "true" ? "headless" : undefined
}

export const GithubInstallCommand = effectCmd({
  command: "install",
  describe: "install the GitHub agent",
  handler: () =>
    Effect.gen(function* () {
      const { githubInstall } = yield* Effect.promise(() => import("./github.handler"))
      return yield* githubInstall()
    }),
})

export const GithubRunCommand = effectCmd({
  command: "run",
  describe: "run the GitHub agent",
  // The OPENCODE_WORKSPACE_TRUST variable decides. Without it, a run inside GitHub Actions is headless (workflows
  // generated before workspace trust have no variable and cannot answer a prompt); elsewhere the default is prompt.
  // Set untrusted for runs on pull requests from forks.
  trustPolicy: () => githubTrustPolicy(),
  builder: (yargs) =>
    yargs
      .option("event", {
        type: "string",
        describe: "GitHub mock event to run the agent for",
      })
      .option("token", {
        type: "string",
        describe: "GitHub personal access token (github_pat_********)",
      }),
  handler: (args) =>
    Effect.gen(function* () {
      const { githubRun } = yield* Effect.promise(() => import("./github.handler"))
      return yield* githubRun(args)
    }),
})

export const GithubCommand = cmd({
  command: "github",
  describe: "manage GitHub agent",
  builder: (yargs) => yargs.command(GithubInstallCommand).command(GithubRunCommand).demandCommand(),
  async handler() {},
})
