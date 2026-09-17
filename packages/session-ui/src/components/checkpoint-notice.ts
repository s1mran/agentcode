import type { Message, Part as PartType, PatchSkippedFile } from "@opencode-ai/sdk/v2"

export type CheckpointNotice = {
  unavailable?: string
  skipped: PatchSkippedFile[]
}

// A patch part is shown only when its checkpoint missed files (or checkpoints were off), so undo
// cannot restore everything the agent changed in that step.
export function checkpointNotice(part: PartType): CheckpointNotice | undefined {
  if (part.type !== "patch") return undefined
  if (!part.skipped?.length) return undefined
  return { unavailable: part.unavailable, skipped: part.skipped }
}

// Distinct files that reverting to each user message cannot restore: every assistant message from that
// message onward. One reverse pass over the session serves every user message. Message ids sort in creation order.
export function unrestorableCounts(
  messages: readonly Message[],
  parts: Record<string, readonly PartType[] | undefined>,
) {
  const counts = new Map<string, number>()
  let ordered = true
  for (let i = 1; i < messages.length; i++) {
    if (messages[i - 1]!.id > messages[i]!.id) ordered = false
  }
  const list = ordered ? messages : messages.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const files = new Set<string>()
  for (let i = list.length - 1; i >= 0; i--) {
    const message = list[i]!
    if (message.role === "user") {
      counts.set(message.id, files.size)
      continue
    }
    for (const part of parts[message.id] ?? []) {
      const notice = checkpointNotice(part)
      if (!notice) continue
      for (const item of notice.skipped) files.add(item.file)
    }
  }
  return counts
}
