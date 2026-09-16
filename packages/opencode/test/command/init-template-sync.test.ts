import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "url"

// The /init prompt exists twice: the live v1 template the desktop app serves and the v2 copy registered by
// packages/core/src/plugin/command.ts. They must not drift apart.
describe("/init template", () => {
  test("core v2 copy is byte-identical to the live v1 template", async () => {
    const v1 = await Bun.file(
      fileURLToPath(new URL("../../src/command/template/initialize.txt", import.meta.url)),
    ).text()
    const core = await Bun.file(
      fileURLToPath(new URL("../../../core/src/plugin/command/initialize.txt", import.meta.url)),
    ).text()

    expect(v1.length).toBeGreaterThan(0)
    expect(
      core,
      "packages/core/src/plugin/command/initialize.txt differs from packages/opencode/src/command/template/initialize.txt; edit both files together",
    ).toBe(v1)
  })
})
