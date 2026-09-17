import { describe, expect, test } from "bun:test"
import { pickModel } from "./model-query"

const model = (providerID: string, id: string, name: string, latest?: boolean) => ({
  id,
  name,
  provider: { id: providerID, name: providerID === "moonshot" ? "Moonshot AI" : providerID },
  latest,
})

const k2 = model("moonshot", "kimi-k2", "Kimi K2")
const k3 = model("moonshot", "kimi-k3", "Kimi K3")
const openrouterKimi = model("openrouter", "moonshotai/kimi-k2", "Kimi K2 (OpenRouter)")
const sonnet = model("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5")
const models = [k2, openrouterKimi, sonnet, k3]
const visible = () => true

describe("pickModel", () => {
  test("matches an exact provider/id", () => {
    expect(pickModel("openrouter/moonshotai/kimi-k2", { models, recent: [], visible })).toEqual({
      model: openrouterKimi,
      others: 0,
    })
    expect(pickModel("claude-sonnet-4-5", { models, recent: [], visible }).model).toBe(sonnet)
  })

  test("prefers a recently used match", () => {
    expect(pickModel("kimi", { models, recent: [sonnet, k2], visible }).model).toBe(k2)
  })

  test("without recents picks the highest version and counts the other matches", () => {
    expect(pickModel("kimi", { models, recent: [], visible })).toEqual({ model: k3, others: 2 })
    expect(pickModel("kimi", { models: [k2, k3], recent: [], visible })).toEqual({ model: k3, others: 1 })
  })

  test("prefers visible models", () => {
    expect(pickModel("kimi", { models: [k2, k3], recent: [], visible: (item) => item !== k3 }).model).toBe(k2)
  })

  test("a visible, recently used match beats a hidden model that only matches a better tier", () => {
    const routed = model("openrouter", "moonshotai/kimi-k2", "MoonshotAI: Kimi K2")
    const hidden = (item: typeof k2) => item !== k2
    expect(pickModel("kimi", { models: [k2, routed], recent: [routed], visible: hidden }).model).toBe(routed)
    expect(pickModel("kimi", { models: [k2, routed], recent: [], visible: hidden }).model).toBe(routed)
  })

  test("the id after a provider prefix and the name after a vendor label count as prefix matches", () => {
    const routed = model("openrouter", "moonshotai/kimi-k2", "MoonshotAI: Kimi K2")
    expect(pickModel("kimi", { models: [routed, sonnet], recent: [], visible }).model).toBe(routed)
    expect(pickModel("kimi-k2", { models: [routed, k3], recent: [], visible }).model).toBe(routed)
  })

  test("a hidden model is picked when no visible model matches, and an exact provider/id always wins", () => {
    const hidden = (item: typeof k2) => item !== k3
    expect(pickModel("kimi-k3", { models, recent: [], visible: hidden }).model).toBe(k3)
    expect(pickModel("moonshot/kimi-k3", { models, recent: [k2], visible: hidden }).model).toBe(k3)
  })

  test("matches every word of the query across provider, name and id", () => {
    expect(pickModel("moonshot k3", { models, recent: [], visible }).model).toBe(k3)
    expect(pickModel("sonnet", { models, recent: [], visible }).model).toBe(sonnet)
  })

  test("returns no model when nothing matches", () => {
    expect(pickModel("gpt-9", { models, recent: [], visible })).toEqual({ model: undefined, others: 0 })
  })
})
