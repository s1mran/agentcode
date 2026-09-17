import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Context } from "effect"
import { WorkspaceTrustLaunch } from "@opencode-ai/core/trust/launch"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { WorkspaceTrustStore } from "../../src/trust/store"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const context = Context.empty() as Context.Context<unknown>

async function call(directory: string | undefined, route: string, init?: RequestInit & { json?: unknown }) {
  const headers = new Headers(init?.headers)
  if (directory) headers.set("x-opencode-directory", directory)
  if (init?.json !== undefined) headers.set("content-type", "application/json")
  const response = await HttpApiApp.webHandler().handler(
    new Request(`http://localhost${route}`, {
      ...init,
      headers,
      body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    }),
    context,
  )
  const text = await response.text()
  return { status: response.status, body: text ? (JSON.parse(text) as any) : undefined }
}

const project = (dir: string) =>
  fs.writeFile(
    path.join(dir, "opencode.json"),
    JSON.stringify({
      permission: { bash: { "git *": "allow" } },
      mcp: { "project-srv": { type: "local", command: ["definitely-not-a-real-command-xyz"] } },
    }),
  )

afterEach(async () => {
  WorkspaceTrustLaunch.set(undefined)
  await disposeAllInstances()
  await fs.rm(WorkspaceTrustStore.file(), { force: true })
  await resetDatabase()
})

describe("workspace trust HttpApi", () => {
  test("GET /trust, POST /trust, POST /trust/mcp, DELETE /trust and the global routes", async () => {
    WorkspaceTrustLaunch.set("prompt")
    await fs.rm(WorkspaceTrustStore.file(), { force: true })
    await using tmp = await tmpdir({ git: true })
    await project(tmp.path)
    const sub = path.join(tmp.path, "sub")
    await fs.mkdir(sub)

    const health = await call(undefined, "/global/health")
    expect(health.body).toMatchObject({ healthy: true, workspaceTrust: true })

    const fresh = await call(tmp.path, "/trust")
    expect(fresh.status).toBe(200)
    expect(fresh.body).toMatchObject({
      path: tmp.path,
      kind: "repository",
      status: "unknown",
      policy: "prompt",
      effective: "restricted",
      sessionOnly: false,
    })
    expect(fresh.body.held).toContainEqual(
      expect.objectContaining({ kind: "mcp", name: "project-srv", reason: "untrusted" }),
    )
    expect(fresh.body.held).toContainEqual(expect.objectContaining({ kind: "permission", pattern: "git *" }))

    // A held project server is reported, never started.
    const status = await call(tmp.path, "/mcp")
    expect(status.body["project-srv"]).toMatchObject({ status: "pending_approval", reason: "untrusted" })
    const connect = await call(tmp.path, "/mcp/project-srv/connect", { method: "POST" })
    expect(connect.status).toBe(409)
    expect(connect.body).toMatchObject({ _tag: "McpApprovalRequiredError", name: "project-srv" })

    // Approving one server needs a trusted folder.
    const early = await call(tmp.path, "/trust/mcp/project-srv", { method: "POST", json: { approve: true } })
    expect(early.status).toBe(400)

    // Load a sibling instance under the same repository key; a decision reloads it too.
    expect((await call(sub, "/trust")).body.effective).toBe("restricted")
    const disposed: string[] = []
    const listener = (event: GlobalEvent) => {
      if (event.payload.type === "server.instance.disposed") disposed.push(event.directory ?? "")
    }
    GlobalBus.on("event", listener)
    try {
      const decided = await call(tmp.path, "/trust", {
        method: "POST",
        json: { trusted: true, mcp: { reject: ["project-srv"] } },
      })
      expect(decided.status).toBe(200)
      expect(decided.body).toEqual({ path: tmp.path, status: "trusted", effective: "full" })
      for (let i = 0; i < 100 && !(disposed.includes(tmp.path) && disposed.includes(sub)); i++) await Bun.sleep(20)
      expect(disposed).toContain(tmp.path)
      expect(disposed).toContain(sub)
    } finally {
      GlobalBus.off("event", listener)
    }

    const trusted = await call(tmp.path, "/trust")
    expect(trusted.body).toMatchObject({ status: "trusted", effective: "full", source: "stored" })
    expect(trusted.body.mcp.rejected).toEqual(["project-srv"])
    expect(trusted.body.held).toEqual([
      expect.objectContaining({ kind: "mcp", name: "project-srv", reason: "rejected" }),
    ])
    expect((await call(tmp.path, "/mcp")).body["project-srv"]).toEqual({ status: "rejected" })

    // Global listing and forget.
    const listed = await call(undefined, "/global/trust")
    expect(listed.body).toContainEqual(expect.objectContaining({ path: tmp.path, trusted: true, sessionOnly: false }))

    const forgot = await call(tmp.path, "/trust", { method: "DELETE" })
    expect(forgot.body).toEqual({ path: tmp.path, status: "unknown", effective: "restricted" })
    expect((await call(tmp.path, "/trust")).body).toMatchObject({ status: "unknown", effective: "restricted" })

    await call(tmp.path, "/trust", { method: "POST", json: { trusted: false } })
    const removed = await call(undefined, "/global/trust", { method: "DELETE", json: { path: tmp.path } })
    expect(removed.body).toBe(true)
    expect((await call(undefined, "/global/trust")).body).not.toContainEqual(
      expect.objectContaining({ path: tmp.path }),
    )
  }, 60_000)
})
