// Fold grouping semantics (dsh-folded-chat contract): process-row detection,
// ≥2-run grouping, hard boundaries, running propagation.

import { describe, expect, it } from 'vitest'
import { groupChatFlow, isProcessRow } from '../src/client/chat/fold-groups.ts'
import type { FoldRowDescriptor } from '../src/client/chat/fold-groups.ts'

/** Descriptor shorthand: kind drives the process test; body/running refine it. */
function row(key: string, kind: string, over: Partial<FoldRowDescriptor> = {}): FoldRowDescriptor {
  return { key, kind, hasVisibleBody: true, running: false, ...over }
}

const tool = (key: string, running = false): FoldRowDescriptor =>
  row(key, 'tool-call', { hasVisibleBody: false, running })
/** Assistant step without visible body (reasoning/tool-call/other blocks only). */
const thinkStep = (key: string, running = false): FoldRowDescriptor =>
  row(key, 'assistant-step', { hasVisibleBody: false, running })
const textStep = (key: string, running = false): FoldRowDescriptor =>
  row(key, 'assistant-step', { running })
const user = (key: string): FoldRowDescriptor => row(key, 'user')

describe('isProcessRow', () => {
  it('folds tool calls and bodiless assistant steps only', () => {
    expect(isProcessRow(tool('t1'))).toBe(true)
    expect(isProcessRow(thinkStep('a1'))).toBe(true)
    expect(isProcessRow(textStep('a2'))).toBe(false)
    expect(isProcessRow(user('u1'))).toBe(false)
    expect(isProcessRow(row('c1', 'compaction'))).toBe(false)
    expect(isProcessRow(row('s1', 'steering'))).toBe(false)
    expect(isProcessRow(row('x1', 'unknown'))).toBe(false)
  })
})

describe('groupChatFlow', () => {
  it('returns nothing for empty input', () => {
    expect(groupChatFlow([])).toEqual([])
  })

  it('passes non-process rows through untouched', () => {
    expect(groupChatFlow([user('u1'), textStep('a1'), row('c1', 'context')])).toEqual([
      { type: 'row', key: 'u1' },
      { type: 'row', key: 'a1' },
      { type: 'row', key: 'c1' },
    ])
  })

  it('keeps a lone process row unfolded', () => {
    expect(groupChatFlow([user('u1'), tool('t1'), textStep('a1')])).toEqual([
      { type: 'row', key: 'u1' },
      { type: 'row', key: 't1' },
      { type: 'row', key: 'a1' },
    ])
  })

  it('folds a run of two or more consecutive process rows into one group', () => {
    expect(groupChatFlow([user('u1'), tool('t1'), thinkStep('a1'), tool('t2'), textStep('a2')])).toEqual([
      { type: 'row', key: 'u1' },
      { type: 'group', id: 't1', keys: ['t1', 'a1', 't2'], running: false },
      { type: 'row', key: 'a2' },
    ])
  })

  it('treats any non-process row as a hard boundary between runs', () => {
    expect(groupChatFlow([tool('t1'), tool('t2'), textStep('a1'), tool('t3'), tool('t4')])).toEqual([
      { type: 'group', id: 't1', keys: ['t1', 't2'], running: false },
      { type: 'row', key: 'a1' },
      { type: 'group', id: 't3', keys: ['t3', 't4'], running: false },
    ])
  })

  it('does not merge runs across a lone unfolded process row boundary case', () => {
    // tool / text / tool: each tool row is a lone run and stays a plain row.
    expect(groupChatFlow([tool('t1'), textStep('a1'), tool('t2')])).toEqual([
      { type: 'row', key: 't1' },
      { type: 'row', key: 'a1' },
      { type: 'row', key: 't2' },
    ])
  })

  it('folds an all-process input into a single group', () => {
    expect(groupChatFlow([tool('t1'), thinkStep('a1'), tool('t2'), thinkStep('a2')])).toEqual([
      { type: 'group', id: 't1', keys: ['t1', 'a1', 't2', 'a2'], running: false },
    ])
  })

  it('marks a group running when any member row is running', () => {
    expect(groupChatFlow([tool('t1'), tool('t2', true), thinkStep('a1')])).toEqual([
      { type: 'group', id: 't1', keys: ['t1', 't2', 'a1'], running: true },
    ])
    expect(groupChatFlow([thinkStep('a1', true), tool('t1')])).toEqual([
      { type: 'group', id: 'a1', keys: ['a1', 't1'], running: true },
    ])
  })

  it('treats an assistant step with visible body as a boundary even while running', () => {
    expect(groupChatFlow([tool('t1'), textStep('a1', true), tool('t2')])).toEqual([
      { type: 'row', key: 't1' },
      { type: 'row', key: 'a1' },
      { type: 'row', key: 't2' },
    ])
  })

  it('anchors the group id on the first member so streaming growth keeps identity', () => {
    const grown = groupChatFlow([tool('t1'), tool('t2'), tool('t3')])
    const initial = groupChatFlow([tool('t1'), tool('t2')])
    expect(grown).toEqual([{ type: 'group', id: 't1', keys: ['t1', 't2', 't3'], running: false }])
    expect(initial[0]).toMatchObject({ type: 'group', id: 't1' })
  })

  it('splits same-turn think+tool runs into two independent groups at a body boundary', () => {
    expect(groupChatFlow([thinkStep('t1'), tool('c1'), textStep('a1'), thinkStep('t2'), tool('c2')])).toEqual([
      { type: 'group', id: 't1', keys: ['t1', 'c1'], running: false },
      { type: 'row', key: 'a1' },
      { type: 'group', id: 't2', keys: ['t2', 'c2'], running: false },
    ])
  })

  it('does not leak the running flag across a body boundary', () => {
    expect(groupChatFlow([tool('c1', true), thinkStep('t1'), textStep('a1'), tool('c2'), tool('c3')])).toEqual([
      { type: 'group', id: 'c1', keys: ['c1', 't1'], running: true },
      { type: 'row', key: 'a1' },
      { type: 'group', id: 'c2', keys: ['c2', 'c3'], running: false },
    ])
  })
})
