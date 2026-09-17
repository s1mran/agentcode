import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page, type Route } from "@playwright/test"
import { installSseTransport } from "../utils/sse-transport"
import { currentSession } from "../utils/mock-server"

const serverA = "http://127.0.0.1:4096"
const serverB = "http://127.0.0.1:4097"
const directoryA = "C:/server-a"
const directoryB = "/home/server-b"
const sessionA = session("ses_server_a", directoryA, "Server A session")
const childSessionA = { ...session("ses_server_a_child", directoryA, "Server A child session"), parentID: sessionA.id }
const sessionB = session("ses_server_b", directoryB, "Server B session")

test("session settings use the remote server context", async ({ page }) => {
  const permissionRequests: string[] = []
  await mockServers(page, permissionRequests)
  await configureServers(page)

  await page.goto(`/server/${base64Encode(serverB)}/session/${sessionB.id}`)
  await expect(page.getByText(sessionB.title).first()).toBeVisible()
  await page.keyboard.press("Control+,")

  const dialog = page.locator(".settings-v2-dialog")
  const setting = dialog.locator('[data-action="settings-default-permission-mode"]')
  const trigger = setting.locator('[data-component="select-v2"]')
  await expect(trigger).toBeVisible()
  await expect(trigger).not.toHaveAttribute("data-disabled", "")
  await expect(trigger).toContainText("Ask permissions")
  await trigger.click()
  await page.getByRole("option", { name: "Plan mode" }).click()
  await expect(trigger).toContainText("Plan mode")

  // The folder default is stored for server B's folder only.
  await expect.poll(() => storedFolderModes(page)).toEqual([{ folder: base64Encode(directoryB), mode: "plan" }])

  await dialog.getByRole("tab", { name: "Models" }).click()
  await expect(dialog.getByRole("switch", { name: "Server B Model" })).toBeEnabled()
  await expect(dialog.getByRole("switch", { name: "Server A Model" })).toHaveCount(0)
})

test("permission requests on an unfocused server are shown, never auto-answered", async ({ page }) => {
  const permissionRequests: string[] = []
  const permissionResponses: PermissionResponse[] = []
  const transport = await installSseTransport<{ directory: string; payload: Record<string, unknown> }>(page, {
    server: serverA,
    retry: 20,
  })
  await mockServers(page, permissionRequests, permissionResponses)
  await configureServers(page, [
    { type: "session", server: serverA, sessionId: sessionA.id },
    { type: "session", server: serverB, sessionId: sessionB.id },
  ])
  // An auto-accept switch saved by an older build for server A's folder must not approve anything any more.
  await page.addInitScript((folder) => {
    localStorage.setItem("opencode.global.dat:permission", JSON.stringify({ autoAccept: { [`${folder}/*`]: true } }))
  }, base64Encode(directoryA))

  const hrefB = `/server/${base64Encode(serverB)}/session/${sessionB.id}`
  await page.goto(`/server/${base64Encode(serverA)}/session/${sessionA.id}`)
  await expect(page.getByText(sessionA.title).first()).toBeVisible()

  await page.locator(`[data-titlebar-tab-slot]:has(a[href="${hrefB}"])`).click()
  await expect(page).toHaveURL(new RegExp(`${hrefB.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`))
  await expect(page.getByText(sessionB.title).first()).toBeVisible()
  await transport.waitForConnection()

  await transport.send({
    directory: directoryA,
    payload: {
      id: "event-permission-background-a",
      type: "permission.asked",
      properties: {
        id: "permission-background-a",
        sessionID: sessionA.id,
        permission: "bash",
        patterns: ["git status"],
        metadata: {},
        always: [],
      },
    },
  })
  await transport.send({
    directory: directoryA,
    payload: {
      id: "event-permission-background-a-guard",
      type: "permission.asked",
      properties: {
        id: "permission-background-a-guard",
        sessionID: childSessionA.id,
        permission: "bash",
        patterns: ["git push --force origin main"],
        metadata: { command: "git push --force origin main" },
        always: [],
        guard: { level: "guard", category: "destructive_git", reason: "Force push rewrites shared history" },
      },
    },
  })

  await page.waitForTimeout(1_000)
  expect(permissionResponses).toEqual([])
})

type PermissionResponse = {
  origin: string
  directory?: string
  sessionID: string
  permissionID: string
  body: unknown
}

async function storedFolderModes(page: Page) {
  return page.evaluate(() => {
    const result: { folder: string; mode: string }[] = []
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (!key?.includes("permission-mode")) continue
      const parsed = (() => {
        try {
          return JSON.parse(localStorage.getItem(key) ?? "null") as unknown
        } catch {
          return undefined
        }
      })()
      const value = typeof parsed === "string" ? (JSON.parse(parsed) as unknown) : parsed
      if (!value || typeof value !== "object" || !("folder" in value)) continue
      const folder = (value as { folder?: Record<string, string> }).folder ?? {}
      for (const [name, mode] of Object.entries(folder)) result.push({ folder: name, mode })
    }
    return result
  })
}

async function configureServers(page: Page, tabs: { type: "session"; server: string; sessionId: string }[] = []) {
  await page.addInitScript(
    ({ serverB, tabs }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem("opencode.global.dat:server", JSON.stringify({ list: [serverB] }))
      localStorage.setItem("opencode.window.browser.dat:tabs", JSON.stringify(tabs))
    },
    { serverB, tabs },
  )
}

async function mockServers(page: Page, permissionRequests: string[], permissionResponses: PermissionResponse[] = []) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== serverA && url.origin !== serverB) return route.fallback()
    const remote = url.origin === serverB
    const directory = remote ? directoryB : directoryA
    const sessions = remote ? [sessionB] : [sessionA, childSessionA]
    const requestDirectory = url.searchParams.get("directory")
    const response = url.pathname.match(/^\/session\/([^/]+)\/permissions\/([^/]+)$/)
    if (route.request().method() === "POST" && response) {
      permissionResponses.push({
        origin: url.origin,
        directory: requestDirectory ?? undefined,
        sessionID: response[1]!,
        permissionID: response[2]!,
        body: route.request().postDataJSON(),
      })
      return json(route, true)
    }
    if (requestDirectory && requestDirectory !== directory) return json(route, { name: "InvalidDirectory" }, 500)
    if (url.pathname === "/global/event" || url.pathname === "/event" || url.pathname === "/api/event")
      return sse(route)
    if (url.pathname === "/global/health") return json(route, { healthy: true, permissionModes: true })
    if (url.pathname === "/api/provider" || url.pathname === "/api/model" || url.pathname === "/api/agent")
      return json(route, { data: [] })
    if (url.pathname === "/api/model/default") return json(route, { data: null })
    if (["/api/command", "/api/reference", "/api/permission/request", "/api/question/request"].includes(url.pathname))
      return json(route, { location: { directory }, data: [] })
    if (url.pathname === "/api/mcp") return json(route, { location: { directory }, data: [] })
    if (url.pathname === "/api/mcp/resource")
      return json(route, { location: { directory }, data: { resources: [], templates: [] } })
    if (url.pathname === "/api/project") {
      return json(route, [
        {
          id: remote ? sessionB.projectID : "project-server-a",
          worktree: directory,
          vcs: "git",
          time: { created: 1, updated: 1 },
          sandboxes: [],
        },
      ])
    }
    if (url.pathname === "/api/project/current")
      return json(route, { id: remote ? sessionB.projectID : "project-server-a", directory })
    if (url.pathname === "/api/session")
      return json(route, { data: sessions.map((item) => currentSession(item)), cursor: {} })
    if (url.pathname === "/api/session/active") return json(route, { data: {} })
    const currentSessionInfo = sessions.find((session) => url.pathname === `/api/session/${session.id}`)
    if (currentSessionInfo) return json(route, { data: currentSession(currentSessionInfo) })
    if (sessions.some((session) => url.pathname === `/api/session/${session.id}/message`))
      return json(route, { data: [], cursor: {} })
    const current = sessions.find((session) => url.pathname === `/session/${session.id}`)
    if (current) return json(route, current)
    if (/^\/session\/[^/]+$/.test(url.pathname)) return json(route, { name: "NotFoundError" }, 404)
    if (/^\/session\/[^/]+\/message$/.test(url.pathname)) return json(route, [])
    if (/^\/session\/[^/]+\/(children|todo|diff)$/.test(url.pathname)) return json(route, [])
    if (url.pathname === "/permission") {
      permissionRequests.push(url.toString())
      return json(route, [])
    }
    if (["/skill", "/command", "/lsp", "/formatter", "/question", "/vcs/diff", "/pty/shells"].includes(url.pathname))
      return json(route, [])
    if (["/global/config", "/config", "/provider/auth", "/mcp"].includes(url.pathname)) return json(route, {})
    if (url.pathname === "/provider") return json(route, provider(remote ? "server-b" : "server-a"))
    if (url.pathname === "/agent") return json(route, [{ name: "build", mode: "primary" }])
    if (url.pathname === "/project" || url.pathname === "/project/current") {
      const project = {
        id: remote ? sessionB.projectID : "project-server-a",
        worktree: directory,
        vcs: "git",
        time: { created: 1, updated: 1 },
        sandboxes: [],
      }
      return json(route, url.pathname === "/project" ? [project] : project)
    }
    if (url.pathname === "/path")
      return json(route, {
        state: directory,
        config: directory,
        worktree: directory,
        directory,
        home: directory,
      })
    if (url.pathname === "/api/path")
      return json(route, { state: directory, config: directory, worktree: directory, directory, home: directory })
    if (url.pathname === "/vcs") return json(route, { branch: "main", default_branch: "main" })
    if (url.pathname === "/api/vcs")
      return json(route, { location: { directory }, data: { branch: "main", defaultBranch: "main" } })
    if (url.pathname === "/api/pty/shells") return json(route, { location: { directory }, data: [] })
    return json(route, {})
  })
}

function session(id: string, directory: string, title: string) {
  return {
    id,
    slug: id,
    projectID: `project-${id}`,
    directory,
    title,
    version: "dev",
    time: { created: 1, updated: 1 },
  }
}

function provider(id: string) {
  const name = id === "server-b" ? "Server B" : "Server A"
  return {
    all: [
      {
        id,
        name: `${name} Provider`,
        models: {
          [id]: {
            id,
            name: `${name} Model`,
            family: id,
            release_date: "2026-01-01",
            limit: { context: 200_000 },
          },
        },
      },
    ],
    connected: [id],
    default: { providerID: id, modelID: id },
  }
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  })
}

function sse(route: Route) {
  return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": ok\n\n" })
}
