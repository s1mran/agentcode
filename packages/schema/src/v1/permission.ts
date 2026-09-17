export * as PermissionV1 from "./permission"

import { Schema } from "effect"
import { define, inventory } from "../event"
import { ascending } from "../identifier"
import { Project } from "../project"
import { optional, statics } from "../schema"
import { SessionID } from "../session-id"

export const ID = Schema.String.check(Schema.isStartsWith("per")).pipe(
  Schema.brand("PermissionID"),
  statics((schema) => ({ ascending: (id?: string) => schema.make(id ?? "per_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Action = Schema.Literals(["allow", "deny", "ask"]).annotate({ identifier: "PermissionAction" })
export type Action = typeof Action.Type

export const Mode = Schema.Literals(["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk"]).annotate({
  identifier: "PermissionMode",
})
export type Mode = typeof Mode.Type

export const Guard = Schema.Struct({
  level: Schema.Literals(["floor", "guard"]),
  category: Schema.Literals(["protected_path", "critical_rm", "destructive_git", "secret"]),
  reason: Schema.String,
  paths: optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "PermissionGuard" })
export type Guard = typeof Guard.Type

export const AlwaysScope = Schema.Literals(["project", "session", "acceptEdits"]).annotate({
  identifier: "PermissionAlwaysScope",
})
export type AlwaysScope = typeof AlwaysScope.Type

// Per-pattern classification supplied by the asking tool (for example the shell
// classifier). Hints only inform the permission decision and are never copied
// into the Request that clients see.
export const Hint = Schema.Struct({
  pattern: Schema.String,
  readOnly: optional(Schema.Boolean),
  projectWrite: optional(Schema.Boolean),
  strict: optional(Schema.String),
  loose: optional(Schema.String),
  withholdAlways: optional(Schema.Boolean),
  guard: optional(Guard),
}).annotate({ identifier: "PermissionHint" })
export type Hint = typeof Hint.Type

export const Rule = Schema.Struct({
  permission: Schema.String,
  pattern: Schema.String,
  action: Action,
  source: optional(Schema.Literals(["builtin"])),
}).annotate({
  identifier: "PermissionRule",
})
export type Rule = typeof Rule.Type

export const Ruleset = Schema.Array(Rule).annotate({ identifier: "PermissionRuleset" })
export type Ruleset = typeof Ruleset.Type

export const Request = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  permission: Schema.String,
  patterns: Schema.Array(Schema.String),
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  always: Schema.Array(Schema.String),
  tool: Schema.optional(Schema.Struct({ messageID: Schema.String, callID: Schema.String })),
  guard: optional(Guard),
  alwaysScope: optional(AlwaysScope),
}).annotate({ identifier: "PermissionRequest" })
export type Request = typeof Request.Type

export const Reply = Schema.Literals(["once", "always", "reject"])
export type Reply = typeof Reply.Type

export const ReplyBody = Schema.Struct({ reply: Reply, message: Schema.optional(Schema.String) }).annotate({
  identifier: "PermissionReplyBody",
})
export type ReplyBody = typeof ReplyBody.Type

export const Approval = Schema.Struct({ projectID: Project.ID, patterns: Schema.Array(Schema.String) }).annotate({
  identifier: "PermissionApproval",
})
export type Approval = typeof Approval.Type

export const AskInput = Schema.Struct({
  ...Request.fields,
  id: Schema.optional(ID),
  ruleset: Ruleset,
  hints: optional(Schema.Array(Hint)),
  // The agent running the tool call. Plan mode follows it; it is set by the engine's ask wrappers, never by tools,
  // and is not copied into the Request.
  agent: optional(Schema.String),
}).annotate({
  identifier: "PermissionAskInput",
})
export type AskInput = typeof AskInput.Type

export const ReplyInput = Schema.Struct({ requestID: ID, ...ReplyBody.fields }).annotate({
  identifier: "PermissionReplyInput",
})
export type ReplyInput = typeof ReplyInput.Type

const Asked = define({ type: "permission.asked", schema: Request.fields })
const Replied = define({
  type: "permission.replied",
  schema: { sessionID: SessionID, requestID: ID, reply: Reply },
})
export const Event = { Asked, Replied, Definitions: inventory(Asked, Replied) }
