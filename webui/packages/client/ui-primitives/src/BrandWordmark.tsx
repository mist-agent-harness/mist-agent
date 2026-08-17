// mist wordmark — neutral placeholder skin for the mist webui fork
// (replaces the upstream whale + letterforms + HARNESS badge; same 182x24
// canvas and component interface, so call sites render unchanged). Cloud
// mark on the left, "mist" set in the system UI face as a stand-in until
// real brand art lands. Ink rides currentColor.

import type { IconProps } from './icons/props.ts'

/**
 * Render the mist wordmark.
 * @param props.size - height in px (default 24; width keeps the 182:24 ratio).
 * @param props.className - extra class for layout placement.
 * @returns the wordmark svg (aria-hidden decorative brand art).
 */
export function BrandWordmark({ size = 24, className }: IconProps) {
  return (
    <svg
      width={(size * 182) / 24}
      height={size}
      className={className}
      viewBox="0 0 182 24"
      fill="none"
      aria-hidden="true"
    >
      <g fill="currentColor" transform="translate(0.14 3.52)">
        <circle cx="6.8" cy="10" r="4.5" />
        <circle cx="12.5" cy="8" r="5.5" />
        <circle cx="17.5" cy="11" r="3.5" />
        <rect x="2.3" y="11.5" width="18.7" height="3" rx="1.5" />
      </g>
      <text
        x="29"
        y="17"
        font-family="system-ui, -apple-system, sans-serif"
        font-size="14"
        font-weight="600"
        letter-spacing="1"
        fill="currentColor"
      >
        mist
      </text>
    </svg>
  )
}
