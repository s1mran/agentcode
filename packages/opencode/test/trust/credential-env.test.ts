import { describe, expect, test } from "bun:test"
import { CredentialEnv } from "../../src/trust/credential-env"

describe("CredentialEnv", () => {
  test("stripCredentials removes credential names, the fixed list and the launch variables", () => {
    const env = CredentialEnv.stripCredentials({
      FOO_TOKEN: "1",
      my_secret: "1",
      DB_PASSWORD: "1",
      API_KEY: "1",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      XAUTHORITY: "/home/me/.Xauthority",
      TOKENIZERS_PARALLELISM: "false",
      OPENCODE_SERVER_PASSWORD: "1",
      OPENCODE_SERVER_USERNAME: "1",
      HTTPS_PROXY: "http://user:pass@proxy.corp:8080",
      https_proxy: "user:pass@proxy.corp:8080",
      all_proxy: "socks5://me@proxy.corp:1080",
      HTTP_PROXY: "http://proxy.corp:8080",
      no_proxy: "localhost",
      OPENCODE_WORKSPACE_TRUST: "trusted",
      OPENCODE_PERMISSION_MODE: "bypassPermissions",
      PATH: "/bin",
      HOME: "/home/me",
      LANG: "C",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_AUTHOR_NAME: "me",
      UNDEFINED: undefined,
    })
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/home/me",
      LANG: "C",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_AUTHOR_NAME: "me",
      // Sockets and paths the process could reach anyway, and a proxy without credentials, stay.
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      XAUTHORITY: "/home/me/.Xauthority",
      TOKENIZERS_PARALLELISM: "false",
      HTTP_PROXY: "http://proxy.corp:8080",
      no_proxy: "localhost",
    })
    expect(CredentialEnv.strippedNames({ API_KEY: "1", PATH: "/bin", HTTPS_PROXY: "http://u:p@proxy" })).toEqual([
      "API_KEY",
      "HTTPS_PROXY",
    ])
  })

  test("COVERED contains provider and cloud credentials", () => {
    expect(CredentialEnv.COVERED.has("ANTHROPIC_API_KEY")).toBe(true)
    expect(CredentialEnv.COVERED.has("AWS_SECRET_ACCESS_KEY")).toBe(true)
    expect(CredentialEnv.isCovered("github_token")).toBe(true)
    expect(CredentialEnv.isCovered("MY_TOKEN")).toBe(false)
    expect(CredentialEnv.isCredentialName("MY_TOKEN")).toBe(true)
  })
})
