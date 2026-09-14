import { type ComponentProps } from "solid-js"

/**
 * AgentCode mark — a terminal window holding a `>_` prompt. Geometry is kept
 * chunky on purpose so it survives a 16px favicon and a Dock icon equally well.
 */
export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect
        data-slot="logo-mark-frame"
        x="0.9"
        y="1.9"
        width="14.2"
        height="16.2"
        rx="3.4"
        stroke="var(--icon-strong-base)"
        stroke-width="1.8"
      />
      <path
        data-slot="logo-mark-caret"
        d="M4.9 7.1 L7.7 10 L4.9 12.9"
        stroke="var(--icon-strong-base)"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <rect
        data-slot="logo-mark-cursor"
        x="8.9"
        y="11.3"
        width="3.3"
        height="1.7"
        rx="0.85"
        fill="var(--icon-weak-base)"
      />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="4.5" y="9.5" width="71" height="81" rx="17" stroke="var(--icon-strong-base)" stroke-width="9" />
      <path
        d="M24.5 35.5 L38.5 50 L24.5 64.5"
        stroke="var(--icon-strong-base)"
        stroke-width="9"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <rect x="44.5" y="56.5" width="16.5" height="8.5" rx="4.25" fill="var(--icon-base)" />
    </svg>
  )
}

/** Mark plus wordmark, for headers and the about screen. */
export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 234 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <rect x="1.4" y="6.4" width="27.2" height="29.2" rx="6.4" stroke="var(--icon-strong-base)" stroke-width="2.8" />
      <path
        d="M9.4 15.6 L15 21 L9.4 26.4"
        stroke="var(--icon-strong-base)"
        stroke-width="2.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <rect x="17.4" y="24.2" width="6.4" height="3" rx="1.5" fill="var(--icon-weak-base)" />
      <text
        x="42"
        y="21"
        dominant-baseline="central"
        font-family="ui-sans-serif, -apple-system, 'SF Pro Text', system-ui, sans-serif"
        font-size="25"
        font-weight="650"
        letter-spacing="-0.4"
        fill="var(--icon-strong-base)"
      >
        AgentCode
      </text>
    </svg>
  )
}
