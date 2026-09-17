import { createMemo, createSignal } from "solid-js"
import { useLocal } from "../context/local"
import { useSync } from "../context/sync"
import { map, pipe, entries, sortBy } from "remeda"
import { DialogSelect, type DialogSelectRef, type DialogSelectOption } from "../ui/dialog-select"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import { useSDK } from "../context/sdk"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { isHeldMcpStatus } from "../context/workspace-trust"

function Status(props: { enabled: boolean; loading: boolean; status?: string }) {
  const { theme } = useTheme()
  if (props.loading) {
    return <span style={{ fg: theme.textMuted }}>⋯ Loading</span>
  }
  if (props.status === "pending_approval") {
    return <span style={{ fg: theme.warning }}>⏸ Pending approval</span>
  }
  if (props.status === "rejected") {
    return <span style={{ fg: theme.textMuted }}>✘ Rejected</span>
  }
  if (props.enabled) {
    return <span style={{ fg: theme.success, attributes: TextAttributes.BOLD }}>✓ Enabled</span>
  }
  return <span style={{ fg: theme.textMuted }}>○ Disabled</span>
}

export function DialogMcp() {
  const local = useLocal()
  const sync = useSync()
  const sdk = useSDK()
  const [, setRef] = createSignal<DialogSelectRef<unknown>>()
  const [loading, setLoading] = createSignal<string | null>(null)
  const dialog = useDialog()
  const toast = useToast()

  const refresh = async () => {
    const status = await sdk.client.mcp.status()
    if (status.data) sync.set("mcp", status.data)
  }

  // A server from this folder's configuration that waits for approval: approve or reject it once the folder is trusted.
  const review = async (name: string) => {
    const info = (await sdk.client.trust.get().catch(() => undefined))?.data
    if (!info) return
    if (info.status !== "trusted") {
      toast.show({
        variant: "warning",
        message: "Trust this folder first: restart AgentCode here, or run agentcode trust",
      })
      return
    }
    const held = info.held.find((item) => item.kind === "mcp" && item.name === name)
    const runs = held?.kind === "mcp" ? (held.type === "local" ? (held.command ?? []).join(" ") : held.url) : ""
    const answer = (approve: boolean) =>
      void sdk.client.trust
        .mcp({ name, approve })
        .then(refresh)
        .catch(() => toast.show({ variant: "error", message: "Could not save the MCP server choice" }))
    dialog.replace(() => (
      <DialogSelect<boolean>
        title={`Approve MCP server ${name}?`}
        options={[
          {
            value: true,
            title: "Approve",
            description: "Start it from this folder's configuration",
            details: [`Runs: ${runs ?? ""}`],
          },
          { value: false, title: "Reject", description: "Keep it off until you reset this folder's MCP choices" },
        ]}
        onSelect={(option) => {
          dialog.clear()
          answer(option.value)
        }}
      />
    ))
  }

  const options = createMemo(() => {
    // Track sync data and loading state to trigger re-render when they change
    const mcpData = sync.data.mcp
    const loadingMcp = loading()

    return pipe(
      mcpData ?? {},
      entries(),
      sortBy(([name]) => name),
      map(([name, status]) => ({
        value: name,
        title: name,
        description:
          (status.status as string) === "pending_approval"
            ? "pending approval"
            : status.status === "failed"
              ? "failed"
              : status.status,
        footer: (
          <Status enabled={local.mcp.isEnabled(name)} loading={loadingMcp === name} status={status.status as string} />
        ),
        category: undefined,
      })),
    )
  })

  const actions = createMemo(() => [
    {
      command: "dialog.mcp.toggle",
      title: "toggle",
      onTrigger: async (option: DialogSelectOption<string>) => {
        // Prevent toggling while an operation is already in progress
        if (loading() !== null) return
        if (isHeldMcpStatus(sync.data.mcp[option.value]?.status as string | undefined)) {
          await review(option.value)
          return
        }

        setLoading(option.value)
        try {
          await local.mcp.toggle(option.value)
          // Refresh MCP status from server
          const status = await sdk.client.mcp.status()
          if (status.data) {
            sync.set("mcp", status.data)
          } else {
            console.error("Failed to refresh MCP status: no data returned")
          }
        } catch (error) {
          console.error("Failed to toggle MCP:", error)
        } finally {
          setLoading(null)
        }
      },
    },
  ])

  return (
    <DialogSelect
      ref={setRef}
      title="MCPs"
      options={options()}
      actions={actions()}
      onSelect={(option) => {
        // Don't close on select, only on escape. Enter on a server waiting for approval reviews it.
        if (isHeldMcpStatus(sync.data.mcp[option.value]?.status as string | undefined)) void review(option.value)
      }}
    />
  )
}
