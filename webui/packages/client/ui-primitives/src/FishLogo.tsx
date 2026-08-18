// mist cloud mark — neutral placeholder skin for the mist webui fork
// (replaces the upstream DeepSeek fish; same 23.16x17.04 canvas and
// component interface, so call sites render unchanged). Rendered 24x18 by
// default; hero usage scales to 34x25. Color rides currentColor.

import type { IconProps } from './icons/props.ts'

/**
 * Render the mist cloud mark.
 * @param props.size - width in px (default 24; height keeps the 23.16:17.04 ratio).
 * @param props.className - extra class for layout placement.
 * @returns the logo svg (aria-hidden; pair with the wordmark for accessibility).
 */
export function FishLogo({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={(size * 17.04) / 23.16}
      className={className}
      viewBox="0 0 23.16 17.04"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2.3 10 a4.5 4.5 0 1 0 9 0 a4.5 4.5 0 1 0 -9 0 Z M7 8 a5.5 5.5 0 1 0 11 0 a5.5 5.5 0 1 0 -11 0 Z M14 11 a3.5 3.5 0 1 0 7 0 a3.5 3.5 0 1 0 -7 0 Z M3.8 11.5 H19.5 A1.5 1.5 0 0 1 21 13 A1.5 1.5 0 0 1 19.5 14.5 H3.8 A1.5 1.5 0 0 1 2.3 13 A1.5 1.5 0 0 1 3.8 11.5 Z"
        fill="currentColor"
      />
    </svg>
  )
}
