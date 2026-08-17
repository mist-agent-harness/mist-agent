// @vitest-environment jsdom
// ChatView process folding (dsh-folded-chat contract): group derivation over
// the rendered flow, the running/settled default state, and manual-choice
// priority under streaming updates — driven through a scripted
// ObservableSnapshot fake, no wire or Tool presentation plugin.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import type {
  AssistantMessageNode, ConversationSnapshot, RunningToolCall, SessionId, SessionListState,
  ToolResultNode, UserMessageNode, WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { createSnapshotStore, EMPTY_CONVERSATION_VIEWS } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ChatNode, ChatNodeOwnerProps, ChatViewSlotProps, SelectionTarget,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { createChatStore } from '../src/client/stores.ts'
import { ChatView } from '../src/client/chat/ChatView.tsx'
import type { AssistantChatData, ToolChatData } from '../src/client/contract/chat-nodes.ts'
import { zh } from '../src/client/locales.ts'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
beforeEach(() => {
  localStorage.clear()
})

const SID = 's1' as SessionId
type RoutedChatNodeOwner = ChatNodeOwnerProps & { readonly node: ChatNode }

function snapshotBase(): ConversationSnapshot {
  return {
    sessionId: SID, views: EMPTY_CONVERSATION_VIEWS, chat: chatSnapshotFixture(), nodes: [],
    turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [],
    pending: [], queue: [], running: false, composerPhase: 'active', removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, blank: false, subagent: null, lastAgentError: null,
  }
}

/** Scripted snapshot source: set() swaps the top-level object like the real Session. */
function makeSource(init?: Partial<ConversationSnapshot>) {
  const initial = { ...snapshotBase(), ...init }
  let snap: ConversationSnapshot = {
    ...initial,
    chat: init?.chat ?? chatSnapshotFixture(initial),
  }
  const subs = new Set<() => void>()
  return {
    set: (next: Partial<ConversationSnapshot>) => {
      const merged = { ...snap, ...next }
      snap = {
        ...merged,
        chat: Object.hasOwn(next, 'chat') && next.chat !== undefined
          ? next.chat
          : chatSnapshotFixture(merged, snap.chat),
      }
      for (const fn of [...subs]) fn()
    },
    source: {
      getSnapshot: () => snap,
      subscribe: (fn: () => void) => {
        subs.add(fn)
        return () => subs.delete(fn)
      },
    },
  }
}

const user = (seq: number, text: string): UserMessageNode => ({
  kind: 'user',
  seq,
  time: seq * 1000,
  content: [{ type: 'text', text }] as never,
  source: null,
})
const assistant = (seq: number, text: string, turn = 1): AssistantMessageNode => ({
  kind: 'assistant', seq, time: seq * 1_000, turn, step: 1, blocks: [{ kind: 'text', text }],
})
/** Reasoning-only step: no visible body, so the fold contract reads it as process. */
const think = (seq: number, turn = 1): AssistantMessageNode => ({
  kind: 'assistant', seq, time: seq * 1_000, turn, step: seq, blocks: [{ kind: 'reasoning', text: 'hmm' }],
})
const toolResult = (seq: number, callId: string, name = 'bash'): ToolResultNode => ({
  kind: 'tool-result', seq, time: seq * 1_000, callId,
  call: { name, argsRaw: `{"command":"cmd-${callId}","description":"run ${callId}"}` },
  callTime: seq * 1_000 - 500,
  content: [], isError: false, callView: null, resultView: null, subCalls: [],
})
const runningCall = (callId: string, name = 'bash'): RunningToolCall => ({
  callId, name, argsRaw: `{"command":"cmd-${callId}"}`, turn: 2, step: 1, time: 1_000, callView: null, subCalls: [],
})
/** Interrupted reasoning-only step: status 'interrupted' (not running), still bodiless. */
const interruptedThink = (seq: number, turn = 1): AssistantMessageNode => ({ ...think(seq, turn), interrupted: true })
/** Terminal shape of an interrupted call (the tool projection's error result). */
const interruptedResult = (seq: number, callId: string): ToolResultNode => ({
  ...toolResult(seq, callId),
  isError: true,
  error: { name: 'Interrupted', code: 'interrupted' },
})

/** Empty sessions-list hook for the global standard-kit seat. */
function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined })
  return bindSnapshotSelector(store)
}

function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceListState>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  })
  return bindSnapshotSelector(store)
}

function makeHarness(init?: Partial<ConversationSnapshot>) {
  const { set, source } = makeSource(init)
  const openFile = vi.fn<(path: string) => void>()
  const loadOlder = vi.fn()
  const inspectCall = vi.fn<(callId: string) => void>()
  let savedScroll: ReturnType<ChatViewSlotProps['chatScroll']['read']> = null
  const chatScroll: ChatViewSlotProps['chatScroll'] = {
    save: (position) => { savedScroll = position },
    read: () => savedScroll,
  }
  const forkAt = vi.fn()
  const chat = createChatStore().create()
  const t = makeTranslate(zh, commonZh)
  // Minimal business-row stand-ins: the fold logic reads Node payloads, so a
  // plain marker per kind is faithful enough (no Tool presentation plugin).
  const renderSlot = ((key: string, owner: object, opts?: {
    fallback?: React.ReactNode
  }) => {
    if (key !== 'conversation.chat.node') return opts?.fallback ?? null
    const nodeOwner = owner as RoutedChatNodeOwner
    switch (nodeOwner.node.kind) {
      case 'user':
      case 'steering': {
        const data = nodeOwner.node.data as UserMessageNode
        return <div>{data.content.map(block => (block as { text: string }).text).join('')}</div>
      }
      case 'assistant-step': {
        const data: AssistantChatData = nodeOwner.node.data
        return <div>{data.blocks.filter(block => block.kind === 'text').map(block => block.kind === 'text' ? block.text : '').join('')}</div>
      }
      case 'tool-call': {
        const data: ToolChatData = nodeOwner.node.data
        return <div data-testid={`tool-seat-${data.root.callId}`} />
      }
      default:
        return opts?.fallback ?? null
    }
  }) as unknown as ChatViewSlotProps['renderSlot']
  const SessionProviderStub: ChatViewSlotProps['SessionProvider'] = ({ children }) => <>{children(SID)}</>
  const props: ChatViewSlotProps = {
    sessionId: SID,
    useSession: bindSnapshotSelector(source),
    useSessions: emptySessions(),
    useWorkspaces: emptyWorkspaces(),
    useProjection: (() => undefined),
    useInput: (() => { throw new Error('unused') }),
    inputActions: {
      setDraft: () => {},
      addImages: () => true,
      removeImage: () => {},
      pruneImages: () => {},
      submit: () => {},
    },
    useStore: bindSnapshotSelector(chat),
    actions: chat.actions,
    renderSlot,
    SessionProvider: SessionProviderStub,
    openDetails: vi.fn<(t: SelectionTarget) => void>(),
    openFile,
    loadOlder,
    loadImage: vi.fn(() => Promise.reject(new Error('not used'))),
    inspectCall,
    chatScroll,
    forkAt,
    fileMentions: () => undefined,
    t,
  }
  return { set, ChatView, props }
}

/** Current fold-group body element (re-queried after every snapshot set). */
function foldBody(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-chat-fold-body]') as HTMLElement
}

describe('ChatView process folding (dsh-folded-chat contract)', () => {
  it('folds consecutive settled tool rows into a collapsed Process group without reordering the flow', () => {
    const h = makeHarness({
      nodes: [user(1, 'do it'), toolResult(2, 'a'), toolResult(3, 'b'), assistant(4, 'done')],
    })
    const view = render(<h.ChatView {...h.props} />)
    const group = view.container.querySelector('[data-chat-fold-group]') as HTMLElement
    expect(group).not.toBeNull()
    expect(group.dataset.state).toBe('ok')
    // The header is a direct column citizen and owns no flow anchor.
    expect(group.parentElement?.hasAttribute('data-chat-flow')).toBe(true)
    expect(within(group).getByText('过程').closest('[data-chat-anchor-key]')).toBeNull()
    expect(within(group).getByText('2 步')).toBeTruthy()
    // Settled default: collapsed, yet the member seats stay mounted.
    expect(foldBody(view.container).hasAttribute('hidden')).toBe(true)
    expect(view.getByTestId('tool-seat-a')).toBeTruthy()
    expect(view.getByTestId('tool-seat-b')).toBeTruthy()
    // Grouping changes nesting, never order; body rows stay outside the group.
    expect([...view.container.querySelectorAll('[data-chat-flow-kind]')].map(row => row.getAttribute('data-chat-flow-kind')))
      .toEqual(['user', 'tool-call', 'tool-call', 'assistant-step'])
    expect(view.getByText('do it').closest('[data-chat-fold-group]')).toBeNull()
    expect(view.getByText('done').closest('[data-chat-fold-group]')).toBeNull()
  })

  it('expands a group by default while any member row is still running', () => {
    const h = makeHarness({ runningCalls: [runningCall('r1'), runningCall('r2')], running: true })
    const view = render(<h.ChatView {...h.props} />)
    const group = view.container.querySelector('[data-chat-fold-group]') as HTMLElement
    expect(group.dataset.state).toBe('running')
    expect(foldBody(view.container).hasAttribute('hidden')).toBe(false)
    expect(view.getByTestId('tool-seat-r1')).toBeTruthy()
    expect(view.getByTestId('tool-seat-r2')).toBeTruthy()
  })

  it('keeps a lone process row between body rows unfolded', () => {
    const h = makeHarness({
      nodes: [user(1, 'q'), toolResult(2, 'a'), assistant(3, 'answer')],
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.container.querySelector('[data-chat-fold-group]')).toBeNull()
    expect(view.getByTestId('tool-seat-a')).toBeTruthy()
  })

  it('reads a reasoning-only assistant step as process and a text step as a hard boundary', () => {
    const h = makeHarness({
      nodes: [think(2), toolResult(3, 'a'), think(4)],
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.container.querySelectorAll('[data-chat-fold-group]')).toHaveLength(1)
    expect(within(view.container.querySelector('[data-chat-fold-group]') as HTMLElement).getByText('3 步')).toBeTruthy()

    act(() => {
      h.set({ nodes: [toolResult(2, 'a'), assistant(3, 'narration'), toolResult(4, 'b')] })
    })
    expect(view.container.querySelector('[data-chat-fold-group]')).toBeNull()
  })

  it('keeps the reader\'s manual choice across streaming growth and settling', () => {
    const h = makeHarness({ runningCalls: [runningCall('r1'), runningCall('r2')], running: true })
    const view = render(<h.ChatView {...h.props} />)
    // Running default: expanded. The reader collapses it.
    expect(foldBody(view.container).hasAttribute('hidden')).toBe(false)
    fireEvent.click(view.getByText('过程'))
    expect(foldBody(view.container).hasAttribute('hidden')).toBe(true)

    // Streaming grows the group (same leading key); the manual choice holds.
    act(() => { h.set({ runningCalls: [runningCall('r1'), runningCall('r2'), runningCall('r3')] }) })
    expect(foldBody(view.container).hasAttribute('hidden')).toBe(true)
    expect(view.getByText('3 步')).toBeTruthy()

    // Settling would auto-collapse an untouched group; it must not rewrite a
    // manual collapse either.
    act(() => {
      h.set({
        nodes: [toolResult(2, 'r1'), toolResult(3, 'r2'), toolResult(4, 'r3')],
        runningCalls: [],
        running: false,
      })
    })
    expect(foldBody(view.container).hasAttribute('hidden')).toBe(true)

    // A manual expand likewise survives later flow updates.
    fireEvent.click(view.getByText('过程'))
    expect(foldBody(view.container).hasAttribute('hidden')).toBe(false)
    act(() => {
      h.set({ nodes: [toolResult(2, 'r1'), toolResult(3, 'r2'), toolResult(4, 'r3'), toolResult(5, 'r4')] })
    })
    expect(foldBody(view.container).hasAttribute('hidden')).toBe(false)
    expect(view.getByText('4 步')).toBeTruthy()
  })

  it('auto-collapses an untouched group once its members settle, keeping seats mounted', () => {
    const h = makeHarness({ runningCalls: [runningCall('r1'), runningCall('r2')], running: true })
    const view = render(<h.ChatView {...h.props} />)
    const seat = view.getByTestId('tool-seat-r1')
    expect(foldBody(view.container).hasAttribute('hidden')).toBe(false)

    act(() => {
      h.set({ nodes: [toolResult(2, 'r1'), toolResult(3, 'r2')], runningCalls: [], running: false })
    })
    const group = view.container.querySelector('[data-chat-fold-group]') as HTMLElement
    expect(group.dataset.state).toBe('ok')
    expect(foldBody(view.container).hasAttribute('hidden')).toBe(true)
    // Folded means hidden, never remounted.
    expect(view.getByTestId('tool-seat-r1')).toBe(seat)
  })

  it('keeps rendered body text alive when a tool row lands between body steps', () => {
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, '第一段正文')] })
    const view = render(<h.ChatView {...h.props} />)
    const firstBody = view.getByText('第一段正文')

    // The tool card arrives after the body step is already on screen.
    act(() => { h.set({ nodes: [user(1, 'q'), assistant(2, '第一段正文'), toolResult(3, 'a')] }) })
    expect(view.getByText('第一段正文')).toBe(firstBody)
    expect(view.getByTestId('tool-seat-a')).toBeTruthy()
    // A lone tool row between body steps never folds.
    expect(view.container.querySelector('[data-chat-fold-group]')).toBeNull()

    // Body resumes after the tool: both texts stay put, still no group.
    act(() => {
      h.set({ nodes: [user(1, 'q'), assistant(2, '第一段正文'), toolResult(3, 'a'), assistant(4, '第二段正文')] })
    })
    expect(view.getByText('第一段正文')).toBe(firstBody)
    expect(view.getByText('第二段正文')).toBeTruthy()
    expect(view.getByTestId('tool-seat-a')).toBeTruthy()
    expect(view.container.querySelector('[data-chat-fold-group]')).toBeNull()
  })

  it('collapses an untouched running group to a settled end state on interruption', () => {
    const h = makeHarness({
      runningCalls: [runningCall('r1')],
      partial: { turn: 2, step: 1, blocks: [{ kind: 'reasoning', text: 'hmm' }] },
      running: true,
    })
    const view = render(<h.ChatView {...h.props} />)
    const runningGroup = view.container.querySelector('[data-chat-fold-group]') as HTMLElement
    expect(runningGroup.dataset.state).toBe('running')
    expect(foldBody(view.container).hasAttribute('hidden')).toBe(false)

    // Both members terminate: the step is interrupted, the call errors out.
    act(() => {
      h.set({
        nodes: [interruptedThink(2, 2), interruptedResult(3, 'r1')],
        partial: null,
        runningCalls: [],
        running: false,
      })
    })
    const group = view.container.querySelector('[data-chat-fold-group]') as HTMLElement
    expect(group.dataset.state).toBe('ok')
    expect(foldBody(view.container).hasAttribute('hidden')).toBe(true)
    // No running marker survives the transition; members stay mounted.
    expect(within(group).queryByText('运行中')).toBeNull()
    expect(view.getByTestId('tool-seat-r1')).toBeTruthy()
  })

  it('keeps a manually expanded group open after its members interrupt', () => {
    const h = makeHarness({ nodes: [toolResult(2, 'a'), toolResult(3, 'b')] })
    const view = render(<h.ChatView {...h.props} />)
    // Settled default: collapsed. The reader expands it.
    expect(foldBody(view.container).hasAttribute('hidden')).toBe(true)
    fireEvent.click(view.getByText('过程'))
    expect(foldBody(view.container).hasAttribute('hidden')).toBe(false)

    // The group grows a running member (the same leading key carries the override).
    act(() => {
      h.set({
        nodes: [toolResult(2, 'a'), toolResult(3, 'b')],
        runningCalls: [runningCall('r3')],
        running: true,
      })
    })
    expect(foldBody(view.container).hasAttribute('hidden')).toBe(false)

    // The new member interrupts: the auto rule would collapse an untouched
    // group, but the reader's manual expand wins.
    act(() => {
      h.set({
        nodes: [toolResult(2, 'a'), toolResult(3, 'b'), interruptedResult(4, 'r3')],
        runningCalls: [],
        running: false,
      })
    })
    const group = view.container.querySelector('[data-chat-fold-group]') as HTMLElement
    expect(group.dataset.state).toBe('ok')
    expect(foldBody(view.container).hasAttribute('hidden')).toBe(false)
    expect(view.getByText('3 步')).toBeTruthy()
  })

  it('isolates same-turn think+tool groups across a body boundary', () => {
    const h = makeHarness({
      nodes: [think(2), toolResult(3, 'a'), assistant(4, '中间正文'), think(5), toolResult(6, 'b')],
    })
    const view = render(<h.ChatView {...h.props} />)
    const groups = view.container.querySelectorAll('[data-chat-fold-group]')
    expect(groups).toHaveLength(2)
    const groupA = groups[0] as HTMLElement
    const groupB = groups[1] as HTMLElement
    // Each group folds exactly its own two rows; the body step stays outside.
    expect(within(groupA).getByText('2 步')).toBeTruthy()
    expect(within(groupB).getByText('2 步')).toBeTruthy()
    expect(within(groupA).getByTestId('tool-seat-a')).toBeTruthy()
    expect(within(groupB).getByTestId('tool-seat-b')).toBeTruthy()
    expect(within(groupA).queryByTestId('tool-seat-b')).toBeNull()
    expect(view.getByText('中间正文').closest('[data-chat-fold-group]')).toBeNull()

    // Toggling one group never rewrites the other (independent ids/overrides).
    expect(foldBody(groupA).hasAttribute('hidden')).toBe(true)
    fireEvent.click(within(groupA).getByText('过程'))
    expect(foldBody(groupA).hasAttribute('hidden')).toBe(false)
    expect(foldBody(groupB).hasAttribute('hidden')).toBe(true)
  })
})
