import { WorkspaceTrustRestrict } from "@/trust/restrict"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { McpServerNotFoundError, WorkspaceTrustRequiredError, WorkspaceTrustStoreError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

export const TrustKind = Schema.Literals(["repository", "directory"])
export const TrustStatus = Schema.Literals(["trusted", "untrusted", "unknown"])
export const TrustEffective = Schema.Literals(["full", "headless", "restricted"])

export const TrustInfo = Schema.Struct({
  path: Schema.String,
  kind: TrustKind,
  status: TrustStatus,
  source: Schema.optional(Schema.Literals(["stored", "parent", "session", "launch"])),
  policy: Schema.Literals(["prompt", "headless", "trusted", "untrusted"]),
  /** What this instance loaded with. It changes only when the instance reloads after a decision. */
  effective: TrustEffective,
  sessionOnly: Schema.Boolean,
  held: Schema.Array(WorkspaceTrustRestrict.HeldItem),
  mcp: Schema.Struct({
    approved: Schema.Array(Schema.String),
    rejected: Schema.Array(Schema.String),
  }),
}).annotate({ identifier: "TrustInfo" })

export const TrustSetPayload = Schema.Struct({
  trusted: Schema.Boolean,
  remember: Schema.optional(Schema.Boolean),
  mcp: Schema.optional(
    Schema.Struct({
      approve: Schema.optional(Schema.Array(Schema.String)),
      reject: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
})

export const TrustDecision = Schema.Struct({
  path: Schema.String,
  status: TrustStatus,
  effective: TrustEffective,
}).annotate({ identifier: "TrustDecision" })

export const TrustMcpPayload = Schema.Struct({
  approve: Schema.Boolean,
})

export const TrustPaths = {
  trust: "/trust",
  mcpReset: "/trust/mcp",
  mcp: "/trust/mcp/:name",
} as const

export const TrustApi = HttpApi.make("trust")
  .add(
    HttpApiGroup.make("trust")
      .add(
        HttpApiEndpoint.get("get", TrustPaths.trust, {
          query: WorkspaceRoutingQuery,
          success: described(TrustInfo, "Workspace trust state"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "trust.get",
            summary: "Get workspace trust",
            description:
              "Whether this folder is trusted, the effective mode this instance loaded with, and the project configuration held until it is trusted.",
          }),
        ),
        HttpApiEndpoint.post("set", TrustPaths.trust, {
          query: WorkspaceRoutingQuery,
          payload: TrustSetPayload,
          success: described(TrustDecision, "Trust decision recorded"),
          error: WorkspaceTrustStoreError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "trust.set",
            summary: "Trust or restrict this folder",
            description:
              "Record a workspace trust decision, approving or rejecting held project MCP servers by name. Every loaded instance the decision covers reloads after the response.",
          }),
        ),
        HttpApiEndpoint.delete("forget", TrustPaths.trust, {
          query: WorkspaceRoutingQuery,
          success: described(TrustDecision, "Trust decision removed"),
          error: WorkspaceTrustStoreError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "trust.forget",
            summary: "Forget workspace trust",
            description: "Remove the trust decision for this folder, so it is asked again. Covered instances reload.",
          }),
        ),
        HttpApiEndpoint.delete("resetMcp", TrustPaths.mcpReset, {
          query: WorkspaceRoutingQuery,
          success: described(TrustDecision, "MCP server choices cleared"),
          error: WorkspaceTrustStoreError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "trust.resetMcp",
            summary: "Reset project MCP server choices",
            description:
              "Clear the approved and rejected MCP servers of this folder's configuration, so they ask for approval again. The instance reloads.",
          }),
        ),
        HttpApiEndpoint.post("mcp", TrustPaths.mcp, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: TrustMcpPayload,
          success: described(TrustDecision, "MCP server choice recorded"),
          error: [WorkspaceTrustRequiredError, McpServerNotFoundError, WorkspaceTrustStoreError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "trust.mcp",
            summary: "Approve or reject a project MCP server",
            description:
              "Approve or reject one held MCP server from this folder's configuration. The folder must be trusted.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "trust",
          description: "Workspace trust routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
