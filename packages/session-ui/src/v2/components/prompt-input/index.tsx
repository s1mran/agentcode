import { createEffect, createMemo, createSignal, For, onCleanup, Show, type Accessor, type JSX } from "solid-js"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { AttachmentCardV2 } from "../attachment-card-v2"
import { CommentCardV2 } from "../comment-card-v2"
import { typeLabel } from "../../../components/message-file"
import type {
  PromptInputV2Attachment,
  PromptInputV2Comment,
  PromptInputV2ModeControl,
  PromptInputV2ModeTone,
  PromptInputV2Option,
  PromptInputV2PersistedState,
  PromptInputV2Prompt,
  PromptInputV2Suggestion,
} from "./types"
import type { PromptInputV2Interaction, PromptInputV2SelectControl } from "./interaction"
import "./attachments.css"

export type {
  PromptInputV2Attachment,
  PromptInputV2Comment,
  PromptInputV2ModeControl,
  PromptInputV2ModeOption,
  PromptInputV2ModeTone,
  PromptInputV2Option,
  PromptInputV2PersistedState,
  PromptInputV2Suggestion,
} from "./types"

export type PromptInputV2Mode = "normal" | "shell"

export type PromptInputV2Props = {
  controller: PromptInputV2Interaction
  disabled?: boolean
  readOnly?: boolean
  borderUnderlay?: boolean
  class?: string
  modelControl?: JSX.Element
  variantControlVisible?: boolean
  attachKeybind?: string[]
  attachShortcut?: string
  /** Permission mode control, shown before the agent select. */
  modeControl?: PromptInputV2ModeControl
  /** Shift+Tab in the editor (no popover open, not composing) calls this to cycle the mode. */
  onCycleMode?: () => void
}

export function PromptInputV2(props: PromptInputV2Props) {
  const i18n = useI18n()
  const state = props.controller.state
  const view = props.controller.view
  let editor: HTMLDivElement | undefined
  let localInput = false
  // Text present before dictation started, so live partials can be rewritten
  // in place without eating what the user had already typed.
  let dictationBase: string | undefined
  const updateCursor = () => {
    if (!editor || !window.getSelection()?.isCollapsed) return
    props.controller.onCursor(promptInputV2Cursor(editor))
  }
  const mode = createMemo(() => state.mode)
  const buttons = createMemo(() => ({
    opacity: mode() === "normal" ? 1 : 0,
    "pointer-events": mode() === "normal" ? ("auto" as const) : ("none" as const),
    transition: "opacity 200ms ease",
  }))

  createEffect(() => {
    const parts = props.controller.parts()
    if (!editor) return
    if (localInput) {
      localInput = false
      return
    }
    renderPromptInputV2Editor(editor, parts)
  })

  return (
    <div class={`relative size-full flex flex-col gap-0 ${props.class ?? ""}`}>
      <input
        ref={props.controller.setFileInput}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,application/json,application/ld+json,application/toml,application/x-toml,application/x-yaml,application/xml,application/yaml,.c,.cc,.cjs,.conf,.cpp,.css,.csv,.cts,.env,.go,.gql,.graphql,.h,.hh,.hpp,.htm,.html,.ini,.java,.js,.json,.jsx,.log,.md,.mdx,.mjs,.mts,.py,.rb,.rs,.sass,.scss,.sh,.sql,.toml,.ts,.tsx,.txt,.xml,.yaml,.yml,.zsh"
        class="hidden"
        onChange={(event) => {
          const list = event.currentTarget.files
          if (list) props.controller.addAttachments(Array.from(list))
          event.currentTarget.value = ""
        }}
      />
      <Show when={state.popover.type !== "closed"}>
        <PromptInputV2Popover
          emptyLabel={i18n.t("ui.promptInput.noMatchingItems")}
          items={props.controller.suggestions()}
          activeID={props.controller.highlightedID()}
          search={
            state.popover.type === "command-menu"
              ? {
                  value: state.popover.query,
                  label: i18n.t("ui.promptInput.commands"),
                  placeholder: "/",
                  onValueChange: props.controller.setQuery,
                  onKeyDown: props.controller.onKeyDown,
                }
              : undefined
          }
          onActiveChange={(item) => props.controller.dispatch({ type: "popover.active", id: item.id })}
          onSelect={(item) => props.controller.dispatch({ type: "popover.select", item, via: "click" })}
        />
      </Show>
      <form
        data-component="prompt-input-v2"
        data-dock-border-underlay={props.borderUnderlay ? "v2" : undefined}
        class="group/prompt-input relative min-h-[96px] w-full overflow-clip rounded-xl bg-v2-background-bg-base"
        classList={{
          "shadow-[var(--v2-elevation-raised)]": !props.borderUnderlay,
          "border border-v2-icon-icon-info border-dashed": state.drag === "active",
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!props.disabled) props.controller.submit()
        }}
        onDragEnter={props.controller.onDragEnter}
        onDragOver={props.controller.onDragOver}
        onDragLeave={props.controller.onDragLeave}
        onDrop={props.controller.onDrop}
      >
        <Show when={state.drag === "active"}>
          <div class="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-xl bg-v2-background-bg-base/90 text-v2-text-text-base">
            {i18n.t("ui.promptInput.dropFiles")}
          </div>
        </Show>

        <Show when={state.mode === "normal"}>
          <PromptInputV2Attachments
            attachments={props.controller.attachments()}
            comments={props.controller.comments()}
            activeCommentID={state.activeContextID}
            removeLabel={i18n.t("ui.promptInput.removeAttachment")}
            onAttachmentClick={props.controller.openAttachment}
            onAttachmentRemove={(attachment) => props.controller.removeAttachment(attachment.id)}
            onCommentClick={(comment) => props.controller.toggleContext(comment.key)}
            onCommentRemove={(comment) => props.controller.removeContext(comment.key)}
          />
        </Show>

        <div class="relative min-h-[60px]">
          <div
            ref={(element) => {
              editor = element
              props.controller.setEditor(element)
              renderPromptInputV2Editor(element, props.controller.parts())
            }}
            data-component="prompt-input"
            role="textbox"
            aria-multiline="true"
            aria-label={i18n.t("ui.promptInput.label")}
            contenteditable={!props.disabled && !props.readOnly}
            autocapitalize={state.mode === "normal" ? "sentences" : "off"}
            autocorrect={state.mode === "normal" ? "on" : "off"}
            spellcheck={state.mode === "normal"}
            // @ts-expect-error
            autocomplete="off"
            class="relative z-10 block min-h-[60px] max-h-[180px] w-full overflow-y-auto whitespace-pre-wrap bg-transparent px-4 pt-4 pb-2 text-[13px] font-[440] leading-5 text-v2-text-text-base focus:outline-none empty:before:content-['\200B'] [&_[data-mention=file]]:text-syntax-property [&_[data-mention=agent]]:text-syntax-type [&_[data-mention=reference]]:text-syntax-keyword"
            classList={{ "font-mono!": state.mode === "shell", "opacity-50": props.disabled }}
            onInput={(event) => {
              const cursor = promptInputV2Cursor(event.currentTarget)
              const prompt = parsePromptInputV2Editor(event.currentTarget)
              const images = props.controller.parts().filter((part) => part.type === "image")
              localInput = true
              props.controller.onInput(prompt.map((part) => part.content).join(""), [...prompt, ...images], cursor)
            }}
            onKeyDown={(event) => {
              if (props.controller.onKeyDown(event)) return
              if (
                props.onCycleMode &&
                !props.modeControl?.disabled?.() &&
                event.key === "Tab" &&
                event.shiftKey &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.altKey &&
                !event.isComposing &&
                state.popover.type === "closed"
              ) {
                event.preventDefault()
                props.onCycleMode()
                return
              }
              if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                event.preventDefault()
                if (event.repeat) return
                props.controller.submit()
              }
            }}
            onKeyUp={updateCursor}
            onPointerUp={updateCursor}
            onPaste={props.controller.onPaste}
            onFocus={() => props.controller.dispatch({ type: "focus.editor" })}
          />
          <Show when={!props.controller.value()}>
            <div
              class="pointer-events-none absolute inset-x-0 top-0 px-4 pt-4 text-[13px] font-[440] leading-5 text-v2-text-text-faint"
              classList={{ "font-mono!": state.mode === "shell" }}
            >
              {view.placeholder?.() ??
                (state.mode === "shell"
                  ? i18n.t("ui.promptInput.placeholder.shell")
                  : i18n.t("ui.promptInput.placeholder.normal", { slash: "/", at: "@" }))}
            </div>
          </Show>
        </div>

        <div class="flex h-11 items-center px-2">
          <div
            class="flex min-w-0 flex-1 items-center gap-1"
            aria-hidden={state.mode === "shell"}
            inert={state.mode === "shell" ? true : undefined}
            style={buttons()}
          >
            <PromptInputV2AddMenu
              disabled={state.mode === "shell"}
              title={i18n.t("ui.promptInput.add")}
              keybind={props.attachKeybind ?? ["Mod", "U"]}
              attachLabel={i18n.t("ui.promptInput.attachments")}
              attachShortcut={props.attachShortcut ?? "Mod+U"}
              commandsLabel={i18n.t("ui.promptInput.commands")}
              contextLabel={i18n.t("ui.promptInput.context")}
              shellLabel={i18n.t("ui.promptInput.shell")}
              onAttach={props.controller.attach}
              onCommands={props.controller.openCommands}
              onContext={props.controller.openContext}
              onShell={props.controller.openShell}
            />
            <Show when={props.modeControl}>
              {(control) => <PromptInputV2ModeSelect title={i18n.t("ui.promptInput.chooseMode")} control={control()} />}
            </Show>
            <Show when={view.agent} keyed>
              {(control) => (
                <PromptInputV2ConfiguredSelect
                  title={i18n.t("ui.promptInput.chooseAgent")}
                  keybind={["Mod", "."]}
                  control={control}
                />
              )}
            </Show>
            <Show
              when={props.modelControl}
              fallback={
                <Show when={view.model} keyed>
                  {(control) => (
                    <PromptInputV2ConfiguredSelect
                      title={i18n.t("ui.promptInput.chooseModel")}
                      keybind={["Mod", "M"]}
                      control={control}
                      model
                    />
                  )}
                </Show>
              }
            >
              {props.modelControl}
            </Show>
            <Show when={(props.variantControlVisible ?? true) && view.variant} keyed>
              {(control) => (
                <Show when={control.options().length > 1}>
                  <PromptInputV2ConfiguredSelect
                    title={i18n.t("ui.promptInput.chooseVariant")}
                    keybind={["Shift", "Mod", "D"]}
                    control={control}
                  />
                </Show>
              )}
            </Show>
          </div>
          <PromptInputV2MicButton
            disabled={props.disabled || props.readOnly || state.mode === "shell"}
            onPartial={(text) => {
              if (!editor) return
              // Anything typed before recording began is kept; the live guess is
              // rewritten in place each pass rather than appended.
              if (dictationBase === undefined) dictationBase = editor.textContent ?? ""
              const joiner = dictationBase && !/\s$/.test(dictationBase) ? " " : ""
              editor.textContent = dictationBase + joiner + text
              const cursor = promptInputV2Cursor(editor)
              const prompt = parsePromptInputV2Editor(editor)
              const images = props.controller.parts().filter((part) => part.type === "image")
              localInput = true
              props.controller.onInput(prompt.map((part) => part.content).join(""), [...prompt, ...images], cursor)
            }}
            onText={(text) => {
              if (!editor) return
              // The final pass is authoritative — drop the provisional guess first.
              if (dictationBase !== undefined) {
                editor.textContent = dictationBase
                dictationBase = undefined
              }
              editor.focus()
              // Put the caret at the end, then insert the way a paste would so the
              // controller's input handling stays in sync.
              const selection = window.getSelection()
              const range = document.createRange()
              range.selectNodeContents(editor)
              range.collapse(false)
              selection?.removeAllRanges()
              selection?.addRange(range)
              const existing = editor.textContent ?? ""
              const value = existing && !/\s$/.test(existing) ? ` ${text}` : text
              if (!(typeof document.execCommand === "function" && document.execCommand("insertText", false, value))) {
                editor.textContent = existing + value
              }
              // The controller drives canSubmit(), and it only learns about text
              // through its own onInput. Without this the words are visible but
              // the send button stays disabled and Enter does nothing.
              const cursor = promptInputV2Cursor(editor)
              const prompt = parsePromptInputV2Editor(editor)
              const images = props.controller.parts().filter((part) => part.type === "image")
              localInput = true
              props.controller.onInput(prompt.map((part) => part.content).join(""), [...prompt, ...images], cursor)
            }}
          />
          <PromptInputV2SubmitButton
            mode={state.mode}
            stopping={view.submit.stopping()}
            disabled={!props.controller.canSubmit()}
            sendLabel={i18n.t("ui.promptInput.send")}
            stopLabel={i18n.t("ui.promptInput.stop")}
            onSubmit={props.controller.submit}
            onStop={props.controller.stop}
          />
        </div>
      </form>
    </div>
  )
}

function renderPromptInputV2Editor(editor: HTMLDivElement, prompt: PromptInputV2Prompt) {
  const active = document.activeElement === editor
  editor.replaceChildren(
    ...prompt.flatMap<Node>((part) => {
      if (part.type === "image") return []
      if (part.type === "text") return [document.createTextNode(part.content)]
      const mention = document.createElement("span")
      mention.textContent = part.content
      mention.contentEditable = "false"
      mention.dataset.mention =
        part.type === "file" && part.mime === "application/x-directory" ? "reference" : part.type
      if (part.type === "agent") mention.dataset.name = part.name
      if (part.type === "file") {
        mention.dataset.path = part.path
        if (part.mime) mention.dataset.mime = part.mime
        if (part.filename) mention.dataset.filename = part.filename
      }
      return [mention]
    }),
  )
  if (!active) return
  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(editor)
  range.collapse(false)
  selection?.removeAllRanges()
  selection?.addRange(range)
}

function parsePromptInputV2Editor(editor: HTMLDivElement) {
  const parts: Exclude<PromptInputV2Prompt[number], PromptInputV2Attachment>[] = []
  let buffer = ""
  let position = 0

  const flush = () => {
    if (!buffer) return
    parts.push({ type: "text", content: buffer, start: position, end: position + buffer.length })
    position += buffer.length
    buffer = ""
  }
  const mention = (element: HTMLElement) => {
    flush()
    const content = element.textContent ?? ""
    if (element.dataset.mention === "agent") {
      parts.push({
        type: "agent",
        name: element.dataset.name ?? content.slice(1),
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
      return
    }
    parts.push({
      type: "file",
      path: element.dataset.path ?? content.slice(1),
      content,
      start: position,
      end: position + content.length,
      ...(element.dataset.mime ? { mime: element.dataset.mime } : {}),
      ...(element.dataset.filename ? { filename: element.dataset.filename } : {}),
    })
    position += content.length
  }
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      buffer += node.textContent ?? ""
      return
    }
    if (!(node instanceof HTMLElement)) return
    if (node.dataset.mention) {
      mention(node)
      return
    }
    if (node.tagName === "BR") {
      buffer += "\n"
      return
    }
    Array.from(node.childNodes).forEach(visit)
  }

  Array.from(editor.childNodes).forEach((node, index, nodes) => {
    visit(node)
    if (node instanceof HTMLElement && ["DIV", "P"].includes(node.tagName) && index < nodes.length - 1) buffer += "\n"
  })
  flush()
  if (
    parts.every((part) => part.type === "text") &&
    parts.every((part) => part.content.replace(/[\n\u200B]/g, "") === "")
  ) {
    return [{ type: "text" as const, content: "", start: 0, end: 0 }]
  }
  if (parts.length > 0) return parts
  return [{ type: "text" as const, content: "", start: 0, end: 0 }]
}

function promptInputV2Cursor(editor: HTMLDivElement) {
  const selection = window.getSelection()
  if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) return editor.textContent?.length ?? 0
  const range = selection.getRangeAt(0).cloneRange()
  range.selectNodeContents(editor)
  range.setEnd(selection.anchorNode!, selection.anchorOffset)
  return range.toString().length
}

export function PromptInputV2Attachments(props: {
  attachments: PromptInputV2Attachment[]
  comments?: PromptInputV2Comment[]
  activeCommentID?: string
  removeLabel: string
  onAttachmentClick?: (attachment: PromptInputV2Attachment) => void
  onAttachmentRemove: (attachment: PromptInputV2Attachment) => void
  onCommentClick?: (comment: PromptInputV2Comment) => void
  onCommentRemove?: (comment: PromptInputV2Comment) => void
}) {
  const i18n = useI18n()
  return (
    <Show when={props.attachments.length > 0 || (props.comments?.length ?? 0) > 0}>
      <div data-component="prompt-input-v2-attachments" data-slot="prompt-attachments" class="relative">
        <div
          data-slot="prompt-attachments-scroll"
          class="flex flex-nowrap gap-2 overflow-x-auto no-scrollbar px-2 pt-2 pb-1"
        >
          <For each={props.comments ?? []}>
            {(comment) => (
              <div class="relative group shrink-0">
                <TooltipV2
                  value={comment.comment}
                  placement="top"
                  openDelay={800}
                  contentClass="max-w-[300px] break-words"
                >
                  <CommentCardV2
                    comment={comment.comment ?? ""}
                    path={comment.path}
                    selection={comment.selection}
                    active={comment.key === props.activeCommentID}
                    onClick={() => props.onCommentClick?.(comment)}
                  />
                </TooltipV2>
                <button
                  type="button"
                  onClick={() => props.onCommentRemove?.(comment)}
                  class="absolute -top-1 -end-1 size-4 rounded-full bg-v2-icon-icon-muted outline-solid outline-1 outline-v2-icon-icon-contrast flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label={props.removeLabel}
                >
                  <IconV2 name="outline-xmark" class="text-v2-icon-icon-contrast" />
                </button>
              </div>
            )}
          </For>
          <For each={props.attachments}>
            {(attachment) => (
              <div class="relative group shrink-0">
                <TooltipV2 value={attachment.filename} placement="top" contentClass="break-all">
                  <Show
                    when={attachment.mime.startsWith("image/")}
                    fallback={
                      <AttachmentCardV2 title={attachment.filename}>
                        {typeLabel(attachment.filename, attachment.mime, i18n.t("ui.common.file"))}
                      </AttachmentCardV2>
                    }
                  >
                    <img
                      src={attachment.blob.url}
                      alt={attachment.filename}
                      class="w-[58px] h-[46px] rounded-[6px] object-cover"
                      onClick={() => props.onAttachmentClick?.(attachment)}
                    />
                    <div class="absolute inset-0 rounded-[6px] shadow-[inset_0_0_0_0.5px_var(--v2-border-border-base)] pointer-events-none" />
                  </Show>
                </TooltipV2>
                <button
                  type="button"
                  onClick={() => props.onAttachmentRemove(attachment)}
                  class="absolute -top-1 -end-1 size-4 rounded-full bg-v2-icon-icon-muted outline-solid outline-1 outline-v2-icon-icon-contrast flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label={props.removeLabel}
                >
                  <IconV2 name="outline-xmark" class="text-v2-icon-icon-contrast" />
                </button>
              </div>
            )}
          </For>
        </div>
        <div
          data-slot="prompt-attachments-fade-left"
          class="pointer-events-none absolute inset-y-0 start-0 z-10 w-6 bg-[linear-gradient(to_right,var(--v2-background-bg-base),transparent)] rtl:bg-[linear-gradient(to_left,var(--v2-background-bg-base),transparent)]"
        />
        <div
          data-slot="prompt-attachments-fade-right"
          class="pointer-events-none absolute inset-y-0 end-0 z-10 w-6 bg-[linear-gradient(to_left,var(--v2-background-bg-base),transparent)] rtl:bg-[linear-gradient(to_right,var(--v2-background-bg-base),transparent)]"
        />
      </div>
    </Show>
  )
}

export function PromptInputV2AddMenu(props: {
  disabled?: boolean
  title: string
  keybind?: string[]
  attachLabel: string
  attachShortcut?: string
  commandsLabel: string
  contextLabel: string
  shellLabel: string
  onAttach: () => void
  onCommands: () => void
  onContext: () => void
  onShell: () => void
}) {
  return (
    <TooltipV2
      placement="top"
      value={
        <>
          {props.title}
          <KeybindV2 keys={props.keybind ?? []} variant="neutral" />
        </>
      }
    >
      <MenuV2 gutter={6} modal={false} placement="top-start">
        <MenuV2.Trigger
          as={IconButtonV2}
          data-action="prompt-attach"
          type="button"
          icon={<IconV2 name="plus" />}
          variant="ghost-muted"
          size="large"
          disabled={props.disabled}
          aria-label={props.title}
        />
        <MenuV2.Portal>
          <MenuV2.Content style={{ "min-width": "180px" }}>
            <MenuV2.Item onSelect={props.onAttach} shortcut={props.attachShortcut}>
              {props.attachLabel}
            </MenuV2.Item>
            <MenuV2.Separator />
            <MenuV2.Item onSelect={props.onCommands} shortcut="/">
              {props.commandsLabel}
            </MenuV2.Item>
            <MenuV2.Item onSelect={props.onContext} shortcut="@">
              {props.contextLabel}
            </MenuV2.Item>
            <MenuV2.Item onSelect={props.onShell} shortcut="!">
              {props.shellLabel}
            </MenuV2.Item>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </TooltipV2>
  )
}

function PromptInputV2ConfiguredSelect(props: {
  title: string
  keybind?: string[]
  control: PromptInputV2SelectControl
  model?: boolean
}) {
  const current = () => props.control.current()
  const providerID = () => props.control.options().find((option) => option.id === current())?.providerID
  return (
    <PromptInputV2Select
      title={props.title}
      keybind={props.control.keybind?.() ?? props.keybind}
      options={props.control.options()}
      current={current()}
      currentIcon={
        <Show when={props.model && providerID()}>
          <ProviderIcon id={providerID()!} class="size-4 shrink-0 opacity-60" />
        </Show>
      }
      onSelect={props.control.onSelect}
    />
  )
}

const MODE_TONE_CLASS: Record<PromptInputV2ModeTone, string> = {
  neutral: "bg-icon-weak-base",
  success: "bg-icon-success-base",
  info: "bg-icon-info-base",
  critical: "bg-icon-critical-base",
  warning: "bg-icon-warning-base",
}

function PromptInputV2ModeSelect(props: { title: string; control: PromptInputV2ModeControl }) {
  const current = () => props.control.options().find((option) => option.id === props.control.current())
  return (
    <TooltipV2
      placement="top"
      value={
        <>
          {props.title}
          <KeybindV2 keys={props.control.keybind()} variant="neutral" />
        </>
      }
    >
      <MenuV2 gutter={6} modal={false} placement="top-start">
        <MenuV2.Trigger
          as={ButtonV2}
          variant="ghost-muted"
          size="normal"
          class="max-w-[220px] justify-start ![font-weight:440]"
          aria-label={props.title}
          data-action="prompt-permission-mode"
          data-mode={props.control.current()}
          disabled={props.control.disabled?.()}
        >
          <span class={`size-1.5 shrink-0 rounded-full ${MODE_TONE_CLASS[current()?.tone ?? "neutral"]}`} />
          <span class="truncate leading-5">{current()?.label ?? props.control.current()}</span>
          <span class="-ms-0.5 -me-1 flex shrink-0">
            <IconV2 name="chevron-down" />
          </span>
        </MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content>
            <MenuV2.RadioGroup value={props.control.current()} onChange={props.control.onSelect}>
              <For each={props.control.options()}>
                {(option) => (
                  <MenuV2.RadioItem value={option.id} closeOnSelect>
                    <span class="flex items-start gap-2 max-w-[280px]">
                      <span class={`mt-1.5 size-1.5 shrink-0 rounded-full ${MODE_TONE_CLASS[option.tone]}`} />
                      <span class="flex min-w-0 flex-col">
                        <span>{option.label}</span>
                        <Show when={option.description}>
                          <span class="whitespace-normal text-v2-text-text-faint">{option.description}</span>
                        </Show>
                      </span>
                    </span>
                  </MenuV2.RadioItem>
                )}
              </For>
            </MenuV2.RadioGroup>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </TooltipV2>
  )
}

export function PromptInputV2Select(props: {
  title: string
  keybind?: string[]
  options: PromptInputV2Option[]
  current: string
  currentIcon?: JSX.Element
  class?: string
  onOpenChange?: (open: boolean) => void
  onSelect: (id: string) => void
}) {
  return (
    <TooltipV2
      placement="top"
      value={
        <>
          {props.title}
          <KeybindV2 keys={props.keybind ?? []} variant="neutral" />
        </>
      }
    >
      <MenuV2 gutter={6} modal={false} placement="top-start" onOpenChange={props.onOpenChange}>
        <MenuV2.Trigger
          as={ButtonV2}
          variant="ghost-muted"
          size="normal"
          class={`max-w-[220px] justify-start ![font-weight:440] ${props.class ?? ""}`}
          aria-label={props.title}
        >
          {props.currentIcon}
          <span class="truncate capitalize leading-5">
            {props.options.find((option) => option.id === props.current)?.label ?? props.current}
          </span>
          <span class="-ms-0.5 -me-1 flex shrink-0">
            <IconV2 name="chevron-down" />
          </span>
        </MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content>
            <MenuV2.RadioGroup value={props.current} onChange={props.onSelect}>
              <For each={props.options}>
                {(option) => (
                  <MenuV2.RadioItem value={option.id} class="capitalize" closeOnSelect>
                    {option.label}
                  </MenuV2.RadioItem>
                )}
              </For>
            </MenuV2.RadioGroup>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </TooltipV2>
  )
}

export function PromptInputV2Popover(props: {
  emptyLabel: string
  items: PromptInputV2Suggestion[]
  activeID?: string
  search?: {
    value: string
    label: string
    placeholder: string
    onValueChange: (value: string) => void
    onKeyDown: (event: KeyboardEvent) => void
  }
  onActiveChange: (item: PromptInputV2Suggestion) => void
  onSelect: (item: PromptInputV2Suggestion) => void
}) {
  return (
    <div
      class="absolute inset-x-0 -top-2 z-40 flex max-h-80 -translate-y-full flex-col overflow-auto rounded-xl bg-v2-background-bg-base p-2 shadow-[var(--v2-elevation-raised)] no-scrollbar"
      onMouseDown={(event) => event.preventDefault()}
    >
      <Show when={props.search}>
        {(search) => (
          <div class="px-2 py-1">
            <input
              ref={(element) => requestAnimationFrame(() => element.focus())}
              value={search().value}
              aria-label={search().label}
              placeholder={search().placeholder}
              class="w-full bg-transparent text-[13px] leading-5 text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
              onInput={(event) => search().onValueChange(event.currentTarget.value)}
              onKeyDown={(event) => search().onKeyDown(event)}
              onMouseDown={(event) => event.stopPropagation()}
            />
          </div>
        )}
      </Show>
      <Show
        when={props.items.length > 0}
        fallback={<div class="px-2 py-1 text-v2-text-text-muted">{props.emptyLabel}</div>}
      >
        <For each={props.items}>
          {(item) => (
            <button
              type="button"
              data-suggestion-id={item.id}
              class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-start hover:bg-v2-overlay-simple-overlay-hover"
              classList={{ "bg-v2-overlay-simple-overlay-hover": props.activeID === item.id }}
              onPointerMove={(event) => {
                // Hover counts as an explicit pick for Enter, so ignore moves the pointer did not make.
                if (event.movementX === 0 && event.movementY === 0) return
                props.onActiveChange(item)
              }}
              onClick={() => props.onSelect(item)}
            >
              <div class="flex min-w-0 flex-1 items-center gap-2">
                <PromptInputV2SuggestionIcon item={item} />
                <span class="shrink-0 text-v2-text-text-base">{item.label}</span>
                <Show when={item.hint}>
                  <span class="shrink-0 whitespace-nowrap text-v2-text-text-faint">{item.hint}</span>
                </Show>
                <Show when={item.description}>
                  <span class="min-w-0 truncate text-v2-text-text-muted">{item.description}</span>
                </Show>
              </div>
              <Show when={item.badge}>
                <Tag>{item.badge}</Tag>
              </Show>
              <Show when={item.keybind?.length}>
                <span class="shrink-0 text-v2-text-text-muted">{item.keybind?.join("+")}</span>
              </Show>
            </button>
          )}
        </For>
      </Show>
    </div>
  )
}

/**
 * Push-to-talk. Click to record, click again to stop; the clip is transcribed by
 * local whisper behind the AgentCode gateway and dropped into the prompt.
 * Endpoint is overridable so a deployed gateway can serve it later.
 */
const TRANSCRIBE_URL =
  (globalThis as { AGENTCODE_TRANSCRIBE_URL?: string }).AGENTCODE_TRANSCRIBE_URL ??
  "http://127.0.0.1:8399/v1/audio/transcriptions"

const MIC_BARS = 14

// How often the in-progress audio is re-transcribed so words show up while you
// are still talking. Whisper re-reads the whole clip each pass, which keeps the
// text accurate across word boundaries at the cost of a little repeated work.
const MIC_PARTIAL_MS = 1200

export function PromptInputV2MicButton(props: {
  disabled?: boolean
  onText: (text: string) => void
  onPartial?: (text: string) => void
}) {
  const [status, setStatus] = createSignal<"idle" | "recording" | "working">("idle")
  const [error, setError] = createSignal<string | undefined>()
  // Live mic amplitude per bar, 0..1 — this is what makes it visibly "listening"
  // rather than a button that silently maybe-works.
  const [levels, setLevels] = createSignal<number[]>(new Array(MIC_BARS).fill(0))
  const [seconds, setSeconds] = createSignal(0)

  let recorder: MediaRecorder | undefined
  let chunks: Blob[] = []
  let audioCtx: AudioContext | undefined
  let raf: number | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let partialTimer: ReturnType<typeof setInterval> | undefined
  let partialBusy = false

  /**
   * Transcribe what has been captured so far. `fast` picks a smaller model —
   * used for live partials, where keeping up matters more than exactness.
   */
  const transcribe = async (blob: Blob, fast = false) => {
    const form = new FormData()
    form.append("file", blob, "speech.webm")
    const res = await fetch(fast ? `${TRANSCRIBE_URL}?fast=1` : TRANSCRIBE_URL, { method: "POST", body: form })
    if (!res.ok) throw new Error(`Transcriber returned ${res.status}`)
    return ((await res.json()) as { text?: string }).text?.trim() ?? ""
  }

  const startPartials = () => {
    if (!props.onPartial) return
    partialTimer = setInterval(async () => {
      // Skip a tick rather than queue: whisper is slower than the interval on
      // longer clips, and piling requests up would only make the text lag more.
      if (partialBusy || !chunks.length) return
      partialBusy = true
      try {
        const text = await transcribe(new Blob(chunks, { type: chunks[0]?.type || "audio/webm" }), true)
        if (text && recorder) props.onPartial?.(text)
      } catch {
        // a failed partial is not worth surfacing; the final pass still runs
      } finally {
        partialBusy = false
      }
    }, MIC_PARTIAL_MS)
  }

  const teardownMeter = () => {
    if (raf !== undefined) cancelAnimationFrame(raf)
    raf = undefined
    if (timer) clearInterval(timer)
    timer = undefined
    if (partialTimer) clearInterval(partialTimer)
    partialTimer = undefined
    void audioCtx?.close().catch(() => {})
    audioCtx = undefined
    setLevels(new Array(MIC_BARS).fill(0))
    setSeconds(0)
  }

  const startMeter = (stream: MediaStream) => {
    const Ctx: typeof AudioContext =
      (window as unknown as { AudioContext: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
        .AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    audioCtx = new Ctx()
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0.75
    audioCtx.createMediaStreamSource(stream).connect(analyser)
    const buf = new Uint8Array(analyser.frequencyBinCount)

    const tick = () => {
      analyser.getByteTimeDomainData(buf)
      let peak = 0
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i] - 128) / 128
        if (v > peak) peak = v
      }
      // scoot the history left and push the newest sample on the right
      setLevels((prev) => [...prev.slice(1), Math.min(1, peak * 2.2)])
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    timer = setInterval(() => setSeconds((s) => s + 1), 1000)
  }

  const stop = () => {
    recorder?.stop()
    recorder?.stream.getTracks().forEach((t) => t.stop())
    recorder = undefined
    teardownMeter()
  }

  onCleanup(() => {
    try {
      stop()
    } catch {}
  })

  const start = async () => {
    setError(undefined)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      chunks = []
      recorder = new MediaRecorder(stream)
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: chunks[0]?.type || "audio/webm" })
        if (!blob.size) return setStatus("idle")
        setStatus("working")
        try {
          const text = await transcribe(blob)
          if (text) props.onText(text)
          else setError("Nothing heard — try speaking closer to the mic.")
        } catch (e) {
          // A dead gateway shows up here as a generic network failure, which tells
          // the user nothing. Name the actual cause instead.
          const offline = e instanceof TypeError || /fetch|network|load failed/i.test(String(e))
          setError(
            offline
              ? "Can't reach the transcriber. Is the AgentCode gateway running on port 8399?"
              : e instanceof Error
                ? e.message
                : "Transcription failed.",
          )
        } finally {
          setStatus("idle")
        }
      }
      // A timeslice is required: without it ondataavailable only fires at stop,
      // so there would be nothing to transcribe while the user is still talking.
      recorder.start(1000)
      startMeter(stream)
      startPartials()
      setStatus("recording")
    } catch {
      setError("Microphone unavailable — check macOS mic permission for AgentCode.")
      setStatus("idle")
    }
  }

  // Surface failures where they can actually be read. A tooltip only appears on
  // hover, so a silent mic looked identical to a broken one.
  createEffect(() => {
    if (!error()) return
    const id = setTimeout(() => setError(undefined), 6000)
    onCleanup(() => clearTimeout(id))
  })

  const mmss = () => {
    const s = seconds()
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
  }

  // While recording the button is replaced by a live meter you can click to stop.
  const Meter = () => (
    <button
      type="button"
      data-action="prompt-mic-stop"
      aria-label="Stop recording and transcribe"
      onClick={() => stop()}
      class="flex h-7 items-center gap-2 rounded-full border border-v2-border-border-base px-2.5 text-v2-text-text-base"
    >
      <span class="relative flex size-2 shrink-0">
        <span class="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-70" />
        <span class="relative inline-flex size-2 rounded-full bg-red-500" />
      </span>
      <span class="flex h-4 items-end gap-[2px]" aria-hidden="true">
        <For each={levels()}>
          {(level) => (
            <span
              class="w-[2px] rounded-full bg-current transition-[height] duration-75"
              style={{ height: `${Math.max(2, Math.round(level * 16))}px`, opacity: 0.35 + level * 0.65 }}
            />
          )}
        </For>
      </span>
      <span class="tabular-nums text-[11px] opacity-70">{mmss()}</span>
    </button>
  )

  return (
    <>
      <Show when={error()}>
        {(message) => (
          <div
            role="status"
            class="pointer-events-none absolute -top-7 right-2 z-20 max-w-[420px] truncate rounded-md bg-v2-background-bg-base px-2 py-1 text-[11px] text-v2-text-text-danger shadow-[var(--v2-elevation-raised)]"
          >
            {message()}
          </div>
        )}
      </Show>
      <Show when={status() !== "recording"} fallback={<Meter />}>
        <TooltipV2 value="Dictate">
          <IconButtonV2
            type="button"
            data-action="prompt-mic"
            variant="ghost-muted"
            size="normal"
            disabled={props.disabled || status() === "working"}
            aria-label="Dictate"
            style={{ height: "28px" }}
            onClick={() => void start()}
          >
            <Show
              when={status() !== "working"}
              fallback={
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5" opacity="0.25" />
                  <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                    <animateTransform
                      attributeName="transform"
                      type="rotate"
                      from="0 8 8"
                      to="360 8 8"
                      dur="0.8s"
                      repeatCount="indefinite"
                    />
                  </path>
                </svg>
              }
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="6" y="2" width="4" height="7" rx="2" fill="currentColor" />
                <path
                  d="M4 7.5a4 4 0 0 0 8 0M8 11.5V14M6 14h4"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linecap="round"
                />
              </svg>
            </Show>
          </IconButtonV2>
        </TooltipV2>
      </Show>
    </>
  )
}

/**
 * Elapsed seconds while the agent is working, the way Claude Code shows them.
 * Without it a long turn is indistinguishable from a hung one.
 */
function ElapsedTimer(props: { active: boolean }) {
  const [seconds, setSeconds] = createSignal(0)
  let timer: ReturnType<typeof setInterval> | undefined
  let startedAt = 0

  createEffect(() => {
    if (props.active) {
      startedAt = Date.now()
      setSeconds(0)
      timer = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    } else {
      if (timer) clearInterval(timer)
      timer = undefined
      setSeconds(0)
    }
  })
  onCleanup(() => timer && clearInterval(timer))

  const label = () => {
    const s = seconds()
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`
  }

  return (
    <Show when={props.active && seconds() > 0}>
      <span
        data-component="prompt-elapsed"
        class="mr-2 tabular-nums text-[11px] text-v2-text-text-muted"
        aria-live="off"
      >
        {label()}
      </span>
    </Show>
  )
}

export function PromptInputV2SubmitButton(props: {
  mode: PromptInputV2Mode
  stopping: boolean
  disabled: boolean
  sendLabel: string
  stopLabel: string
  onSubmit: () => void
  onStop: () => void
}) {
  return (
    <>
      <ElapsedTimer active={props.stopping} />
      <TooltipV2
        placement="top"
        inactive={!props.stopping && props.disabled}
        value={props.stopping ? props.stopLabel : props.sendLabel}
      >
        <IconButton
          data-action="prompt-submit"
          type="button"
          disabled={!props.stopping && props.disabled}
          tabIndex={props.mode === "normal" ? undefined : -1}
          icon={props.stopping ? "stop" : props.mode === "shell" ? "arrow-undo-down" : "arrow-up"}
          variant="primary"
          class="size-7 rounded-md p-[6px] text-v2-icon-icon-muted shadow-[var(--v2-elevation-button-contrast)] disabled:opacity-50"
          style={{
            "background-image":
              "linear-gradient(180deg,var(--v2-alpha-light-20) 0%,var(--v2-alpha-light-0) 100%),linear-gradient(90deg,var(--v2-background-bg-contrast) 0%,var(--v2-background-bg-contrast) 100%)",
          }}
          aria-label={props.stopping ? props.stopLabel : props.sendLabel}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            if (props.stopping) {
              props.onStop()
              return
            }
            props.onSubmit()
          }}
        />
      </TooltipV2>
    </>
  )
}

function PromptInputV2SuggestionIcon(props: { item: PromptInputV2Suggestion }) {
  if (props.item.kind === "agent") return <Icon name="brain" size="small" class="shrink-0 text-icon-info-active" />
  if (props.item.kind === "command") return null
  return (
    <FileIcon
      node={{ path: props.item.path ?? props.item.label, type: props.item.kind === "reference" ? "directory" : "file" }}
      class="size-4 shrink-0"
    />
  )
}
