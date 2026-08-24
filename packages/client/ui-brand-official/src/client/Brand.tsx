import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import css from './Brand.module.css'

type OfficialBrandMarkProps = HeroBrandMarkOwnerProps & SidebarBrandMarkOwnerProps

/**
 * Render the official mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the official whale mark.
 */
export function OfficialBrandMark({ size, className }: OfficialBrandMarkProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      height={size}
      viewBox="0 0 32 32"
      width={size}
    >
      <path className={css.markFrame} d="M16 2.5 28 9.25v13.5L16 29.5 4 22.75V9.25Z" />
      <path className={css.markTrace} d="M9 21V11l7 7 7-7v10" />
      <circle className={css.markNode} cx="16" cy="18" r="1.6" />
    </svg>
  )
}

/**
 * Render the official name artwork without its independently slotted mark.
 * @returns the official name wordmark.
 */
export function OfficialBrandName() {
  return <span className={css.wordmark}>MYTHOS</span>
}
