import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import type { GlobalTrustEntry, TrustInfo } from "@opencode-ai/sdk/v2/client"
import { type Accessor, type Component, createResource, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { serverWorkspaceTrust } from "@/context/workspace-trust"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

const statusKey = {
  trusted: "settings.trust.status.trusted",
  untrusted: "settings.trust.status.untrusted",
  unknown: "settings.trust.status.unknown",
} as const

/**
 * Settings > Workspace trust: the current folder's decision (trust, restrict or forget it, and reset its MCP server
 * choices) and every stored decision, each of which can be forgotten. A change reloads the affected projects, which
 * stops their running sessions.
 */
export const SettingsTrustV2: Component<{ directory: Accessor<string | undefined> }> = (props) => {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const [busy, setBusy] = createSignal(false)

  const [supported] = createResource(serverSDK, (sdk) => serverWorkspaceTrust(sdk))
  const client = (directory: string) => serverSDK().createClient({ directory, throwOnError: true })

  const [current, { refetch: refetchCurrent }] = createResource(
    () => (supported() ? props.directory() : undefined),
    (directory): Promise<TrustInfo | undefined> =>
      client(directory)
        .trust.get()
        .then((response) => response.data)
        .catch(() => undefined),
  )
  const [list, { refetch: refetchList }] = createResource(
    () => (supported() ? serverSDK() : undefined),
    (sdk): Promise<GlobalTrustEntry[]> =>
      sdk.client.global.trust
        .list({ throwOnError: true })
        .then((response) => response.data ?? [])
        .catch(() => []),
  )

  const run = async (task: () => Promise<unknown>) => {
    if (busy()) return
    setBusy(true)
    try {
      await task()
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(false)
      await Promise.all([refetchCurrent(), refetchList()])
    }
  }

  const decide = (trusted: boolean) =>
    run(async () => {
      const directory = props.directory()
      const info = current()
      if (!directory || !info) return
      await client(directory).trust.set({ trusted, remember: !info.sessionOnly })
    })

  return (
    <>
      <div class="settings-v2-tab-header">
        <div class="settings-v2-tab-header-row">
          <h2 class="settings-v2-tab-title">{language.t("settings.trust.title")}</h2>
        </div>
      </div>
      <div class="settings-v2-tab-body">
        <Show
          when={supported()}
          fallback={<span class="text-13-regular text-text-weak">{language.t("settings.trust.unsupported")}</span>}
        >
          <div class="settings-v2-section">
            <h3 class="settings-v2-section-title">{language.t("settings.trust.current")}</h3>
            <Show
              when={current()}
              fallback={<span class="text-13-regular text-text-weak">{language.t("settings.trust.noFolder")}</span>}
            >
              {(info) => (
                <SettingsListV2>
                  <SettingsRowV2
                    title={info().path}
                    description={
                      info().sessionOnly
                        ? `${language.t(statusKey[info().status])} · ${language.t("settings.trust.sessionOnly")}`
                        : `${language.t(statusKey[info().status])} · ${language.t("settings.trust.reloadWarning")}`
                    }
                  >
                    <div class="flex flex-wrap gap-2 justify-end">
                      <ButtonV2
                        size="normal"
                        variant="neutral"
                        data-action="settings-trust-trust"
                        disabled={busy() || info().status === "trusted"}
                        onClick={() => void decide(true)}
                      >
                        {language.t("settings.trust.action.trust")}
                      </ButtonV2>
                      <ButtonV2
                        size="normal"
                        variant="outline"
                        data-action="settings-trust-restrict"
                        disabled={busy() || info().status === "untrusted"}
                        onClick={() => void decide(false)}
                      >
                        {language.t("settings.trust.action.restrict")}
                      </ButtonV2>
                      <ButtonV2
                        size="normal"
                        variant="ghost"
                        data-action="settings-trust-forget"
                        disabled={busy() || info().status === "unknown"}
                        onClick={() =>
                          void run(async () => {
                            const directory = props.directory()
                            if (directory) await client(directory).trust.forget()
                          })
                        }
                      >
                        {language.t("settings.trust.action.forget")}
                      </ButtonV2>
                    </div>
                  </SettingsRowV2>
                  <SettingsRowV2
                    title={language.t("settings.trust.action.resetMcp")}
                    description={language.t("settings.trust.resetMcp.description")}
                  >
                    <ButtonV2
                      size="normal"
                      variant="outline"
                      data-action="settings-trust-reset-mcp"
                      disabled={busy() || info().status !== "trusted"}
                      onClick={() =>
                        void run(async () => {
                          const directory = props.directory()
                          // The folder stays trusted; its project servers ask for approval again.
                          if (directory) await client(directory).trust.resetMcp()
                        })
                      }
                    >
                      {language.t("settings.trust.action.resetMcp")}
                    </ButtonV2>
                  </SettingsRowV2>
                </SettingsListV2>
              )}
            </Show>
          </div>

          <div class="settings-v2-section">
            <h3 class="settings-v2-section-title">{language.t("settings.trust.list.title")}</h3>
            <Show
              when={(list() ?? []).length > 0}
              fallback={<span class="text-13-regular text-text-weak">{language.t("settings.trust.list.empty")}</span>}
            >
              <SettingsListV2>
                <For each={list()}>
                  {(entry) => (
                    <SettingsRowV2
                      title={entry.path}
                      description={
                        entry.sessionOnly
                          ? language.t("settings.trust.sessionOnly")
                          : language.t(entry.trusted ? statusKey.trusted : statusKey.untrusted)
                      }
                    >
                      <ButtonV2
                        size="normal"
                        variant="ghost"
                        data-action="settings-trust-list-forget"
                        disabled={busy()}
                        onClick={() =>
                          void run(() =>
                            serverSDK().client.global.trust.forget({ path: entry.path }, { throwOnError: true }),
                          )
                        }
                      >
                        {language.t("settings.trust.action.forget")}
                      </ButtonV2>
                    </SettingsRowV2>
                  )}
                </For>
              </SettingsListV2>
            </Show>
          </div>
        </Show>
      </div>
    </>
  )
}
