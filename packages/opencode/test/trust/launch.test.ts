import { afterEach, describe, expect, test } from "bun:test"
import { WorkspaceTrustLaunch } from "@opencode-ai/core/trust/launch"
import { githubTrustPolicy } from "../../src/cli/cmd/github"

const original = process.env.OPENCODE_WORKSPACE_TRUST

afterEach(() => {
  WorkspaceTrustLaunch.set(undefined)
  if (original === undefined) delete process.env.OPENCODE_WORKSPACE_TRUST
  else process.env.OPENCODE_WORKSPACE_TRUST = original
})

describe("WorkspaceTrustLaunch", () => {
  test("the default is prompt when the variable is unset and nothing overrides it", () => {
    delete process.env.OPENCODE_WORKSPACE_TRUST
    expect(WorkspaceTrustLaunch.raw()).toBeUndefined()
    expect(WorkspaceTrustLaunch.read()).toBe("prompt")
    expect(WorkspaceTrustLaunch.fromEnv()).toBeUndefined()
  })

  test("the variable is read case-insensitively and an invalid value falls back to prompt with one warning", () => {
    process.env.OPENCODE_WORKSPACE_TRUST = "Headless"
    expect(WorkspaceTrustLaunch.read()).toBe("headless")
    process.env.OPENCODE_WORKSPACE_TRUST = "always"
    expect(WorkspaceTrustLaunch.read()).toBe("prompt")
    expect(WorkspaceTrustLaunch.takeWarning()).toBe("always")
    expect(WorkspaceTrustLaunch.takeWarning()).toBeUndefined()
  })

  test("set overrides the variable, and inherited drops it from a child environment", () => {
    process.env.OPENCODE_WORKSPACE_TRUST = "untrusted"
    WorkspaceTrustLaunch.set("trusted")
    expect(WorkspaceTrustLaunch.read()).toBe("trusted")
    expect(WorkspaceTrustLaunch.inherited({ A: "1", OPENCODE_WORKSPACE_TRUST: "trusted" })).toEqual({ A: "1" })
  })

  test("github run is headless inside GitHub Actions when the variable is unset, and the variable always wins", () => {
    delete process.env.OPENCODE_WORKSPACE_TRUST
    expect(githubTrustPolicy({ GITHUB_ACTIONS: "true" })).toBe("headless")
    expect(githubTrustPolicy({})).toBeUndefined()
    process.env.OPENCODE_WORKSPACE_TRUST = "untrusted"
    expect(githubTrustPolicy({ GITHUB_ACTIONS: "true" })).toBeUndefined()
  })
})
