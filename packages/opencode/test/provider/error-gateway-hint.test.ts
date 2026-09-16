import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProviderError } from "../../src/provider/error"

const htmlError = (statusCode: number, message: string) =>
  new APICallError({
    message,
    url: "https://gateway.corp.example/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    responseHeaders: { "content-type": "text/html" },
    responseBody: "<!DOCTYPE html><html><body><h1>Sign in required</h1></body></html>",
    isRetryable: false,
  })

const parse = (error: APICallError) =>
  ProviderError.parseAPICallError({ providerID: ProviderV2.ID.make("corp-gateway"), error })

describe("ProviderError HTML gateway pages", () => {
  test("a 401 page separates reconnecting in the app from URL sign-in in a terminal", () => {
    const { message } = parse(htmlError(401, "Unauthorized"))

    expect(message).toStartWith("Unauthorized: request was blocked by a gateway or proxy.")
    expect(message).toContain("Reconnect the provider (Connect provider in the AgentCode app).")
    // The desktop app has no .well-known login flow, so URL sign-in is only offered for gateways
    // signed in to by URL, and only as a terminal command.
    expect(message).toContain(
      "For a gateway you signed in to by URL, run `opencode auth login <your provider URL>` in a terminal.",
    )
    expect(message).not.toMatch(/AgentCode app, or `opencode auth login/)
    expect(message).not.toContain("<html")
    expect(message).not.toContain("OpenCode")
  })

  test("a 403 page stays a permission hint without sign-in instructions", () => {
    const { message } = parse(htmlError(403, "Forbidden"))

    expect(message).toStartWith("Forbidden: request was blocked by a gateway or proxy.")
    expect(message).not.toContain("auth login")
    expect(message).not.toContain("<html")
  })
})
