import { createUniqueId, type ComponentProps } from "solid-js"

/**
 * The faded AgentCode wordmark behind the new-session prompt: the `>_` terminal
 * mark next to the name, dissolving toward the bottom via the same mask the
 * upstream wordmark used.
 */
export function WordmarkV2(props: Pick<ComponentProps<"svg">, "class">) {
  const mask = createUniqueId()
  const maskGradient = createUniqueId()

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 720 129"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g opacity="0.6">
        <g mask={`url(#${mask})`}>
          <g opacity="0.16">
            <rect
              x="94"
              y="22"
              width="80"
              height="86"
              rx="19"
              stroke="currentColor"
              stroke-width="9"
              opacity="0.7"
            />
            <path
              d="M117 48 L133 65 L117 82"
              stroke="currentColor"
              stroke-width="9"
              stroke-linecap="round"
              stroke-linejoin="round"
              opacity="0.7"
            />
            <rect x="140" y="72" width="18" height="9" rx="4.5" fill="currentColor" opacity="0.7" />
            <text
              x="196"
              y="65"
              dominant-baseline="central"
              font-family="ui-sans-serif, -apple-system, 'SF Pro Display', system-ui, sans-serif"
              font-size="82"
              font-weight="650"
              letter-spacing="-1"
              opacity="0.7"
              fill="currentColor"
            >
              AgentCode
            </text>
          </g>
        </g>
      </g>
      <defs>
        <mask id={mask} style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="720" height="129">
          <rect width="720" height="129" fill={`url(#${maskGradient})`} />
        </mask>
        <linearGradient id={maskGradient} x1="360" y1="68" x2="360" y2="129" gradientUnits="userSpaceOnUse">
          <stop stop-color="white" stop-opacity="0.7" />
          <stop offset="1" stop-color="white" stop-opacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}
