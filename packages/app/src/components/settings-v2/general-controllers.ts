import { createMemo, createResource, onMount, type Accessor } from "solid-js"
import type { ColorScheme } from "@opencode-ai/ui/theme/context"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { usePermission } from "@/context/permission"
import { folderModeOptions, type PermissionMode } from "@/context/permission-mode"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import {
  monoDefault,
  monoFontFamily,
  monoInput,
  sansDefault,
  sansFontFamily,
  sansInput,
  terminalDefault,
  terminalFontFamily,
  terminalInput,
  useSettings,
} from "@/context/settings"
import { playSoundById, SOUND_OPTIONS } from "@/utils/sound"
import { createSoundPreviewController, type ShellOption } from "./general-controller-behavior"

export { createShellOptions, createSoundPreviewController } from "./general-controller-behavior"
export type { ShellOption, ShellSelectOption } from "./general-controller-behavior"

export function createPermissionScopeController(sessionID: Accessor<string | undefined>) {
  const permission = usePermission()
  const serverSync = useServerSync()
  // The open session's directory, else the route or draft directory, so the setting also works before a session
  // exists. The permission context stores it under the project root, so worktree sessions and drafts share it.
  const directory = createMemo(() => {
    const id = sessionID()
    const session = id ? serverSync().session.lineage.peek(id)?.session.directory : undefined
    return session ?? permission.activeDirectory()
  })
  const value = createMemo<PermissionMode>(() => {
    const dir = directory()
    if (!dir) return "default"
    return permission.defaultMode(dir)
  })

  // The default permission mode for new sessions in this folder. Picking what the engine would use anyway clears the
  // stored override, so a config default_permission_mode applies again.
  return {
    value,
    options: createMemo(() => folderModeOptions(value())),
    enabled: createMemo(() => !!directory() && permission.modesSupported()),
    set: (mode: PermissionMode) => {
      const dir = directory()
      if (!dir) return
      permission.setFolderMode(dir, mode)
    },
  }
}

export function createShellSettingsController() {
  const serverSdk = useServerSDK()
  const serverSync = useServerSync()
  const [shells] = createResource(
    async () => {
      const sdk = serverSdk()
      if ((await sdk.protocol) === "v1") return (await sdk.client.pty.shells()).data ?? []
      return [] as ShellOption[]
    },
    { initialValue: [] as ShellOption[] },
  )
  const current = createMemo(() => serverSync().data.config.shell ?? "")

  return {
    shells: () => shells.latest,
    current,
    select: (value: string) => {
      if (value === current()) return
      void serverSync().updateConfig({ shell: value })
    },
  }
}

export function createAppearanceSettingsController() {
  const settings = useSettings()
  const theme = useTheme()
  const themes = createMemo(() => theme.ids().map((id) => ({ id, name: theme.name(id) })))

  onMount(() => void theme.loadThemes())

  return {
    scheme: {
      current: theme.colorScheme,
      select: (value: ColorScheme) => theme.setColorScheme(value),
    },
    theme: {
      options: themes,
      current: createMemo(() => themes().find((option) => option.id === theme.themeId())),
      select: (option: { id: string } | null) => option && theme.setTheme(option.id),
    },
    fonts: {
      ui: createMemo(() => ({
        value: sansInput(settings.appearance.uiFont()),
        family: sansFontFamily(settings.appearance.uiFont()),
        placeholder: sansDefault,
      })),
      code: createMemo(() => ({
        value: monoInput(settings.appearance.font()),
        family: monoFontFamily(settings.appearance.font()),
        placeholder: monoDefault,
      })),
      terminal: createMemo(() => ({
        value: terminalInput(settings.appearance.terminalFont()),
        family: terminalFontFamily(settings.appearance.terminalFont()),
        placeholder: terminalDefault,
      })),
      setUI: (value: string) => settings.appearance.setUIFont(value),
      setCode: (value: string) => settings.appearance.setFont(value),
      setTerminal: (value: string) => settings.appearance.setTerminalFont(value),
    },
  }
}

const noneSound = { id: "none", label: "sound.option.none" } as const
export const soundOptions = [noneSound, ...SOUND_OPTIONS]
export type SoundSelectOption = (typeof soundOptions)[number]

export function createSoundSettingsController() {
  const settings = useSettings()
  const preview = createSoundPreviewController(playSoundById)
  const channel = (
    enabled: Accessor<boolean>,
    current: Accessor<string>,
    setEnabled: (value: boolean) => void,
    set: (id: string) => void,
  ) => ({
    current: createMemo(() =>
      enabled() ? (soundOptions.find((option) => option.id === current()) ?? noneSound) : noneSound,
    ),
    highlight: (option: SoundSelectOption | undefined) => {
      if (!option) return
      preview.play(option.id === "none" ? undefined : option.id)
    },
    select: (option: SoundSelectOption | null) => {
      if (!option) return
      if (option.id === "none") {
        setEnabled(false)
        preview.stop()
        return
      }
      setEnabled(true)
      set(option.id)
      preview.play(option.id)
    },
  })

  return {
    agent: channel(
      settings.sounds.agentEnabled,
      settings.sounds.agent,
      (value) => settings.sounds.setAgentEnabled(value),
      (id) => settings.sounds.setAgent(id),
    ),
    permissions: channel(
      settings.sounds.permissionsEnabled,
      settings.sounds.permissions,
      (value) => settings.sounds.setPermissionsEnabled(value),
      (id) => settings.sounds.setPermissions(id),
    ),
    errors: channel(
      settings.sounds.errorsEnabled,
      settings.sounds.errors,
      (value) => settings.sounds.setErrorsEnabled(value),
      (id) => settings.sounds.setErrors(id),
    ),
  }
}

export type PermissionScopeController = ReturnType<typeof createPermissionScopeController>
export type ShellSettingsController = ReturnType<typeof createShellSettingsController>
export type AppearanceSettingsController = ReturnType<typeof createAppearanceSettingsController>
export type SoundSettingsController = ReturnType<typeof createSoundSettingsController>
