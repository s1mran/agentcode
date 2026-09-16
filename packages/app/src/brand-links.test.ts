import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { AGENTCODE_ISSUES_URL } from "./constants/links"
import { dict } from "./i18n/en"

// Upstream opencode.ai links that are still correct for AgentCode. Anything else
// pointing at opencode.ai is a rebrand leftover and must be decided on explicitly.
const ALLOWED_OPENCODE_URLS = new Set([
  // OpenCode Zen is OpenCode's own paid service that AgentCode can connect to.
  "https://opencode.ai/zen",
  // Upstream provider docs: the opencode.json provider format still applies. The link is labelled as OpenCode's docs.
  "https://opencode.ai/docs/providers/#custom-provider",
  // Avatar shown only for the upstream opencode repository itself (layout/helpers.ts).
  "https://opencode.ai/favicon.svg",
])

const FORBIDDEN = ["desktop-feedback", "discord.gg", "changelog.json", "HighlightsProvider"]

const roots = [new URL("./", import.meta.url), new URL("../../desktop/src/renderer/", import.meta.url)]

async function sources() {
  const glob = new Bun.Glob("**/*.{ts,tsx}")
  const files: { path: string; text: string }[] = []
  for (const root of roots) {
    const cwd = fileURLToPath(root)
    for await (const path of glob.scan({ cwd })) {
      if (path.startsWith("i18n/") || path.includes("/i18n/")) continue
      if (/\.(test|stories)\.[^/]+$/.test(path)) continue
      files.push({ path: `${cwd}${path}`, text: await Bun.file(new URL(path, root)).text() })
    }
  }
  return files
}

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text()

describe("AgentCode links", () => {
  test("only allowlisted opencode.ai links remain in app and desktop renderer sources", async () => {
    const files = await sources()
    expect(files.length).toBeGreaterThan(50)

    const offenders = files.flatMap((file) =>
      Array.from(file.text.matchAll(/https?:\/\/(?:[\w-]+\.)*opencode\.ai[^\s"'`)<>]*/g), (match) => match[0])
        .filter((url) => !ALLOWED_OPENCODE_URLS.has(url))
        .map((url) => `${file.path}: ${url}`),
    )
    expect(offenders).toEqual([])
  })

  test("no source links to OpenCode's feedback, Discord or changelog feed", async () => {
    const files = await sources()
    const offenders = files.flatMap((file) =>
      FORBIDDEN.filter((needle) => file.text.includes(needle)).map((needle) => `${file.path}: ${needle}`),
    )
    expect(offenders).toEqual([])
  })

  test("help, feedback and error reports open the AgentCode issue tracker", async () => {
    expect(AGENTCODE_ISSUES_URL).toBe("https://github.com/s1mran/agentcode/issues")

    for (const path of ["./pages/error.tsx", "./pages/layout.tsx", "./pages/home/home-projects-controller.tsx"]) {
      expect(await read(path), path).toContain("platform.openExternal(AGENTCODE_ISSUES_URL)")
    }
  })

  test("OpenCode Zen link text matches its href", async () => {
    const text = await read("./components/dialog-connect-provider.tsx")
    const hrefs = Array.from(text.matchAll(/href="(https:\/\/opencode\.ai\/zen[^"]*)"/g), (match) => match[1])

    expect(hrefs).toHaveLength(2)
    expect(hrefs.every((href) => href === `https://${dict["provider.connect.opencodeZen.visit.link"]}`)).toBe(true)
  })

  test("settings screens drop the terminal-only theme docs and the release notes switch", async () => {
    for (const path of ["./components/settings-general.tsx", "./components/settings-v2/general.tsx"]) {
      const text = await read(path)
      expect(text.includes("docs/themes"), path).toBe(false)
      expect(text.includes("settings-release-notes"), path).toBe(false)
    }
  })

  test("web page title and install manifest name AgentCode", async () => {
    expect(await read("../index.html")).toContain("<title>AgentCode</title>")

    const manifest = JSON.parse(await read("../../ui/src/assets/favicon/site.webmanifest"))
    expect(manifest.name).toBe("AgentCode")
    expect(manifest.short_name).toBe("AgentCode")
  })
})
