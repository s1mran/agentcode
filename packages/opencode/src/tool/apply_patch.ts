import * as path from "path"
import { Effect, Option, Schema } from "effect"
import * as Tool from "./tool"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { InstanceState } from "@/effect/instance-state"
import { Patch } from "../patch"
import { createTwoFilesPatch, diffLines } from "diff"
import { assertExternalDirectoryEffect } from "./external-directory"
import { PlanEditGuard } from "./plan-edit-guard"
import { trimDiff } from "./edit"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import DESCRIPTION from "./apply_patch.txt"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Format } from "../format"
import * as Bom from "@/util/bom"
import { FileReads } from "../session/file-reads"

export const Parameters = Schema.Struct({
  patchText: Schema.String.annotate({ description: "The full patch text that describes all changes to be made" }),
})

export const ApplyPatchTool = Tool.define(
  "apply_patch",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* FSUtil.Service
    const format = yield* Format.Service
    const events = yield* EventV2Bridge.Service
    const denyPlanModeEdits = yield* PlanEditGuard.make
    // Optional so isolated tool tests keep working; the tool registry always provides it.
    const reads = Option.getOrUndefined(yield* Effect.serviceOption(FileReads.Service))

    const run = Effect.fn("ApplyPatchTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      if (!params.patchText) {
        return yield* Effect.fail(new Error("patchText is required"))
      }

      // Parse the patch to get hunks
      let hunks: Patch.Hunk[]
      try {
        const parseResult = Patch.parsePatch(params.patchText)
        hunks = parseResult.hunks
      } catch (error) {
        return yield* Effect.fail(new Error(`apply_patch verification failed: ${error}`))
      }

      if (hunks.length === 0) {
        const normalized = params.patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
        if (normalized === "*** Begin Patch\n*** End Patch") {
          return yield* Effect.fail(new Error("patch rejected: empty patch"))
        }
        return yield* Effect.fail(new Error("apply_patch verification failed: no hunks found"))
      }

      const instance = yield* InstanceState.context
      yield* denyPlanModeEdits(
        ctx,
        hunks.flatMap((hunk) => [
          path.resolve(instance.directory, hunk.path),
          hunk.type === "update" && hunk.move_path ? path.resolve(instance.directory, hunk.move_path) : undefined,
        ]),
      )

      // Every target (and move destination) is locked, in sorted order, from the read check through formatting.
      const locked = hunks.flatMap((hunk) => [
        path.resolve(instance.directory, hunk.path),
        hunk.type === "update" && hunk.move_path ? path.resolve(instance.directory, hunk.move_path) : undefined,
      ])
      const applied = yield* FileReads.withLock(locked, apply(hunks, ctx))
      // Language server diagnostics can take seconds: they run after the locks are released, as in edit and write.
      return yield* report(applied)
    })

    type Change = {
      filePath: string
      oldContent: string
      newContent: string
      type: "add" | "update" | "delete" | "move"
      movePath?: string
      diff: string
      additions: number
      deletions: number
      bom: boolean
      /** What was on disk when the change was built, re-checked after the permission prompt. */
      snap?: FileReads.Snapshot
      /** The ledger view the source was read under, when fresh. */
      entry?: FileReads.View
      /** The existing file an add or move replaces. */
      target?: FileReads.Snapshot
    }

    /** One entry of the `files` metadata; the CLI and UI renderers read these fields. */
    type PatchFile = {
      filePath: string
      relativePath: string
      type: Change["type"]
      patch: string
      additions: number
      deletions: number
      movePath: string | undefined
    }

    const verify = (message: string) => new Error(`apply_patch verification failed: ${message}`)

    /**
     * Read-before-edit for one path (session/file-reads.ts). `need` is the old lines an update touches; undefined
     * means the whole file is replaced, which needs a full read.
     */
    const check = Effect.fn("ApplyPatchTool.check")(function* (
      ctx: Tool.Context,
      file: string,
      snap: FileReads.Snapshot,
      verb: "edit" | "overwrite",
      need?: (seen: FileReads.View) => number[],
    ) {
      if (!reads) return
      const status = yield* reads.status(ctx, file, snap)
      if (!reads.enforce) return status.kind === "fresh" ? status.entry : undefined
      if (status.kind === "unread") throw verify(FileReads.unreadError(file, verb))
      if (status.kind === "changed") throw verify(FileReads.changedError(file, verb))
      // A full view covers every line, so the diff behind `need` only runs for a partial one.
      if (status.entry.full) return status.entry
      const lines = need?.(status.entry)
      if (lines === undefined || !FileReads.covers(status.entry, lines)) {
        throw verify(FileReads.partialError(file, status.entry, lines))
      }
      return status.entry
    })

    const existing = Effect.fn("ApplyPatchTool.existing")(function* (file: string) {
      const stats = yield* afs.stat(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!stats || stats.type === "Directory") return
      return yield* FileReads.read(afs, file)
    })

    const apply = Effect.fn("ApplyPatchTool.apply")(function* (hunks: Patch.Hunk[], ctx: Tool.Context) {
      const instance = yield* InstanceState.context
      // Validate file paths and check permissions
      const fileChanges: Change[] = []

      let totalDiff = ""

      for (const hunk of hunks) {
        const filePath = path.resolve(instance.directory, hunk.path)
        yield* assertExternalDirectoryEffect(ctx, filePath)

        switch (hunk.type) {
          case "add": {
            // Adding over an existing file replaces it: the write rules apply.
            const target = yield* existing(filePath)
            if (target) yield* check(ctx, filePath, target, "overwrite")
            const oldContent = ""
            const newContent =
              hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
            const next = Bom.split(newContent)
            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, next.text))

            let additions = 0
            let deletions = 0
            for (const change of diffLines(oldContent, next.text)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            fileChanges.push({
              filePath,
              oldContent,
              newContent: next.text,
              type: "add",
              diff,
              additions,
              deletions,
              bom: next.bom,
              target,
            })

            totalDiff += diff + "\n"
            break
          }

          case "update": {
            // Check if file exists for update
            const stats = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!stats || stats.type === "Directory") {
              return yield* Effect.fail(
                new Error(`apply_patch verification failed: Failed to read file to update: ${filePath}`),
              )
            }

            const source = yield* FileReads.read(afs, filePath)
            const oldContent = source.text
            let newContent = oldContent
            let bom = source.bom

            // Apply the update chunks to get new content
            try {
              const fileUpdate = Patch.deriveNewContentsFromChunks(
                filePath,
                hunk.chunks,
                Bom.join(source.text, source.bom),
              )
              newContent = fileUpdate.content
              bom = fileUpdate.bom
            } catch (error) {
              return yield* Effect.fail(new Error(`apply_patch verification failed: ${error}`))
            }

            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))

            let additions = 0
            let deletions = 0
            for (const change of diffLines(oldContent, newContent)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            const entry = yield* check(ctx, filePath, source, "edit", (seen) =>
              FileReads.touched(oldContent, newContent, seen),
            )

            const movePath = hunk.move_path ? path.resolve(instance.directory, hunk.move_path) : undefined
            yield* assertExternalDirectoryEffect(ctx, movePath)
            const target =
              movePath && FileReads.key(movePath) !== FileReads.key(filePath) ? yield* existing(movePath) : undefined
            if (movePath && target) yield* check(ctx, movePath, target, "overwrite")

            fileChanges.push({
              filePath,
              oldContent,
              newContent,
              type: hunk.move_path ? "move" : "update",
              movePath,
              diff,
              additions,
              deletions,
              bom,
              snap: source,
              entry,
              target,
            })

            totalDiff += diff + "\n"
            break
          }

          case "delete": {
            const source = yield* Bom.readFile(afs, filePath).pipe(
              Effect.catch((error) =>
                Effect.fail(
                  new Error(
                    `apply_patch verification failed: ${error instanceof Error ? error.message : String(error)}`,
                  ),
                ),
              ),
            )
            const contentToDelete = source.text
            const deleteDiff = trimDiff(createTwoFilesPatch(filePath, filePath, contentToDelete, ""))

            const deletions = contentToDelete.split("\n").length

            fileChanges.push({
              filePath,
              oldContent: contentToDelete,
              newContent: "",
              type: "delete",
              diff: deleteDiff,
              additions: 0,
              deletions,
              bom: source.bom,
            })

            totalDiff += deleteDiff + "\n"
            break
          }
        }
      }

      // Build per-file metadata for UI rendering (used for both permission and result)
      const files: PatchFile[] = fileChanges.map((change) => ({
        filePath: change.filePath,
        relativePath: path.relative(instance.worktree, change.movePath ?? change.filePath).replaceAll("\\", "/"),
        type: change.type,
        patch: change.diff,
        additions: change.additions,
        deletions: change.deletions,
        movePath: change.movePath,
      }))

      // Check permissions if needed
      const relativePaths = fileChanges.map((c) => path.relative(instance.worktree, c.filePath).replaceAll("\\", "/"))
      // A move writes its destination too, so the destination is checked like any other edited path.
      const movePaths = fileChanges.flatMap((c) =>
        c.movePath ? [path.relative(instance.worktree, c.movePath).replaceAll("\\", "/")] : [],
      )
      yield* ctx.ask({
        permission: "edit",
        patterns: Array.from(new Set([...relativePaths, ...movePaths])),
        always: ["*"],
        metadata: {
          filepath: relativePaths.join(", "),
          diff: totalDiff,
          files,
        },
      })

      // A file may have changed (or appeared) while the prompt was open: never overwrite that.
      for (const change of fileChanges) {
        const checks: Array<[string, FileReads.Snapshot | undefined]> = []
        if (change.type === "update" || change.type === "move") checks.push([change.filePath, change.snap])
        if (change.type === "add") checks.push([change.filePath, change.target])
        if (
          change.type === "move" &&
          change.movePath &&
          FileReads.key(change.movePath) !== FileReads.key(change.filePath)
        )
          checks.push([change.movePath, change.target])
        for (const [file, snap] of checks) {
          if (yield* FileReads.changedSince(afs, file, snap)) throw new Error(FileReads.raceError(file))
        }
      }

      // Apply the changes
      const updates: Array<{ file: string; event: "add" | "change" | "unlink" }> = []
      const notes: string[] = []
      const ledger: FileReads.View[] = []

      for (const change of fileChanges) {
        const edited = change.type === "delete" ? undefined : (change.movePath ?? change.filePath)
        switch (change.type) {
          case "add":
            // Create parent directories (recursive: true is safe on existing/root dirs)

            yield* afs.writeWithDirs(change.filePath, Bom.join(change.newContent, change.bom))
            updates.push({ file: change.filePath, event: "add" })
            break

          case "update":
            yield* afs.writeWithDirs(change.filePath, Bom.join(change.newContent, change.bom))
            updates.push({ file: change.filePath, event: "change" })
            break

          case "move":
            if (change.movePath) {
              // Create parent directories (recursive: true is safe on existing/root dirs)

              yield* afs.writeWithDirs(change.movePath!, Bom.join(change.newContent, change.bom))
              yield* afs.remove(change.filePath)
              updates.push({ file: change.filePath, event: "unlink" })
              updates.push({ file: change.movePath, event: "add" })
            }
            break

          case "delete":
            yield* afs.remove(change.filePath)
            updates.push({ file: change.filePath, event: "unlink" })
            break
        }

        if (edited) {
          const formatted = yield* FileReads.formatWritten(format, afs, edited, change.bom, change.newContent)
          notes.push(...formatted.notes)
          if (reads) {
            // Own changes count as reads: an add is fully seen, an update keeps what was read plus the changed lines.
            const view = yield* FileReads.recordWrite(afs, edited, {
              base:
                change.type === "add"
                  ? {
                      file: FileReads.key(edited),
                      mtimeMs: 0,
                      size: 0,
                      ranges: [],
                      full: true,
                      source: "apply_patch",
                      time: 0,
                    }
                  : change.entry,
              before: change.oldContent,
              written: change.newContent,
              final: formatted.text,
              source: "apply_patch",
            })
            if (view) {
              yield* reads.record(ctx, [view])
              ledger.push(view)
            }
          }
          yield* events.publish(FileSystem.Event.Edited, { file: edited })
        }
      }

      // Publish file change events
      for (const update of updates) {
        yield* events.publish(Watcher.Event.Updated, update)
      }

      return { fileChanges, notes, ledger, totalDiff, files }
    })

    const report = Effect.fn("ApplyPatchTool.report")(function* (input: {
      fileChanges: Change[]
      notes: string[]
      ledger: FileReads.View[]
      totalDiff: string
      files: PatchFile[]
    }) {
      const instance = yield* InstanceState.context
      const { fileChanges, notes, ledger, totalDiff, files } = input

      // Notify LSP of file changes and collect diagnostics
      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        yield* lsp.touchFile(target, "document")
      }
      const diagnostics = yield* lsp.diagnostics()

      // Generate output summary
      const summaryLines = fileChanges.map((change) => {
        if (change.type === "add") {
          return `A ${path.relative(instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        if (change.type === "delete") {
          return `D ${path.relative(instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        const target = change.movePath ?? change.filePath
        return `M ${path.relative(instance.worktree, target).replaceAll("\\", "/")}`
      })
      let output = `Success. Updated the following files:\n${summaryLines.join("\n")}`
      if (notes.length > 0) output += `\n\n${notes.join("\n\n")}`

      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        const block = LSP.Diagnostic.report(target, diagnostics[FSUtil.normalizePath(target)] ?? [])
        if (!block) continue
        const rel = path.relative(instance.worktree, target).replaceAll("\\", "/")
        output += `\n\nLSP errors detected in ${rel}, please fix:\n${block}`
      }

      return {
        title: output,
        metadata: {
          diff: totalDiff,
          files,
          diagnostics,
          ...(ledger.length > 0 ? { ledger } : {}),
        },
        output,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
