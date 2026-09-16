import { describe, expect, test } from "bun:test"
import path from "path"
import { FormatError } from "../../src/cli/error"

const packages = path.resolve(import.meta.dir, "../../..")
const skill = () => Bun.file(path.join(packages, "core/src/plugin/skill/customize-opencode.md")).text()

// The customize-opencode skill tells the model that AgentCode's own ConfigInvalidError beats the upstream schema.
// The model may see that error in the app or in CLI output from bash, so the skill must name both wordings, and
// each quoted wording must match what that surface really prints.
describe("customize-opencode skill: config validation errors", () => {
  test("names the CLI and terminal UI wording, matching the CLI formatter", async () => {
    const content = await skill()
    expect(content).toContain("`Configuration is invalid at <path>`")

    const printed = FormatError({
      name: "ConfigInvalidError",
      data: {
        path: "/work/opencode.json",
        issues: [{ message: "Expected a positive integer", path: ["provider", "x", "options", "chunkTimeout"] }],
      },
    })
    expect(printed).toStartWith("Configuration is invalid at /work/opencode.json")
  })

  test("names the app wording, matching the app's English string", async () => {
    const content = await skill()
    expect(content).toContain("`Config file at <path> is invalid`")

    const en = await Bun.file(path.join(packages, "app/src/i18n/en.ts")).text()
    expect(en).toContain(`"error.chain.configInvalid": "Config file at {{path}} is invalid"`)
  })

  test("says the validation error wins whatever its wording", async () => {
    const content = (await skill()).replace(/\s+/g, " ")
    expect(content).toContain("Whatever the wording, if AgentCode says the config is invalid")
    expect(content).toContain("even when the upstream schema allows the value")
  })
})
