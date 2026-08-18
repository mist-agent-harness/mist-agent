/** Collapsed "Process" group: one disclosure header owning a run of folded
 * process rows (tool calls and bodiless assistant steps), per the
 * dsh-folded-chat contract ported in fold-groups.ts. The inner "tool call"
 * disclosure of that contract stays with each Tool card's own native
 * disclosure — this row only folds the group, never a single call. */
import type { ReactNode } from 'react'
import { DisclosureRow, IconApiOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import a11yCss from './accessibility.module.css'
import css from './FoldGroupRow.module.css'

/**
 * Render one process-fold group header and its (visibility-toggled) members.
 * @param props.count - number of folded rows.
 * @param props.running - whether any member is still running (status chrome).
 * @param props.open - controlled disclosure state (manual choice or rule default).
 * @param props.onToggle - reader toggle; the view records it as a manual choice.
 * @param props.t - conversation locale seat.
 * @param props.children - the grouped ChatNodeSeat list. Members stay mounted
 *   while collapsed (hidden, not unmounted) so Tool card state, scroll
 *   anchoring and per-key seat subscriptions survive a fold.
 * @returns the fold group row.
 */
export function FoldGroupRow({ count, running, open, onToggle, t, children }: {
  readonly count: number
  readonly running: boolean
  readonly open: boolean
  readonly onToggle: () => void
  readonly t: ChatViewSlotProps['t']
  readonly children: ReactNode
}) {
  return (
    <div className={css.root} data-chat-fold-group="" data-state={running ? 'running' : 'ok'}>
      {running && <span className={a11yCss.visuallyHidden}>{t('row.running')}</span>}
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={<IconApiOutline14 size={14} />}
        title={t('chat.process')}
        open={open}
        expandable
        expandOnRowClick
        onToggle={onToggle}
        keepContentWhenOpen
        collapsedContent={(
          <>
            <span className={css.separator} aria-hidden />
            <span className={css.count}>{t('chat.process.count', { n: count })}</span>
          </>
        )}
      />
      <div className={css.body} data-chat-fold-body="" hidden={!open}>
        {children}
      </div>
    </div>
  )
}
