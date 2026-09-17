import { Effect, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Parser } from "htmlparser2"
import * as Tool from "./tool"
import TurndownService from "turndown"
import DESCRIPTION from "./webfetch.txt"
import { isImageAttachment } from "@/util/media"

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5MB
const DEFAULT_TIMEOUT = 30 * 1000 // 30 seconds
const MAX_TIMEOUT = 120 * 1000 // 2 minutes
const MAX_REDIRECTS = 10
const REDIRECTS = new Set([301, 302, 303, 307, 308])

export const Parameters = Schema.Struct({
  url: Schema.String.annotate({ description: "The URL to fetch content from" }),
  format: Schema.Literals(["text", "markdown", "html"])
    .annotate({
      description: "The format to return the content in (text, markdown, or html). Defaults to markdown.",
      default: "markdown",
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed("markdown" as const))),
  timeout: Schema.optional(Schema.Number).annotate({ description: "Optional timeout in seconds (max 120)" }),
})

export const WebFetchTool = Tool.define(
  "webfetch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
            throw new Error("URL must start with http:// or https://")
          }
          const host = hostPattern(params.url)

          // Rules and "Allow always" work per host; deny and ask rules can still match the full URL.
          yield* ctx.ask({
            permission: "webfetch",
            patterns: [host],
            always: [host],
            hints: [{ pattern: host, loose: params.url }],
            metadata: {
              url: params.url,
              format: params.format,
              timeout: params.timeout,
            },
          })

          const timeout = Math.min((params.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000, MAX_TIMEOUT)

          // Build Accept header based on requested format with q parameters for fallbacks
          let acceptHeader = "*/*"
          switch (params.format) {
            case "markdown":
              acceptHeader = "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
              break
            case "text":
              acceptHeader = "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
              break
            case "html":
              acceptHeader =
                "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
              break
            default:
              acceptHeader =
                "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
          }
          const headers = {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
            Accept: acceptHeader,
            "Accept-Language": "en-US,en;q=0.9",
          }

          // Redirects are followed here, not by fetch, so a hop to another host is checked like a direct fetch of it:
          // an approved (or preapproved) host must not silently lead somewhere else.
          const get = (url: string, userAgent?: string) =>
            http
              .execute(
                HttpClientRequest.get(url).pipe(
                  HttpClientRequest.setHeaders(userAgent ? { ...headers, "User-Agent": userAgent } : headers),
                ),
              )
              .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }))

          const response = yield* Effect.gen(function* () {
            let url = params.url
            let approved = host
            for (let hop = 0; ; hop++) {
              const first = yield* get(url)
              // Retry with honest UA if blocked by Cloudflare bot detection (TLS fingerprint mismatch)
              const current =
                first.status === 403 && first.headers["cf-mitigated"] === "challenge"
                  ? yield* get(url, "AgentCode")
                  : first
              if (!REDIRECTS.has(current.status)) return yield* HttpClientResponse.filterStatusOk(current)
              const location = current.headers["location"]
              if (!location) return yield* HttpClientResponse.filterStatusOk(current)
              if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects (more than ${MAX_REDIRECTS})`)
              const next = URL.canParse(location, url) ? new URL(location, url).toString() : ""
              if (!next.startsWith("http://") && !next.startsWith("https://"))
                throw new Error(`Redirect to an unsupported URL: ${location}`)
              const nextHost = hostPattern(next)
              if (nextHost !== approved) {
                yield* ctx.ask({
                  permission: "webfetch",
                  patterns: [nextHost],
                  always: [nextHost],
                  hints: [{ pattern: nextHost, loose: next }],
                  metadata: {
                    url: next,
                    redirectedFrom: url,
                    format: params.format,
                    timeout: params.timeout,
                  },
                })
                approved = nextHost
              }
              url = next
            }
          }).pipe(Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.die(new Error("Request timed out")) }))

          // Check content length
          const contentLength = response.headers["content-length"]
          if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
            throw new Error("Response too large (exceeds 5MB limit)")
          }

          const arrayBuffer = yield* response.arrayBuffer
          if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
            throw new Error("Response too large (exceeds 5MB limit)")
          }

          const contentType = response.headers["content-type"] || ""
          const mime = contentType.split(";")[0]?.trim().toLowerCase() || ""
          const title = `${params.url} (${contentType})`

          if (isImageAttachment(mime)) {
            const base64Content = Buffer.from(arrayBuffer).toString("base64")
            return {
              title,
              output: "Image fetched successfully",
              metadata: {},
              attachments: [
                {
                  type: "file" as const,
                  mime,
                  url: `data:${mime};base64,${base64Content}`,
                },
              ],
            }
          }

          const content = new TextDecoder().decode(arrayBuffer)

          // Handle content based on requested format and actual content type
          switch (params.format) {
            case "markdown":
              if (contentType.includes("text/html")) {
                const markdown = convertHTMLToMarkdown(content)
                return {
                  output: markdown,
                  title,
                  metadata: {},
                }
              }
              return { output: content, title, metadata: {} }

            case "text":
              if (contentType.includes("text/html")) {
                return { output: extractTextFromHTML(content), title, metadata: {} }
              }
              return { output: content, title, metadata: {} }

            case "html":
              return { output: content, title, metadata: {} }

            default:
              return { output: content, title, metadata: {} }
          }
        }).pipe(Effect.orDie),
    }
  }),
)

/** Lowercased host plus any non-default port (`docs.github.com`, `localhost:3000`). Throws on an unparsable URL. */
function hostPattern(input: string) {
  const url = URL.canParse(input) ? new URL(input) : undefined
  const host = url?.hostname.toLowerCase()
  if (!url || !host) throw new Error(`Invalid URL: ${input}`)
  return url.port ? `${host}:${url.port}` : host
}

function extractTextFromHTML(html: string) {
  let text = ""
  let skipDepth = 0

  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) {
        skipDepth++
      }
    },
    ontext(input) {
      if (skipDepth === 0) text += input
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth--
    },
  })

  parser.write(html)
  parser.end()

  return text.trim()
}

function convertHTMLToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndownService.remove(["script", "style", "meta", "link"])
  return turndownService.turndown(html)
}
