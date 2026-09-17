import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { DockPrompt } from "@opencode-ai/session-ui/dock-prompt"
import { Icon } from "@opencode-ai/ui/icon"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useLanguage } from "@/context/language"
import {
  COMMAND_MAX_LINES,
  alwaysLabel,
  collapseCommand,
  commandLineCount,
  commandPatterns,
  guardTitleKey,
  permissionCommand,
  permissionWrites,
  secretFindings,
  showAlways,
} from "./session-dock-logic"

const COMMAND_LINE_HEIGHT = 20

function CommandBlock(props: { command: string; collapse: boolean }) {
  const language = useLanguage()
  // A command that must be read whole (floor and guard prompts) starts expanded and is never clamped.
  const [expanded, setExpanded] = createSignal(!props.collapse)
  const [overflow, setOverflow] = createSignal(props.collapse && commandLineCount(props.command) > COMMAND_MAX_LINES)
  let ref: HTMLPreElement | undefined

  const measure = () => {
    if (!ref || expanded() || !props.collapse) return
    setOverflow(ref.scrollHeight > ref.clientHeight + 1)
  }

  onMount(() => {
    measure()
    createResizeObserver(ref, measure)
  })

  return (
    <div class="flex flex-col items-start gap-1 min-w-0">
      <pre
        ref={ref}
        data-slot="permission-command"
        class="w-full m-0 font-mono text-text-base whitespace-pre-wrap break-all select-text"
        style={{
          "font-size": "13px",
          "line-height": `${COMMAND_LINE_HEIGHT}px`,
          "max-height": !props.collapse ? "none" : expanded() ? "40vh" : `${COMMAND_LINE_HEIGHT * COMMAND_MAX_LINES}px`,
          "overflow-y": !props.collapse ? "visible" : expanded() ? "auto" : "hidden",
        }}
      >
        {props.command}
      </pre>
      <Show when={overflow()}>
        <button
          type="button"
          class="text-12-regular text-text-weak hover:text-text-base transition-colors"
          aria-expanded={expanded()}
          onClick={() => setExpanded((value) => !value)}
        >
          {language.t(expanded() ? "ui.sessionTurn.diffs.showLess" : "ui.common.showMore")}
        </button>
      </Show>
    </div>
  )
}

export function SessionPermissionDock(props: {
  request: PermissionRequest
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void
}) {
  const language = useLanguage()

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.permission}.description`
    const value = language.t(key as Parameters<typeof language.t>[0])
    if (value === key) return ""
    return value
  }

  const guard = () => props.request.guard
  const title = () => {
    const key = guardTitleKey(props.request)
    return language.t(key ?? "notification.permission.title")
  }
  const command = createMemo(() => permissionCommand(props.request))
  const patterns = createMemo(() => commandPatterns(props.request, command()))
  const writes = createMemo(() => permissionWrites(props.request))
  const secrets = createMemo(() => secretFindings(props.request))
  const always = createMemo(() => alwaysLabel(props.request, language.t("ui.permission.always.everything")))
  const alwaysTitle = () => {
    const label = always()
    if (label.patterns.length > 0) return label.patterns.join("\n")
    return label.summary
  }

  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header" data-guard={guard()?.level}>
          <span data-slot="permission-icon">
            <Show when={guard()} fallback={<Icon name="warning" size="normal" />}>
              <Icon name="warning" size="normal" style={{ color: "var(--v2-state-fg-danger)" }} />
            </Show>
          </span>
          <div data-slot="permission-header-title">{title()}</div>
        </div>
      }
      footer={
        <>
          <div />
          <div data-slot="permission-footer-actions">
            <Button variant="ghost" size="normal" onClick={() => props.onDecide("reject")} disabled={props.responding}>
              {language.t("ui.permission.deny")}
            </Button>
            <Show when={showAlways(props.request)}>
              <Button
                variant="secondary"
                size="normal"
                title={alwaysTitle()}
                onClick={() => props.onDecide("always")}
                disabled={props.responding}
              >
                {language.t(always().key)}
              </Button>
            </Show>
            <Button variant="primary" size="normal" onClick={() => props.onDecide("once")} disabled={props.responding}>
              {language.t("ui.permission.allowOnce")}
            </Button>
          </div>
        </>
      }
    >
      <Show when={guard()}>
        {(item) => (
          <div data-slot="permission-row" data-variant="guard">
            <span data-slot="permission-spacer" aria-hidden="true" />
            <div class="flex flex-col gap-1 min-w-0">
              <div
                role="alert"
                class="text-14-regular break-words"
                style={{ color: "var(--v2-state-fg-danger)", "line-height": "var(--line-height-large)" }}
              >
                {item().reason}
              </div>
              <Show when={secrets().length > 0}>
                <div class="flex flex-col gap-0.5 min-w-0">
                  <For each={secrets()}>
                    {(finding) => <code class="font-mono text-12-regular text-text-base break-all">{finding}</code>}
                  </For>
                </div>
              </Show>
              <div data-slot="permission-hint">{language.t("ui.permission.guard.noAlways")}</div>
            </div>
          </div>
        )}
      </Show>

      <Show when={toolDescription()}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">{toolDescription()}</div>
        </div>
      </Show>

      <Show when={command()}>
        {(text) => (
          <div data-slot="permission-row">
            <span data-slot="permission-spacer" aria-hidden="true" />
            <CommandBlock command={text()} collapse={collapseCommand(props.request)} />
          </div>
        )}
      </Show>

      <Show when={patterns().length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-patterns">
            <For each={patterns()}>
              {(pattern) => <code class="text-12-regular text-text-base break-all">{pattern}</code>}
            </For>
          </div>
        </div>
      </Show>

      <Show when={command() && writes().length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint" class="break-all">
            {language.t("ui.permission.writes")}: {writes().join(", ")}
          </div>
        </div>
      </Show>

      <Show when={showAlways(props.request) && always().summary}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint" class="break-all">
            {language.t(always().key)}:{" "}
            <Show when={always().patterns.length > 0} fallback={always().summary}>
              <For each={always().patterns}>
                {(pattern, index) => (
                  <>
                    <Show when={index() > 0}>{", "}</Show>
                    <code class="font-mono text-text-base">{pattern}</code>
                  </>
                )}
              </For>
            </Show>
          </div>
        </div>
      </Show>
    </DockPrompt>
  )
}
