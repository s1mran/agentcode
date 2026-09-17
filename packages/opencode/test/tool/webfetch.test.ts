import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Cause, Effect, Exit, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { WebFetchTool } from "../../src/tool/webfetch"
import { SessionID, MessageID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([httpClient, Truncate.node, Agent.node]), [
    [httpClient, FetchHttpClient.layer as Layer.Layer<HttpClient.HttpClient>],
  ]),
)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const withFetch = <A, E, R>(
  fetch: (req: Request) => Response | Promise<Response>,
  fn: (url: URL) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => Bun.serve({ port: 0, fetch })),
    (server) => fn(server.url),
    (server) => Effect.sync(() => server.stop(true)),
  )

const exec = Effect.fn("WebFetchToolTest.exec")(function* (
  args: Tool.InferParameters<typeof WebFetchTool>,
  next: Tool.Context = ctx,
) {
  const info = yield* WebFetchTool
  const tool = yield* info.init()
  return yield* tool.execute(args, next)
})

type AskInput = Parameters<Tool.Context["ask"]>[0]

// Records the permission request and stops before any network access.
const asked = Effect.fn("WebFetchToolTest.asked")(function* (url: string) {
  const requests: AskInput[] = []
  const stop = new Error("stop after permission")
  const exit = yield* exec(
    { url, format: "markdown" },
    {
      ...ctx,
      ask: (input: AskInput) =>
        Effect.sync(() => {
          requests.push(input)
          throw stop
        }),
    },
  ).pipe(Effect.exit)
  expect(Exit.isFailure(exit)).toBe(true)
  const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
  return { requests, error: error instanceof Error ? error : new Error(String(error)) }
})

describe("tool.webfetch", () => {
  it.instance("asks per host, lowercased, with the full URL for deny and ask rules", () =>
    Effect.gen(function* () {
      const { requests } = yield* asked("https://Docs.GitHub.com/en/x?y")
      expect(requests).toHaveLength(1)
      expect(requests[0].permission).toBe("webfetch")
      expect(requests[0].patterns).toEqual(["docs.github.com"])
      expect(requests[0].always).toEqual(["docs.github.com"])
      expect(requests[0].hints).toEqual([{ pattern: "docs.github.com", loose: "https://Docs.GitHub.com/en/x?y" }])
      expect(requests[0].metadata.url).toBe("https://Docs.GitHub.com/en/x?y")
    }),
  )

  it.instance("keeps a non-default port in the host pattern", () =>
    Effect.gen(function* () {
      const local = yield* asked("http://localhost:3000/x")
      expect(local.requests[0].patterns).toEqual(["localhost:3000"])
      expect(local.requests[0].always).toEqual(["localhost:3000"])
      const standard = yield* asked("https://example.com:443/x")
      expect(standard.requests[0].patterns).toEqual(["example.com"])
    }),
  )

  it.instance("rejects an invalid URL before asking", () =>
    Effect.gen(function* () {
      const invalid = yield* asked("https://")
      expect(invalid.requests).toHaveLength(0)
      expect(invalid.error.message).toContain("Invalid URL")
      const scheme = yield* asked("ftp://example.com/file")
      expect(scheme.requests).toHaveLength(0)
      expect(scheme.error.message).toContain("URL must start with http:// or https://")
    }),
  )

  it.instance("returns image responses as file attachments", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
      yield* withFetch(
        () => new Response(bytes, { status: 200, headers: { "content-type": "IMAGE/PNG; charset=binary" } }),
        (url) =>
          Effect.gen(function* () {
            const result = yield* exec({ url: new URL("/image.png", url).toString(), format: "markdown" })
            expect(result.output).toBe("Image fetched successfully")
            expect(result.attachments).toBeDefined()
            expect(result.attachments?.length).toBe(1)
            expect(result.attachments?.[0].type).toBe("file")
            expect(result.attachments?.[0].mime).toBe("image/png")
            expect(result.attachments?.[0].url.startsWith("data:image/png;base64,")).toBe(true)
            expect(result.attachments?.[0]).not.toHaveProperty("id")
            expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
            expect(result.attachments?.[0]).not.toHaveProperty("messageID")
          }),
      )
    }),
  )

  it.instance("keeps svg as text output", () =>
    withFetch(
      () =>
        new Response('<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>', {
          status: 200,
          headers: { "content-type": "image/svg+xml; charset=UTF-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/image.svg", url).toString(), format: "html" })
          expect(result.output).toContain("<svg")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("keeps text responses as text output", () =>
    withFetch(
      () =>
        new Response("hello from webfetch", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/file.txt", url).toString(), format: "text" })
          expect(result.output).toBe("hello from webfetch")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("extracts text from html without scripts or styles", () =>
    withFetch(
      () =>
        new Response(
          "<html><head><style>.hidden{}</style><script>alert('x')</script></head><body>Hello <b>world</b></body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        ),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/page.html", url).toString(), format: "text" })
          expect(result.output).toBe("Hello world")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("retries a Cloudflare challenge with the AgentCode User-Agent", () => {
    const agents: (string | null)[] = []
    return withFetch(
      (req) => {
        const agent = req.headers.get("user-agent")
        agents.push(agent)
        if (agent !== "AgentCode")
          return new Response("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } })
        return new Response("hello", { status: 200, headers: { "content-type": "text/plain" } })
      },
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/page", url).toString(), format: "text" })
          expect(result.output).toContain("hello")
          expect(agents).toHaveLength(2)
          expect(agents[1]).toBe("AgentCode")
        }),
    )
  })

  it.instance("asks again before following a redirect to another host, and not for a same-host redirect", () => {
    const hits: string[] = []
    return withFetch(
      (req) => {
        const url = new URL(req.url)
        hits.push(`${url.hostname}${url.pathname}`)
        if (url.pathname === "/same") return new Response(null, { status: 302, headers: { location: "/final" } })
        if (url.pathname === "/away")
          return new Response(null, {
            status: 301,
            headers: { location: `http://127.0.0.1:${url.port}/final` },
          })
        return new Response("landed", { status: 200, headers: { "content-type": "text/plain" } })
      },
      (url) =>
        Effect.gen(function* () {
          const local = (path: string) => `http://localhost:${url.port}${path}`
          const requests: AskInput[] = []
          const record: Tool.Context = {
            ...ctx,
            ask: (input: AskInput) => Effect.sync(() => void requests.push(input)),
          }

          const same = yield* exec({ url: local("/same"), format: "text" }, record)
          expect(same.output).toBe("landed")
          expect(requests.map((item) => item.patterns)).toEqual([[`localhost:${url.port}`]])

          requests.length = 0
          const away = yield* exec({ url: local("/away"), format: "text" }, record)
          expect(away.output).toBe("landed")
          expect(requests.map((item) => item.patterns)).toEqual([[`localhost:${url.port}`], [`127.0.0.1:${url.port}`]])
          expect(requests[1].metadata.redirectedFrom).toBe(local("/away"))

          // A rejected redirect never reaches the other host.
          hits.length = 0
          const stop = new Error("redirect rejected")
          const exit = yield* exec(
            { url: local("/away"), format: "text" },
            {
              ...ctx,
              ask: (input: AskInput) =>
                Effect.sync(() => {
                  if (input.patterns[0]?.startsWith("127.0.0.1")) throw stop
                }),
            },
          ).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          expect(hits).toEqual(["localhost/away"])
        }),
    )
  })
})
