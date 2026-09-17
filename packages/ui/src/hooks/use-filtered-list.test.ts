import { describe, expect, test } from "bun:test"
import { highlightedKey, pinExactMatches, resolveEnterTarget, startIndex } from "./use-filtered-list"

type Item = { id: string; trigger: string }

const items: Item[] = [
  { id: "a", trigger: "compact" },
  { id: "b", trigger: "new" },
  { id: "c", trigger: "compa" },
  { id: "d", trigger: "Compa" },
]
const key = (item: Item) => item.id
const exact = (item: Item, filter: string) => item.trigger.toLowerCase() === filter.toLowerCase()

describe("pinExactMatches", () => {
  test("moves only exact matches to the front and keeps the order stable", () => {
    expect(pinExactMatches(items, "compa", exact).map(key)).toEqual(["c", "d", "a", "b"])
  })

  test("returns the list unchanged without a matcher, filter or match", () => {
    expect(pinExactMatches(items, "compa")).toBe(items)
    expect(pinExactMatches(items, "", exact)).toBe(items)
    expect(pinExactMatches(items, "zzz", exact)).toBe(items)
  })
})

describe("resolveEnterTarget", () => {
  const base = { items, key, active: "a", filter: "new", exact }

  test("returns the active item when explicit selection is not required", () => {
    expect(resolveEnterTarget({ ...base, explicit: false })?.id).toBe("a")
  })

  test("returns the active item when it was picked explicitly", () => {
    expect(resolveEnterTarget({ ...base, explicit: true, requireExplicit: true })?.id).toBe("a")
  })

  test("returns the exact match when nothing was picked explicitly", () => {
    expect(resolveEnterTarget({ ...base, explicit: false, requireExplicit: true })?.id).toBe("b")
  })

  test("returns nothing without an explicit pick or an exact match", () => {
    expect(resolveEnterTarget({ ...base, filter: "comp", explicit: false, requireExplicit: true })).toBeUndefined()
    expect(resolveEnterTarget({ ...base, exact: undefined, explicit: false, requireExplicit: true })).toBeUndefined()
  })
})

describe("highlightedKey", () => {
  const base = { items, key, active: "a", exact }

  test("is the active item when explicit selection is not required or was made", () => {
    expect(highlightedKey({ ...base, filter: "comp", explicit: false })).toBe("a")
    expect(highlightedKey({ ...base, filter: "comp", explicit: true, requireExplicit: true })).toBe("a")
  })

  test("is only the exact match while Enter needs an explicit pick", () => {
    expect(highlightedKey({ ...base, filter: "comp", explicit: false, requireExplicit: true })).toBeUndefined()
    expect(highlightedKey({ ...base, filter: "new", explicit: false, requireExplicit: true })).toBe("b")
  })
})

describe("startIndex", () => {
  test("starts arrow navigation at the ends when nothing is highlighted", () => {
    expect(startIndex(4, 1, -1)).toBe(0)
    expect(startIndex(4, -1, -1)).toBe(3)
  })

  test("moves from the highlighted item and loops", () => {
    expect(startIndex(4, 1, 1)).toBe(2)
    expect(startIndex(4, 1, 3)).toBe(0)
    expect(startIndex(4, -1, 0)).toBe(3)
  })
})
