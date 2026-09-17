export * as ConfigVariable from "./variable"

import path from "path"
import os from "os"
import fs from "fs/promises"
import { Filesystem } from "@/util/filesystem"
import { InvalidError } from "@opencode-ai/core/v1/config/error"

type ParseSource =
  | {
      type: "path"
      path: string
    }
  | {
      type: "virtual"
      source: string
      dir: string
    }

type SubstituteInput = ParseSource & {
  text: string
  missing?: "error" | "empty"
  env?: Record<string, string>
  /** `{env:NAME}` reads as empty when this returns true (credentials in project config). */
  redact?: (name: string) => boolean
  /** When set, a `{file:path}` whose real path is outside this folder reads as empty and is never read. */
  fileRoot?: string
  /** Called with each `{file:...}` token that read as empty because it is outside `fileRoot`. */
  onRedact?: (token: string) => void
}

function source(input: ParseSource) {
  return input.type === "path" ? input.path : input.source
}

function dir(input: ParseSource) {
  return input.type === "path" ? path.dirname(input.path) : input.dir
}

async function real(target: string) {
  return fs.realpath(target).catch(() => path.resolve(target))
}

/** Whether `target` is inside `root` after resolving symlinks on both. */
async function inside(root: string, target: string) {
  const [base, resolved] = await Promise.all([real(root), real(target)])
  const relative = path.relative(base, resolved)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep))
}

/** Apply {env:VAR} and {file:path} substitutions to config text. */
export async function substitute(input: SubstituteInput) {
  const missing = input.missing ?? "error"
  let text = input.text.replace(/\{env:([^}]+)\}/g, (_, varName) => {
    if (input.redact?.(varName)) return ""
    return (input.env?.[varName] ?? process.env[varName]) || ""
  })

  const fileMatches = Array.from(text.matchAll(/\{file:[^}]+\}/g))
  if (!fileMatches.length) return text

  const configDir = dir(input)
  const configSource = source(input)
  let out = ""
  let cursor = 0

  for (const match of fileMatches) {
    const token = match[0]
    const index = match.index
    out += text.slice(cursor, index)

    const lineStart = text.lastIndexOf("\n", index - 1) + 1
    const prefix = text.slice(lineStart, index).trimStart()
    if (prefix.startsWith("//")) {
      out += token
      cursor = index + token.length
      continue
    }

    let filePath = token.replace(/^\{file:/, "").replace(/\}$/, "")
    if (filePath.startsWith("~/")) {
      filePath = path.join(os.homedir(), filePath.slice(2))
    }

    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(configDir, filePath)
    if (input.fileRoot !== undefined && !(await inside(input.fileRoot, resolvedPath))) {
      input.onRedact?.(token)
      cursor = index + token.length
      continue
    }
    const fileContent = (
      await Filesystem.readText(resolvedPath).catch((error: NodeJS.ErrnoException) => {
        if (missing === "empty") return ""

        const errMsg = `bad file reference: "${token}"`
        if (error.code === "ENOENT") {
          throw new InvalidError(
            {
              path: configSource,
              message: errMsg + ` ${resolvedPath} does not exist`,
            },
            { cause: error },
          )
        }
        throw new InvalidError({ path: configSource, message: errMsg }, { cause: error })
      })
    ).trim()

    out += JSON.stringify(fileContent).slice(1, -1)
    cursor = index + token.length
  }

  out += text.slice(cursor)
  return out
}
