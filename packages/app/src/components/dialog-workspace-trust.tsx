import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import type { TrustHeldItem, TrustInfo } from "@opencode-ai/sdk/v2/client"
import { createEffect, createMemo, createResource, createSignal, For, type JSX, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import {
  groupHeld,
  isRestricted,
  queuedTrustDialogApplies,
  serverWorkspaceTrust,
  trustDialogs,
  shouldAskTrust,
  trustPrompts,
  type TrustPayload,
  trustPayload,
} from "@/context/workspace-trust"
import { showToast } from "@/utils/toast"

function describe(item: TrustHeldItem) {
  switch (item.kind) {
    case "plugin":
      return item.spec
    case "tool":
      return item.file
    case "mcp":
      return item.type === "local" ? (item.command ?? []).join(" ") : (item.url ?? "")
    case "permission":
      return `${item.agent ? `${item.agent}: ` : ""}${item.permission} ${item.pattern}`
    case "command":
      return `/${item.name}`
    case "setting":
      return item.detail ? `${item.key}: ${item.detail}` : item.key
  }
}

function Group(props: { title: string; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-1">
      <span class="text-12-medium text-text-weak">{props.title}</span>
      <div class="flex flex-col gap-1 pl-2">{props.children}</div>
    </div>
  )
}

/**
 * Asks whether a folder's own configuration may run. Trust saves the decision (for the home folder, only for this
 * session) and approves the MCP servers left checked; Restricted mode saves the folder as untrusted; Escape records
 * nothing, so the folder stays restricted and is asked about again next launch. Restricted is focused, so Enter never
 * trusts by accident.
 */
export function DialogWorkspaceTrust(props: {
  info: TrustInfo
  onDecide: (payload: TrustPayload) => Promise<unknown>
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [pending, setPending] = createSignal(false)
  const [unchecked, setUnchecked] = createStore<Record<string, boolean>>({})
  const groups = createMemo(() => groupHeld(props.info.held))

  const decide = async (trusted: boolean) => {
    if (pending()) return
    setPending(true)
    try {
      await props.onDecide(
        trustPayload({
          trusted,
          sessionOnly: props.info.sessionOnly,
          held: props.info.held,
          unchecked: new Set(Object.entries(unchecked).flatMap(([name, value]) => (value ? [name] : []))),
        }),
      )
    } finally {
      setPending(false)
      dialog.close()
    }
  }

  return (
    <Dialog title={language.t("dialog.workspaceTrust.title")} fit>
      <div data-component="dialog-workspace-trust" class="flex flex-col gap-4 pl-6 pr-2.5 pb-3 max-w-[560px]">
        <span class="text-12-regular text-text-weak break-all">{props.info.path}</span>
        <span class="text-14-regular text-text-strong">{language.t("dialog.workspaceTrust.body")}</span>
        <div class="flex flex-col gap-3 max-h-[320px] overflow-y-auto">
          <Show when={props.info.held.length === 0}>
            <span class="text-13-regular text-text-weak">{language.t("dialog.workspaceTrust.nothingHeld")}</span>
          </Show>
          <Show when={groups().code.length}>
            <Group title={language.t("dialog.workspaceTrust.group.code")}>
              <For each={groups().code}>
                {(item) => <span class="text-12-regular text-text-base break-all">{describe(item)}</span>}
              </For>
            </Group>
          </Show>
          <Show when={groups().mcp.length}>
            <Group title={language.t("dialog.workspaceTrust.group.mcp")}>
              <For each={groups().mcp}>
                {(item) => (
                  <Checkbox
                    checked={!unchecked[item.name]}
                    onChange={(checked: boolean) => setUnchecked(item.name, !checked)}
                    description={describe(item)}
                  >
                    {item.name}
                  </Checkbox>
                )}
              </For>
            </Group>
          </Show>
          <Show when={groups().permission.length}>
            <Group title={language.t("dialog.workspaceTrust.group.permission")}>
              <For each={groups().permission}>
                {(item) => <span class="text-12-regular text-text-base break-all">{describe(item)}</span>}
              </For>
            </Group>
          </Show>
          <Show when={groups().command.length}>
            <Group title={language.t("dialog.workspaceTrust.group.command")}>
              <For each={groups().command}>
                {(item) => <span class="text-12-regular text-text-base break-all">{describe(item)}</span>}
              </For>
            </Group>
          </Show>
          <Show when={groups().setting.length}>
            <Group title={language.t("dialog.workspaceTrust.group.setting")}>
              <For each={groups().setting}>
                {(item) => <span class="text-12-regular text-text-base break-all">{describe(item)}</span>}
              </For>
            </Group>
          </Show>
        </div>
        <span class="text-13-medium text-text-strong">{language.t("dialog.workspaceTrust.warning")}</span>
        <div class="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="large"
            autofocus
            data-action="workspace-trust-restricted"
            disabled={pending()}
            onClick={() => void decide(false)}
          >
            {language.t("dialog.workspaceTrust.restricted")}
          </Button>
          <Button
            variant="primary"
            size="large"
            data-action="workspace-trust-trust"
            disabled={pending()}
            onClick={() => void decide(true)}
          >
            {props.info.sessionOnly
              ? language.t("dialog.workspaceTrust.trustSession")
              : language.t("dialog.workspaceTrust.trust")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

// One trust dialog at a time: folders restored together at startup are asked about in turn, and never over a dialog
// the user already has open.
let queue = Promise.resolve()
function enqueue(task: () => Promise<void>) {
  queue = queue.then(task, task)
}

// Folders whose restricted-mode notice was shown in this app launch.
const noticed = new Set<string>()

/**
 * Mounted with each folder's data. On an engine that advertises workspace trust it asks about a folder nobody has
 * decided on (once per launch), and while the folder runs restricted it shows a notice with a way to trust it.
 */
export function WorkspaceTrustGate(props: { directory: string }) {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const dialog = useDialog()
  const language = useLanguage()
  const [supported, setSupported] = createSignal(false)

  createEffect(() => {
    const current = serverSDK()
    void serverWorkspaceTrust(current).then((value) => {
      if (serverSDK() === current) setSupported(value)
    })
  })

  const [info, { refetch }] = createResource(
    () => (supported() ? sdk().directory : undefined),
    () =>
      sdk()
        .client.trust.get()
        .then((response) => response.data)
        .catch(() => undefined),
  )

  createEffect(() => {
    const current = sdk()
    const stop = current.event.listen((evt) => {
      const details = evt.details as { type: string }
      if (details.type === "server.instance.disposed") void refetch()
    })
    onCleanup(stop)
  })

  const decide = async (payload: TrustPayload) => {
    await sdk()
      .client.trust.set(payload)
      .catch((error: unknown) =>
        showToast({
          variant: "error",
          title: language.t("dialog.workspaceTrust.failed"),
          description: error instanceof Error ? error.message : String(error),
        }),
      )
    await refetch()
  }

  // The dialog shows the state fetched when its turn comes, not when it was queued: another folder of the same
  // repository may have been decided in between.
  const ask = (current: TrustInfo, automatic: boolean) => {
    if (!trustDialogs.claim(current.path)) return
    enqueue(async () => {
      try {
        while (dialog.active) await new Promise<void>((resolve) => setTimeout(resolve, 500))
        const fresh = await sdk()
          .client.trust.get()
          .then((response) => response.data)
          .catch(() => undefined)
        if (!fresh || !queuedTrustDialogApplies({ automatic, fresh })) {
          void refetch()
          return
        }
        await new Promise<void>((resolve) => {
          void dialog.show(() => <DialogWorkspaceTrust info={fresh} onDecide={decide} />, resolve)
        })
      } finally {
        trustDialogs.release(current.path)
      }
    })
  }

  createEffect(() => {
    const current = info()
    const key = trustPrompts.key(sdk().scope, props.directory)
    if (shouldAskTrust({ supported: supported(), info: current, asked: trustPrompts.has(key) }) && current) {
      trustPrompts.add(key)
      ask(current, true)
      return
    }
    if (!current || !isRestricted({ supported: supported(), info: current }) || noticed.has(key)) return
    if (current.status === "unknown" && !trustPrompts.has(key)) return
    noticed.add(key)
    showToast({
      variant: "default",
      persistent: true,
      title: language.t("banner.restrictedMode.title"),
      description: language.t("banner.restrictedMode.body"),
      actions: [
        { label: language.t("banner.restrictedMode.action"), onClick: () => ask(current, false) },
        { label: language.t("common.dismiss"), onClick: "dismiss" },
      ],
    })
  })

  return null
}
