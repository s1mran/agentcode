import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { WorkspaceTrustStore } from "../../src/trust/store"
import { tmpdir } from "../fixture/fixture"

const entry = (input: Partial<WorkspaceTrustStore.Entry> & Pick<WorkspaceTrustStore.Entry, "kind" | "trusted">) => ({
  path: "",
  time: 1,
  mcp: { approved: {}, rejected: [] },
  ...input,
})

describe("WorkspaceTrustStore", () => {
  test("a missing file reads as an empty store", async () => {
    await using tmp = await tmpdir()
    const result = await WorkspaceTrustStore.read(path.join(tmp.path, "trust", "workspaces.json"))
    expect(result).toEqual({ data: { version: 1, workspaces: {} }, corrupt: false })
  })

  test("a corrupt file reads as empty, is never overwritten, and update fails clearly", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "trust", "workspaces.json")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, "{ not json")
    const result = await WorkspaceTrustStore.read(file)
    expect(result.corrupt).toBe(true)
    expect(result.data.workspaces).toEqual({})
    const error = await WorkspaceTrustStore.update((data) => {
      data.workspaces["/x"] = entry({ kind: "directory", trusted: true })
    }, file).catch((error) => error)
    expect(error).toBeInstanceOf(WorkspaceTrustStore.CorruptError)
    expect(String(error.message)).toContain("could not be parsed")
    expect(await fs.readFile(file, "utf8")).toBe("{ not json")
  })

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a store that exists but cannot be read is never overwritten, sync or async",
    async () => {
      await using tmp = await tmpdir()
      const file = path.join(tmp.path, "trust", "workspaces.json")
      await WorkspaceTrustStore.update((data) => {
        data.workspaces["/a"] = entry({ kind: "repository", trusted: true, path: "/a" })
        data.workspaces["/b"] = entry({ kind: "repository", trusted: true, path: "/b" })
      }, file)
      const before = await fs.readFile(file, "utf8")
      await fs.chmod(file, 0o000)
      try {
        const result = await WorkspaceTrustStore.read(file)
        expect(result.corrupt).toBe(false)
        expect(result.error).toBeInstanceOf(WorkspaceTrustStore.ReadError)
        expect(result.data.workspaces).toEqual({})
        expect(WorkspaceTrustStore.readSync(file).error).toBeInstanceOf(WorkspaceTrustStore.ReadError)
        const error = await WorkspaceTrustStore.update((data) => {
          data.workspaces["/c"] = entry({ kind: "repository", trusted: true, path: "/c" })
        }, file).catch((error) => error)
        expect(error).toBeInstanceOf(WorkspaceTrustStore.ReadError)
      } finally {
        await fs.chmod(file, 0o600)
      }
      expect(await fs.readFile(file, "utf8")).toBe(before)
    },
  )

  test.skipIf(process.platform === "win32")("writes the store with mode 0600 in a 0700 folder", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "trust", "workspaces.json")
    await WorkspaceTrustStore.update((data) => {
      data.workspaces["/repo"] = entry({ kind: "repository", trusted: true, path: "/repo" })
    }, file)
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700)
    expect((await WorkspaceTrustStore.read(file)).data.workspaces["/repo"]?.trusted).toBe(true)
    // No temp files are left behind.
    expect(await fs.readdir(path.dirname(file))).toEqual(["workspaces.json"])
  })

  test("setting trusted: true by hand counts as trust", () => {
    const data = WorkspaceTrustStore.parse(JSON.stringify({ workspaces: { "/repo": { trusted: true } } }))!
    expect(WorkspaceTrustStore.lookupIn(data, { key: "/repo", kind: "repository" })?.entry.trusted).toBe(true)
  })

  test("a directory ancestor covers a child folder; the nearest decision wins; repositories are never covered", () => {
    const data: WorkspaceTrustStore.Data = {
      version: 1,
      workspaces: {
        "/work": entry({ kind: "directory", trusted: true }),
        "/work/untrusted": entry({ kind: "directory", trusted: false }),
        "/workbench": entry({ kind: "directory", trusted: false }),
      },
    }
    expect(WorkspaceTrustStore.lookupIn(data, { key: "/work/a/b", kind: "directory" })).toMatchObject({
      key: "/work",
      source: "parent",
      entry: { trusted: true },
    })
    expect(WorkspaceTrustStore.lookupIn(data, { key: "/work/untrusted/x", kind: "directory" })).toMatchObject({
      key: "/work/untrusted",
      entry: { trusted: false },
    })
    expect(WorkspaceTrustStore.lookupIn(data, { key: "/work", kind: "directory" })?.source).toBe("stored")
    expect(WorkspaceTrustStore.lookupIn(data, { key: "/work/clone", kind: "repository" })).toBeUndefined()
    expect(WorkspaceTrustStore.lookupIn(data, { key: "/workbenchx", kind: "directory" })).toBeUndefined()
  })

  test("concurrent updates both persist", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "trust", "workspaces.json")
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        WorkspaceTrustStore.update((data) => {
          data.workspaces[`/repo-${index}`] = entry({ kind: "repository", trusted: index % 2 === 0 })
        }, file),
      ),
    )
    const keys = Object.keys((await WorkspaceTrustStore.read(file)).data.workspaces).sort()
    expect(keys).toEqual(Array.from({ length: 6 }, (_, index) => `/repo-${index}`))
  })
})
