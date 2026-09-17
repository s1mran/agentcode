import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Session } from "@/session/session"
import { SessionRevert } from "../../src/session/revert"
import { Snapshot } from "../../src/snapshot"
import { MessageID, PartID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Session.node, SessionRevert.node, Snapshot.node, SessionProjector.node, CrossSpawnSpawner.node]),
  ),
)

const read = (file: string) => Effect.promise(() => fs.readFile(file, "utf-8"))
const write = (file: string, text: string) => Effect.promise(() => fs.writeFile(file, text))
const exists = (file: string) =>
  Effect.promise(() =>
    fs
      .access(file)
      .then(() => true)
      .catch(() => false),
  )
const model = { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") }
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

describe("revert in a folder that is not a git repository", () => {
  it.live(
    "reverts a turn's file changes and unrevert brings them back",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const revert = yield* SessionRevert.Service
        const snapshot = yield* Snapshot.Service
        expect((yield* snapshot.status()).mode).toBe("folder")

        yield* write(path.join(dir, "a.txt"), "a0")
        const info = yield* session.create({})
        const sid = info.id

        const user = yield* session.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: sid,
          agent: "default",
          model,
          time: { created: Date.now() },
        })
        yield* session.updatePart({
          id: PartID.ascending(),
          messageID: user.id,
          sessionID: sid,
          type: "text",
          text: "edit",
        })
        const assistant = yield* session.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          sessionID: sid,
          mode: "default",
          agent: "default",
          path: { cwd: dir, root: dir },
          cost: 0,
          tokens,
          modelID: model.modelID,
          providerID: model.providerID,
          parentID: user.id,
          time: { created: Date.now() },
          finish: "end_turn",
        })

        const before = yield* snapshot.track()
        if (!before) throw new Error("expected a folder checkpoint")
        yield* write(path.join(dir, "a.txt"), "a1")
        yield* write(path.join(dir, "new.txt"), "new")
        const after = yield* snapshot.track()
        if (!after) throw new Error("expected a folder checkpoint")
        const patch = yield* snapshot.patch(before, { touched: [path.join(dir, "new.txt")] })
        for (const part of [
          { type: "step-start" as const, snapshot: before },
          { type: "step-finish" as const, reason: "stop", snapshot: after, cost: 0, tokens },
          { type: "patch" as const, hash: patch.hash, files: patch.files },
        ]) {
          yield* session.updatePart({ id: PartID.ascending(), messageID: assistant.id, sessionID: sid, ...part })
        }

        yield* revert.revert({ sessionID: sid, messageID: user.id })
        expect((yield* session.get(sid)).revert?.messageID).toBe(user.id)
        expect(yield* read(path.join(dir, "a.txt"))).toBe("a0")
        expect(yield* exists(path.join(dir, "new.txt"))).toBe(false)

        yield* revert.unrevert({ sessionID: sid })
        expect((yield* session.get(sid)).revert).toBeUndefined()
        expect(yield* read(path.join(dir, "a.txt"))).toBe("a1")
        expect(yield* read(path.join(dir, "new.txt"))).toBe("new")
      }),
    ),
  )
})
