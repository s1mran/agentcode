import type { EventV2 } from "@opencode-ai/core/event"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"

export { parseGitHubRemote } from "@/util/repository"

/**
 * Extracts displayable text from assistant response parts.
 * Returns null for non-text responses (signals summary needed).
 * Throws only for truly empty responses.
 */
export function extractResponseText(parts: SessionV1.Part[]): string | null {
  const textPart = parts.findLast((p) => p.type === "text")
  if (textPart) return textPart.text

  // Non-text parts (tools, reasoning, step-start/step-finish, etc.) - signal summary needed
  if (parts.length > 0) return null

  throw new Error("Failed to parse response: no parts returned")
}

/**
 * Formats a PROMPT_TOO_LARGE error message with details about files in the prompt.
 * Content is base64 encoded, so we calculate original size by multiplying by 0.75.
 */
export function formatPromptTooLargeError(files: { filename: string; content: string }[]): string {
  const fileDetails =
    files.length > 0
      ? `\n\nFiles in prompt:\n${files.map((f) => `  - ${f.filename} (${((f.content.length * 0.75) / 1024).toFixed(0)} KB)`).join("\n")}`
      : ""
  return `PROMPT_TOO_LARGE: The prompt exceeds the model's context limit.${fileDetails}`
}

/**
 * The GitHub agent runs unattended, so nothing would ever answer a permission prompt and the run would hang. Like
 * `run --auto`, it approves each request once, except a safety-floor request (protected path or critical removal),
 * which needs a person and is rejected.
 */
export function headlessPermissionReply(request: Pick<PermissionV1.Request, "guard">): "once" | "reject" {
  return request.guard?.level === "floor" ? "reject" : "once"
}

export function autoReplyPermissions(deps: {
  events: Pick<EventV2.Interface, "listen">
  reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, unknown>
  log?: (message: string) => void
}) {
  return deps.events.listen((event) => {
    if (event.type !== "permission.asked") return Effect.void
    const request = event.data as PermissionV1.Request
    const reply = headlessPermissionReply(request)
    if (reply === "reject") deps.log?.(`blocked: ${request.guard?.reason} needs interactive approval`)
    // Replied outside the publishing fiber so the asking request is fully registered first.
    return deps.reply({ requestID: request.id, reply }).pipe(Effect.ignore, Effect.forkDetach, Effect.asVoid)
  })
}
