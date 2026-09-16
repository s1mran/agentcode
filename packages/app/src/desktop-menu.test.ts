import { describe, expect, test } from "bun:test"
import { DESKTOP_MENU } from "./desktop-menu"

describe("desktop menu", () => {
  test("exports logs through the desktop command registry", () => {
    const items = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).filter(
      (item) => item.type === "item" && item.label === "Export Logs...",
    )

    expect(items).toHaveLength(2)
    expect(items.every((item) => item.type === "item" && item.command === "logs.export" && !item.action)).toBe(true)
  })

  test("labels the role-backed entries", () => {
    const windowMenu = DESKTOP_MENU.find((menu) => menu.role === "windowMenu")
    const roleItems = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).filter(
      (item) => item.type === "item" && item.role,
    )

    expect(windowMenu?.label).toBe("Window")
    expect(roleItems.length).toBeGreaterThan(0)
  })

  test("names the app menu AgentCode and links nowhere on opencode.ai", () => {
    const hrefs = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).flatMap((item) =>
      item.type === "item" && item.href ? [item.href] : [],
    )

    expect(DESKTOP_MENU.find((menu) => menu.id === "app")?.label).toBe("AgentCode")
    expect(hrefs.filter((href) => href.includes("opencode.ai"))).toEqual([])
  })
})
