import { Schema } from "effect"
import * as path from "path"
import { Effect, Option } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Format } from "../format"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { trimDiff } from "./edit"
import { assertExternalDirectoryEffect } from "./external-directory"
import { PlanEditGuard } from "./plan-edit-guard"
import * as Bom from "@/util/bom"
import { FileReads } from "../session/file-reads"

const MAX_PROJECT_DIAGNOSTICS_FILES = 5

export const Parameters = Schema.Struct({
  content: Schema.String.annotate({ description: "The content to write to the file" }),
  filePath: Schema.String.annotate({
    description: "The absolute path to the file to write (must be absolute, not relative)",
  }),
})

export const WriteTool = Tool.define(
  "write",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service
    const format = yield* Format.Service
    const denyPlanModeEdits = yield* PlanEditGuard.make
    // Optional so isolated tool tests keep working; the tool registry always provides it.
    const reads = Option.getOrUndefined(yield* Effect.serviceOption(FileReads.Service))

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { content: string; filePath: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filepath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          yield* denyPlanModeEdits(ctx, [filepath])
          yield* assertExternalDirectoryEffect(ctx, filepath)

          // One write or edit of a file at a time, from the read check through formatting.
          const done = yield* FileReads.withLock(
            [filepath],
            Effect.gen(function* () {
              const exists = yield* fs.existsSafe(filepath)
              const snap = exists ? yield* FileReads.read(fs, filepath) : undefined
              const next = Bom.split(params.content)
              const desiredBom = (snap?.bom ?? false) || next.bom
              const contentOld = snap?.text ?? ""
              const contentNew = next.text

              // Read-before-write (session/file-reads.ts): overwriting an existing file needs a read of the whole
              // current version. New files need no read.
              if (snap && reads?.enforce) {
                const status = yield* reads.status(ctx, filepath, snap)
                if (status.kind === "unread") throw new Error(FileReads.unreadError(filepath, "overwrite"))
                if (status.kind === "changed") throw new Error(FileReads.changedError(filepath, "overwrite"))
                if (!status.entry.full) throw new Error(FileReads.partialError(filepath, status.entry))
              }

              const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, contentNew))
              yield* ctx.ask({
                permission: "edit",
                patterns: [path.relative(instance.worktree, filepath)],
                always: ["*"],
                metadata: {
                  filepath,
                  diff,
                },
              })
              // The file may have changed (or appeared) while the prompt was open: never overwrite that.
              if (yield* FileReads.changedSince(fs, filepath, snap)) throw new Error(FileReads.raceError(filepath))

              yield* fs.writeWithDirs(filepath, Bom.join(contentNew, desiredBom))
              const formatted = yield* FileReads.formatWritten(format, fs, filepath, desiredBom, contentNew)
              const view = reads
                ? yield* FileReads.recordWrite(fs, filepath, {
                    base: {
                      file: FileReads.key(filepath),
                      mtimeMs: 0,
                      size: 0,
                      ranges: [],
                      full: true,
                      source: "write",
                      time: 0,
                    },
                    before: contentOld,
                    written: contentNew,
                    final: formatted.text,
                    source: "write",
                  })
                : undefined
              if (reads && view) yield* reads.record(ctx, [view])
              yield* events.publish(FileSystem.Event.Edited, { file: filepath })
              yield* events.publish(Watcher.Event.Updated, {
                file: filepath,
                event: exists ? "change" : "add",
              })
              return { exists, notes: formatted.notes, view }
            }),
          )
          const exists = done.exists

          let output = "Wrote file successfully."
          if (done.notes.length > 0) output += `\n\n${done.notes.join("\n\n")}`
          yield* lsp.touchFile(filepath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilepath = FSUtil.normalizePath(filepath)
          let projectDiagnosticsCount = 0
          for (const [file, issues] of Object.entries(diagnostics)) {
            const current = file === normalizedFilepath
            if (!current && projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
            const block = LSP.Diagnostic.report(current ? filepath : file, issues)
            if (!block) continue
            if (current) {
              output += `\n\nLSP errors detected in this file, please fix:\n${block}`
              continue
            }
            projectDiagnosticsCount++
            output += `\n\nLSP errors detected in other files:\n${block}`
          }

          return {
            title: path.relative(instance.worktree, filepath),
            metadata: {
              diagnostics,
              filepath,
              exists: exists,
              ...(done.view ? { ledger: [done.view] } : {}),
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
