// Fold grouping for the Chat flow — a native port of the dsh-folded-chat
// plugin's folding contract (no overlay; the group is a real flow row):
//
// 1. A "process row" is a `tool-call` row, or an `assistant-step` row without
//    a visible body (no non-blank `text` block and no `image` block;
//    `reasoning`/`tool-call`/`other` blocks are not body — reasoning already
//    folds natively inside the row as the Think disclosure).
// 2. Scanning the ordered rows, every run of TWO OR MORE consecutive process
//    rows becomes one collapsible group; a lone process row renders as-is.
//    Any non-process row (user/steering/context/compaction/…) is a hard
//    boundary that ends the run.
// 3. A group defaults to expanded while any member row is still running,
//    otherwise it defaults to collapsed. Manual toggles are remembered per
//    group id by the view (the id is the first member's key — stable while
//    streaming appends grow the group) and are never rewritten by this rule.
// 4. The inner "tool call" disclosure of the dsh-folded-chat contract maps
//    onto the Tool card's own native disclosure; it is not re-done here.
//
// This module is a pure function over pre-computed row descriptors: the
// Node-payload reading (AssistantChatData.blocks/status, ToolChatData.root
// settled-ness) lives at the call site in ChatView.

/** Per-row fold inputs, derived from the rendered business Node. */
export interface FoldRowDescriptor {
  /** Stable Node key (the ChatNodeSeat key). */
  readonly key: string
  /** Renderer kind string (`tool-call`, `assistant-step`, `user`, …). */
  readonly kind: string
  /** Whether an `assistant-step` carries visible body (ignored for other kinds). */
  readonly hasVisibleBody: boolean
  /** Whether the row is still producing output (streaming step / unsettled call). */
  readonly running: boolean
}

/** One rendered flow item: either a plain row or a collapsed process group. */
export type ChatFlowItem =
  | { readonly type: 'row'; readonly key: string }
  | {
    readonly type: 'group'
    /** Group identity — the first member's key, stable as the group grows. */
    readonly id: string
    /** Member row keys in flow order. */
    readonly keys: readonly string[]
    /** Whether any member row is still running (drives the default state). */
    readonly running: boolean
  }

/**
 * Test whether one row is foldable process material.
 * @param row - per-row fold descriptor.
 * @returns whether the row may join a process group.
 */
export function isProcessRow(row: FoldRowDescriptor): boolean {
  if (row.kind === 'tool-call') return true
  return row.kind === 'assistant-step' && !row.hasVisibleBody
}

/**
 * Fold consecutive process rows into groups (dsh-folded-chat contract).
 * @param rows - ordered per-row descriptors of the rendered flow.
 * @returns flow items preserving row order; groups hold their member keys.
 */
export function groupChatFlow(rows: readonly FoldRowDescriptor[]): ChatFlowItem[] {
  const items: ChatFlowItem[] = []
  let run: FoldRowDescriptor[] = []
  const flush = (): void => {
    const head = run[0]
    if (run.length >= 2 && head !== undefined) {
      items.push({
        type: 'group',
        id: head.key,
        keys: run.map(row => row.key),
        running: run.some(row => row.running),
      })
    } else {
      for (const row of run) items.push({ type: 'row', key: row.key })
    }
    run = []
  }
  for (const row of rows) {
    if (isProcessRow(row)) {
      run.push(row)
    } else {
      flush()
      items.push({ type: 'row', key: row.key })
    }
  }
  flush()
  return items
}
