import { Component, createMemo, createSignal, Show } from "solid-js"
import { useSync } from "@/context/sync"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Switch } from "@opencode-ai/ui/switch"
import { useLanguage } from "@/context/language"
import { useMcpToggle } from "@/context/mcp"
import { useSDK } from "@/context/sdk"
import { isHeldMcp, type McpStatus } from "@/context/global-sync/mcp"
import { DialogWorkspaceTrust } from "@/components/dialog-workspace-trust"
import { showToast } from "@/utils/toast"

const statusLabels = {
  connected: "mcp.status.connected",
  failed: "mcp.status.failed",
  needs_auth: "mcp.status.needs_auth",
  needs_client_registration: "mcp.status.needs_client_registration",
  disabled: "mcp.status.disabled",
  pending_approval: "mcp.status.pendingApproval",
  rejected: "mcp.status.rejected",
} as const

/** Approve or reject one MCP server from a trusted folder's configuration, showing what it runs. */
const DialogApproveMcp: Component<{ name: string; command: string; onAnswer: (approve: boolean) => Promise<void> }> = (
  props,
) => {
  const dialog = useDialog()
  const language = useLanguage()
  const [pending, setPending] = createSignal(false)
  const answer = async (approve: boolean) => {
    if (pending()) return
    setPending(true)
    try {
      await props.onAnswer(approve)
    } finally {
      setPending(false)
      dialog.close()
    }
  }
  return (
    <Dialog title={language.t("dialog.mcp.approve.title")} fit>
      <div data-component="dialog-approve-mcp" class="flex flex-col gap-4 pl-6 pr-2.5 pb-3 max-w-[480px]">
        <span class="text-14-regular text-text-strong">{language.t("dialog.mcp.approve.body")}</span>
        <span class="text-12-regular text-text-base break-all">
          {props.name}: {props.command}
        </span>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" autofocus disabled={pending()} onClick={() => void answer(false)}>
            {language.t("dialog.mcp.approve.reject")}
          </Button>
          <Button variant="primary" size="large" disabled={pending()} onClick={() => void answer(true)}>
            {language.t("dialog.mcp.approve.approve")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export const DialogSelectMcp: Component = () => {
  const sync = useSync()
  const language = useLanguage()

  const items = createMemo(() =>
    Object.entries(sync().data.mcp ?? {})
      .map(([name, status]) => ({ name, status: status.status }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  )

  const toggle = useMcpToggle()
  const dialog = useDialog()
  const sdk = useSDK()

  const failed = (error: unknown) => {
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: error instanceof Error ? error.message : String(error),
    })
  }

  // A held server: until the folder is trusted, ask about the folder; in a trusted folder, approve this server.
  const review = async (name: string) => {
    const info = await sdk()
      .client.trust.get()
      .then((response) => response.data)
      .catch(() => undefined)
    if (!info) return
    if (info.status !== "trusted") {
      void dialog.push(() => (
        <DialogWorkspaceTrust info={info} onDecide={(payload) => sdk().client.trust.set(payload).catch(failed)} />
      ))
      return
    }
    const held = info.held.find((item) => item.kind === "mcp" && item.name === name)
    const command = held?.kind === "mcp" ? (held.type === "local" ? (held.command ?? []).join(" ") : held.url) : ""
    void dialog.push(() => (
      <DialogApproveMcp
        name={name}
        command={command ?? ""}
        onAnswer={(approve) => sync().mcp.approve(name, approve).catch(failed)}
      />
    ))
  }

  const enabledCount = createMemo(() => items().filter((i) => i.status === "connected").length)
  const totalCount = createMemo(() => items().length)

  return (
    <Dialog
      title={language.t("dialog.mcp.title")}
      description={language.t("dialog.mcp.description", { enabled: enabledCount(), total: totalCount() })}
    >
      <List
        class="px-3"
        search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.mcp.empty")}
        key={(x) => x?.name ?? ""}
        items={items}
        filterKeys={["name", "status"]}
        sortBy={(a, b) => a.name.localeCompare(b.name)}
        onSelect={(x) => {
          if (!x || x.status === "pending" || toggle.isPending) return
          if (isHeldMcp(x.status as McpStatus)) return void review(x.name)
          toggle.mutate(x.name)
        }}
      >
        {(i) => {
          const mcpStatus = () => sync().data.mcp[i.name]
          const status = () => mcpStatus()?.status
          const statusLabel = () => {
            const s = mcpStatus() as { status: McpStatus; reason?: string } | undefined
            if (s?.status === "pending_approval" && s.reason === "changed")
              return language.t("mcp.status.changedSinceApproval")
            const key = status() ? statusLabels[status() as keyof typeof statusLabels] : undefined
            if (!key) return
            return language.t(key)
          }
          const error = () => {
            const s = mcpStatus()
            if (s?.status === "failed" || s?.status === "needs_client_registration") return s.error
          }
          const enabled = () => status() === "connected"
          return (
            <div class="w-full flex items-center justify-between gap-x-3">
              <div class="flex flex-col gap-0.5 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="truncate">{i.name}</span>
                  <Show when={statusLabel()}>
                    <span class="text-11-regular text-text-weaker">{statusLabel()}</span>
                  </Show>
                </div>
                <Show when={error()}>
                  <span class="text-11-regular text-text-weaker truncate">{error()}</span>
                </Show>
              </div>
              <div onClick={(e) => e.stopPropagation()}>
                <Switch
                  checked={enabled()}
                  disabled={status() === "pending" || (toggle.isPending && toggle.variables === i.name)}
                  onChange={() => {
                    if (toggle.isPending) return
                    if (isHeldMcp(status() as McpStatus)) return void review(i.name)
                    toggle.mutate(i.name)
                  }}
                />
              </div>
            </div>
          )
        }}
      </List>
    </Dialog>
  )
}
