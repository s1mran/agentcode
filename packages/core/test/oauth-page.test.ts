import { describe, expect, test } from "bun:test"
import { OauthCallbackPage } from "../src/oauth/page"

function brandSlice(html: string) {
  const start = html.indexOf('<div class="brand">')
  const end = html.indexOf("</div>", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return html.slice(start, end)
}

describe("OauthCallbackPage", () => {
  test("escapes bootstrap options embedded in the inline script", () => {
    const html = OauthCallbackPage.bootstrap({
      provider: `xAI</script><script>alert("provider")</script>`,
      tokenPath: `/token</script><script>alert("path")</script>`,
    })

    expect(html.match(/<\/script>/g)).toHaveLength(1)
    expect(html).toContain(`xAI\\u003c/script>\\u003cscript>alert(\\\"provider\\\")\\u003c/script>`)
    expect(html).toContain(`/token\\u003c/script>\\u003cscript>alert(\\\"path\\\")\\u003c/script>`)
  })

  test("success page is branded AgentCode", () => {
    const html = OauthCallbackPage.success({ provider: "MCP" })

    expect(html).toContain("<title>Authorization successful · AgentCode</title>")
    expect(html).toContain("AgentCode is now connected to MCP.")
    expect(html).not.toMatch(/opencode/i)
  })

  test("success page without a provider says AgentCode is authorized", () => {
    const html = OauthCallbackPage.success()

    expect(html).toContain("AgentCode is now authorized.")
    expect(html).not.toMatch(/opencode/i)
  })

  test("error page is branded AgentCode", () => {
    const html = OauthCallbackPage.error("boom", { provider: "Snowflake" })

    expect(html).toContain("<title>Authorization failed · AgentCode</title>")
    expect(html).toContain("AgentCode couldn't finish connecting to Snowflake.")
    expect(html).toContain("try again from AgentCode.")
    expect(html).toContain('<pre class="detail" id="oc-detail">boom</pre>')
    expect(html).not.toMatch(/opencode/i)
  })

  test("bootstrap script uses the AgentCode name for its in-place messages", () => {
    const html = OauthCallbackPage.bootstrap({ tokenPath: "/t", provider: "DigitalOcean" })

    expect(html).toContain('var APP="AgentCode"')
    expect(html).toContain("<title>Finishing sign-in · AgentCode</title>")
    expect(html).not.toMatch(/OpenCode/)
    expect(html.match(/<\/script>/g)).toHaveLength(1)
  })

  test("every page shows the AgentCode mark using theme tokens only", () => {
    const pages = [
      OauthCallbackPage.success({ provider: "MCP" }),
      OauthCallbackPage.error("boom", { provider: "Snowflake" }),
      OauthCallbackPage.bootstrap({ tokenPath: "/t", provider: "DigitalOcean" }),
    ]

    for (const html of pages) {
      expect(html).toContain('viewBox="0 0 16 20"')
      expect(html).toContain('<span class="brand-name">AgentCode</span>')
      expect(html).not.toContain('viewBox="0 0 234 42"')

      const brand = brandSlice(html)
      expect(brand).toContain("var(--oc-icon-strong)")
      expect(brand).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    }
  })
})
