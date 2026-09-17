import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260916000000_session-permission-mode",
  up(tx) {
    return Effect.gen(function* () {
      if (
        (yield* tx.all<{ name: string }>(`PRAGMA table_info(\`session\`)`)).some(
          (column) => column.name === "permission_mode",
        )
      )
        return
      yield* tx.run(`ALTER TABLE \`session\` ADD \`permission_mode\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
