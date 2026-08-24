import type { HistoryEntry } from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  sessionCreateValueSchema,
  sessionHistoryValueSchema,
  sessionListValueSchema,
} from '@deepseek-ai/dsh-host-apiproxy/api/sessions.schema'
import { afterEach, describe, expect, it } from 'vitest'
import type { DevServer } from '../src/server.ts'
import { createDevServer } from '../src/server.ts'
import {
  MistSessionWireAdapter,
  type MistViewportRegistry,
  type MistViewportSnapshot,
  type MistWindowHistoryPage,
  type MistWindowHistoryPort,
  type MistWindowHistoryRef,
  type MistWindowHistorySummary,
} from '../src/mist-session-wire-adapter.ts'

interface RpcEnvelope {
  result?: { ok: boolean; value?: unknown; error?: { code?: string; details?: unknown } }
}

class MemoryWindowHistory implements MistWindowHistoryPort {
  readonly summaries = new Map<string, MistWindowHistorySummary>()
  readonly pages = new Map<string, MistWindowHistoryPage>()
  readonly reads: Array<{ window: MistWindowHistoryRef; page: { beforeSeq?: number; maxMessages?: number } }> = []

  summarize(window: MistWindowHistoryRef): Promise<MistWindowHistorySummary> {
    return Promise.resolve(
      this.summaries.get(window.windowId) ?? { updatedAt: 0, running: false, blank: true },
    )
  }

  read(
    window: MistWindowHistoryRef,
    page: { beforeSeq?: number; maxMessages?: number },
  ): Promise<MistWindowHistoryPage> {
    this.reads.push({ window, page })
    return Promise.resolve(this.pages.get(window.windowId) ?? { events: [], hasMore: false })
  }
}

interface MemoryViewport extends MistViewportSnapshot {
  context: null
}

class MemoryViewportRegistry implements MistViewportRegistry<null> {
  readonly #active = new Map<string, MemoryViewport>()
  readonly #archived = new Map<string, MistViewportSnapshot>()
  openCalls = 0
  #sequence = 0

  windowsOf(residentId: string): MemoryViewport[] {
    return [...this.#active.values()].filter(window => window.residentId === residentId)
  }

  archivedWindowsOf(residentId: string): MistViewportSnapshot[] {
    return [...this.#archived.values()].filter(window => window.residentId === residentId)
  }

  open(
    residentId: string,
    options: { scopeId?: string; context: null },
  ): MemoryViewport {
    this.openCalls += 1
    this.#sequence += 1
    const window: MemoryViewport = {
      residentId,
      windowId: `w_test_${this.#sequence.toString().padStart(6, '0')}`,
      scopeId: options.scopeId ?? 'private',
      generation: 1,
      headId: null,
      context: options.context,
    }
    this.#active.set(window.windowId, window)
    return window
  }

  get(windowId: string): MemoryViewport | undefined {
    return this.#active.get(windowId)
  }

  getArchived(windowId: string): MistViewportSnapshot | undefined {
    return this.#archived.get(windowId)
  }

  setHead(windowId: string, headId: string): void {
    const window = this.#active.get(windowId)
    if (window === undefined) throw new Error(`no active window ${windowId}`)
    window.headId = headId
  }

  kill(windowId: string): MistViewportSnapshot | undefined {
    const window = this.#active.get(windowId)
    if (window === undefined) return this.#archived.get(windowId)
    this.#active.delete(windowId)
    this.#archived.set(windowId, window)
    return window
  }
}

let server: DevServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

function event(seq: number, time: number): HistoryEntry {
  return {
    event: {
      type: 'turn/start',
      seq,
      time,
      data: { turn: 1 },
    },
  }
}

async function post(base: string, method: string, payload: unknown): Promise<RpcEnvelope> {
  const response = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
  })
  expect(response.status).toBe(200)
  return await response.json() as RpcEnvelope
}

async function start(
  sessions: MemoryViewportRegistry,
  history: MemoryWindowHistory,
): Promise<string> {
  const handler = new MistSessionWireAdapter({
    residentId: 'resident-a',
    sessions,
    history,
    createContext: () => null,
  })
  server = createDevServer({ handler })
  const address = await server.listen(0)
  return `http://127.0.0.1:${address.port}`
}

function valueOf(envelope: RpcEnvelope): unknown {
  expect(envelope.result?.ok).toBe(true)
  return envelope.result?.value
}

describe('Mist multi-viewport session wire adapter', () => {
  it('maps create to host-minted windows and list to active plus archived windows', async () => {
    const sessions = new MemoryViewportRegistry()
    const history = new MemoryWindowHistory()
    const otherResident = sessions.open('resident-b', { context: null })
    sessions.kill(otherResident.windowId)
    const base = await start(sessions, history)

    const first = sessionCreateValueSchema.parse(valueOf(await post(base, 'session.create', {
      scopeId: 'room-1',
    })))
    const second = sessionCreateValueSchema.parse(valueOf(await post(base, 'session.create', {
      scopeId: 'room-1',
    })))
    expect(first.sessionId).not.toBe(second.sessionId)
    expect([first.generation, second.generation]).toEqual([1, 1])
    expect(sessions.windowsOf('resident-a').map(window => window.scopeId)).toEqual([
      'room-1', 'room-1',
    ])

    history.summaries.set(first.sessionId, { updatedAt: 10, running: true, blank: false })
    history.summaries.set(second.sessionId, { updatedAt: 20, running: true, blank: true })
    sessions.kill(first.sessionId)

    const listed = sessionListValueSchema.parse(valueOf(await post(base, 'session.list', {})))
    expect(listed.items).toEqual([
      expect.objectContaining({
        sessionId: second.sessionId,
        scopeId: 'room-1',
        generation: 1,
        archived: false,
        updatedAt: 20,
        running: true,
        blank: true,
      }),
      expect.objectContaining({
        sessionId: first.sessionId,
        scopeId: 'room-1',
        generation: 1,
        archived: true,
        updatedAt: 10,
        running: false,
        blank: false,
      }),
    ])
    expect(JSON.stringify(listed)).not.toContain('resident-a')
    const listedItems = Array.isArray(listed.items) ? listed.items : []
    expect(listedItems.some(item => String(item.sessionId) === otherResident.windowId)).toBe(false)
  })

  it('reads an archived window through the read-only history port without reviving it', async () => {
    const sessions = new MemoryViewportRegistry()
    const history = new MemoryWindowHistory()
    const window = sessions.open('resident-a', { scopeId: 'room-2', context: null })
    sessions.setHead(window.windowId, 'node-final')
    sessions.kill(window.windowId)
    const archivedEvents = [event(0, 100)]
    history.pages.set(window.windowId, { events: archivedEvents, hasMore: true })
    const base = await start(sessions, history)

    const page = sessionHistoryValueSchema.parse(valueOf(await post(base, 'session.history', {
      sessionId: window.windowId,
      beforeSeq: 4,
      maxMessages: 2,
    })))
    expect(page).toEqual({ events: archivedEvents, hasMore: true })
    expect(history.reads).toEqual([{
      window: {
        residentId: 'resident-a',
        windowId: window.windowId,
        headId: 'node-final',
        archived: true,
      },
      page: { beforeSeq: 4, maxMessages: 2 },
    }])
    expect(sessions.get(window.windowId)).toBeUndefined()
    expect(sessions.getArchived(window.windowId)).toBeDefined()
  })

  it('rejects unsupported create parameters and combinations before opening a window', async () => {
    const sessions = new MemoryViewportRegistry()
    const history = new MemoryWindowHistory()
    const base = await start(sessions, history)
    const cases: Array<{
      payload: Record<string, string>
      issues: Array<{ path: unknown[]; message: string }>
    }> = [
      {
        payload: { workspaceId: 'workspace-1' },
        issues: [{ path: ['workspaceId'], message: 'Mist session.create does not support workspaceId' }],
      },
      {
        payload: { cwd: '/requested' },
        issues: [{ path: ['cwd'], message: 'Mist session.create does not support cwd' }],
      },
      {
        payload: { agentPreset: 'requested-preset' },
        issues: [{ path: ['agentPreset'], message: 'Mist session.create does not support agentPreset' }],
      },
      {
        payload: { sessionId: 'caller-picked' },
        issues: [{
          path: ['sessionId'],
          message: 'Mist window ids are host-generated and cannot be preallocated',
        }],
      },
      {
        payload: {
          workspaceId: 'workspace-1',
          agentPreset: 'requested-preset',
          sessionId: 'caller-picked',
        },
        issues: [
          { path: ['workspaceId'], message: 'Mist session.create does not support workspaceId' },
          { path: ['agentPreset'], message: 'Mist session.create does not support agentPreset' },
          {
            path: ['sessionId'],
            message: 'Mist window ids are host-generated and cannot be preallocated',
          },
        ],
      },
      {
        payload: { cwd: '/requested', agentPreset: 'requested-preset', sessionId: 'caller-picked' },
        issues: [
          { path: ['cwd'], message: 'Mist session.create does not support cwd' },
          { path: ['agentPreset'], message: 'Mist session.create does not support agentPreset' },
          {
            path: ['sessionId'],
            message: 'Mist window ids are host-generated and cannot be preallocated',
          },
        ],
      },
      {
        payload: { workspaceId: 'workspace-1', cwd: '/requested', agentPreset: 'requested-preset' },
        issues: [{ path: [], message: 'session.create accepts workspaceId or cwd, not both' }],
      },
    ]

    for (const testCase of cases) {
      const response = await post(base, 'session.create', testCase.payload)
      expect(response.result).toMatchObject({ ok: false, error: { code: 'bad-request' } })
      const details = response.result?.error?.details as {
        issues?: Array<{ path?: unknown[]; message?: string }>
      } | undefined
      expect(details?.issues?.map(issue => ({ path: issue.path, message: issue.message })))
        .toEqual(testCase.issues)
    }
    expect(sessions.openCalls).toBe(0)
    expect(sessions.windowsOf('resident-a')).toEqual([])
  })

  it('hides unknown or cross-resident windows', async () => {
    const sessions = new MemoryViewportRegistry()
    const history = new MemoryWindowHistory()
    const foreign = sessions.open('resident-b', { context: null })
    const base = await start(sessions, history)

    for (const sessionId of ['missing-window', foreign.windowId]) {
      const response = await post(base, 'session.history', { sessionId })
      expect(response.result).toMatchObject({
        ok: false,
        error: { code: 'session-not-found', details: { sessionId } },
      })
    }
    expect(history.reads).toEqual([])
  })
})
