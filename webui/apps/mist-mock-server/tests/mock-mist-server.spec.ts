import type {
  MuxFrame,
  RpcMessage,
  RpcRequest,
  RpcResponse,
  ServerRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { WebApiClient } from '../../../packages/client/connection/src/client/web-api-client.ts'
import { foldSurface } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import NodeWebSocket from 'ws'
import { createDevServer, type DevServer } from '../../dev-server/src/server.ts'
import { WelcomeNoticeStore } from '../../../packages/client/ui-settings-models/src/client/welcome-store.ts'
import { WELCOME_NOTICE_VERSION } from '../../../packages/client/ui-settings-models/src/onboarding-copy.ts'
import { createMockMistHandler, type MockMistHandler } from '../src/index.ts'

const originalWebSocket = globalThis.WebSocket
let server: DevServer | undefined
let mock: MockMistHandler | undefined

beforeAll(() => {
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    value: NodeWebSocket,
    writable: true,
  })
})

afterAll(() => {
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    value: originalWebSocket,
    writable: true,
  })
})

afterEach(async () => {
  await server?.close()
  server = undefined
  mock?.dispose()
  mock = undefined
})

class TestWebApiClient extends WebApiClient {
  constructor(private readonly base: string) {
    super(2_000)
  }

  protected override resolveBase(): string {
    return this.base
  }
}

async function start(options: ConstructorParameters<typeof MockMistHandler>[0] = {}): Promise<TestWebApiClient> {
  mock = createMockMistHandler(options)
  server = createDevServer({ handler: mock })
  const address = await server.listen(0)
  return new TestWebApiClient(`http://127.0.0.1:${address.port}`)
}

function ok<T>(response: RpcResponse<T>): T {
  if (!response.result.ok) throw new Error(JSON.stringify(response.result.error))
  return response.result.value
}

async function nextFrame<F>(iterator: AsyncIterator<RpcRequest<F>>): Promise<RpcRequest<F>> {
  const next = await iterator.next()
  if (next.done) throw new Error('event stream ended before the expected frame')
  return next.value
}

async function nextMatching(
  iterator: AsyncIterator<RpcRequest<MuxFrame>>,
  predicate: (frame: MuxFrame) => boolean,
): Promise<RpcRequest<MuxFrame>> {
  while (true) {
    const envelope = await nextFrame(iterator)
    if (predicate(envelope.payload)) return envelope
  }
}

describe('Mist webui v0 executable contract', () => {
  it('passes the stock client readiness trio and exact P0 unary value schemas', async () => {
    const client = await start()
    const abort = new AbortController()
    let muxOpened = false
    let hostOpened = false
    const mux = client.events.mux({}, abort.signal, () => { muxOpened = true })[Symbol.asyncIterator]()
    const host = client.events.host({}, abort.signal, () => { hostOpened = true })[Symbol.asyncIterator]()
    const muxWait = mux.next()
    const hostWait = host.next()

    const description = ok(await client.host.describe({}))
    await expect.poll(() => muxOpened && hostOpened).toBe(true)
    expect(description).toEqual({
      version: '0.1.0-mock',
      cwd: '/mist',
      attachedSessions: 0,
      canOpenPath: false,
    })
    expect(description).not.toHaveProperty('provider')
    expect(description).not.toHaveProperty('model')

    const workspaces = ok(await client.workspace.list({}))
    expect(workspaces.items).toEqual([
      expect.objectContaining({
        workspaceId: 'mist-v0',
        path: '/mist',
        title: 'Mist',
        sessionIds: [],
      }),
    ])
    expect(ok(await client.sessions.list({}))).toEqual({ items: [] })

    abort.abort()
    await Promise.all([muxWait, hostWait])
  })

  it('returns schema-valid RpcError for every unimplemented P1 method', async () => {
    const client = await start()
    const unsupported = await client.sessions.search({ query: 'not implemented' })
    expect(unsupported.result).toEqual({
      ok: false,
      error: {
        code: 'internal',
        message: 'not implemented by Mist webui v0: session.search',
        details: {},
      },
    })
  })

  it('persists welcome acknowledgement through the generic settings namespace store', async () => {
    const client = await start()
    const initial = ok(await client.settings.describe({}))
    expect(initial).toEqual({
      writable: true,
      hasDocument: false,
      namespaces: [expect.objectContaining({
        ns: 'ui-onboarding',
        value: {},
        applies: 'live',
        secrets: [],
        revision: 0,
      })],
    })

    const welcome = new WelcomeNoticeStore(client)
    await welcome.load()
    expect(welcome.store.getSnapshot()).toMatchObject({ status: 'ready', acknowledged: false })
    await expect(welcome.acknowledge()).resolves.toBe(true)
    expect(welcome.store.getSnapshot()).toMatchObject({ status: 'ready', acknowledged: true })
    expect(ok(await client.settings.describe({})).namespaces[0]).toMatchObject({
      value: { welcomeNoticeVersion: WELCOME_NOTICE_VERSION },
      revision: 1,
    })
    const reloaded = new WelcomeNoticeStore(client)
    await reloaded.load()
    expect(reloaded.store.getSnapshot()).toMatchObject({ status: 'ready', acknowledged: true })

    const nested = ok(await client.settings.mutate({
      ns: 'ui-onboarding',
      ops: [
        { op: 'set', path: ['future', 'flag'], value: true },
        { op: 'unset', path: ['future', 'flag'] },
      ],
    }))
    expect(nested.value).toEqual({ welcomeNoticeVersion: WELCOME_NOTICE_VERSION, future: {} })
    expect(nested.revision).toBe(2)

    const stale = await client.settings.mutate({
      ns: 'ui-onboarding',
      ops: [{ op: 'set', path: ['welcomeNoticeVersion'], value: 'stale' }],
      expectedRevision: 0,
    })
    expect(stale.result).toEqual({
      ok: false,
      error: {
        code: 'settings-conflict',
        message: 'settings namespace "ui-onboarding" changed since it was read',
        details: { ns: 'ui-onboarding', expected: 0, actual: 2 },
      },
    })

    const unknown = await client.settings.mutate({
      ns: 'not-registered',
      ops: [{ op: 'set', path: ['value'], value: true }],
    })
    expect(unknown.result).toMatchObject({
      ok: false,
      error: { code: 'settings-not-exposed', details: { ns: 'not-registered' } },
    })
  })

  it('streams exact SessionEvent shapes and history converges by contiguous seq', async () => {
    const client = await start({ eventDelayMs: 1 })
    const workspace = ok(await client.workspace.list({})).items[0]
    if (workspace === undefined) throw new Error('synthetic workspace is missing')
    const created = ok(await client.sessions.create({
      workspaceId: workspace.workspaceId,
      sessionId: 'session-stream' as never,
    }))
    const abort = new AbortController()
    const observed: RpcMessage[] = []
    client.subscribeEnvelopes((batch) => { observed.push(...batch) })
    const iterator = client.events.mux({}, abort.signal)[Symbol.asyncIterator]()

    const subscribed = await nextFrame(iterator)
    expect(subscribed.payload).toEqual({
      type: 'session/subscribed',
      sessionId: created.sessionId,
      lastSeq: -1,
    })

    const promptResponse = await client.sessions.prompt({
      sessionId: created.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'exercise the contract' }],
      clientTimeZone: 'Asia/Singapore',
    })
    ok(promptResponse)

    const events: SessionEvent[] = []
    while (!events.some(event => event.type === 'turn/end')) {
      const envelope = await nextMatching(
        iterator,
        frame => frame.type === 'session/event' && frame.sessionId === created.sessionId,
      )
      if (envelope.payload.type === 'session/event') events.push(envelope.payload.event)
    }
    abort.abort()

    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index))
    expect(events.filter(event => event.type === 'turn/start').map(event => event.data.turn)).toEqual([1])
    expect(events.filter(event => event.type === 'step/start').map(event => event.data.step)).toEqual([1, 2])
    expect(events.map(event => event.type)).toEqual(expect.arrayContaining([
      'turn/start',
      'user/message',
      'assistant/chunk',
      'tool/call',
      'tool/result',
      'assistant/message',
      'turn/end',
    ]))
    expect(events.some(event => event.type === 'assistant/chunk'
      && event.data.chunk.type === 'reasoning-delta')).toBe(true)
    expect(events.some(event => event.type === 'assistant/chunk'
      && event.data.chunk.type === 'text-delta')).toBe(true)
    expect(events.find(event => event.type === 'user/message')).toMatchObject({
      data: { source: { kind: 'user', rpcId: promptResponse.rpcId } },
    })
    expect(events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
    expect(() => foldSurface(events)).not.toThrow()

    const history = ok(await client.sessions.history({ sessionId: created.sessionId }))
    expect(history.events.map(entry => entry.event)).toEqual(events)
    expect(history.projections).toEqual({ asOfSeq: events.length - 1, values: {} })
    expect(history.hasMore).toBe(false)

    await new Promise<void>((resolve) => { queueMicrotask(resolve) })
    const serverRequests = observed.filter((message): message is ServerRequest => message.type === 'server-request')
    expect(serverRequests.length).toBeGreaterThan(0)
    expect(serverRequests.every(message => message.method
      === (message.payload as { type: string }).type)).toBe(true)
  })

  it('cancels an in-flight turn once and suppresses a later completed terminal', async () => {
    const client = await start({ eventDelayMs: 12 })
    const created = ok(await client.sessions.create({ sessionId: 'session-cancel' as never }))
    const abort = new AbortController()
    const iterator = client.events.mux({}, abort.signal)[Symbol.asyncIterator]()
    await nextFrame(iterator)

    ok(await client.sessions.prompt({
      sessionId: created.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'cancel this turn' }],
    }))
    await nextMatching(iterator, frame => frame.type === 'session/event'
      && frame.event.type === 'assistant/chunk'
      && frame.event.data.chunk.type === 'reasoning-delta')
    expect(ok(await client.sessions.cancel({ sessionId: created.sessionId }))).toEqual({ accepted: true })
    const cancelled = await nextMatching(iterator, frame => frame.type === 'session/event'
      && frame.event.type === 'turn/end')
    abort.abort()

    expect(cancelled.payload).toMatchObject({
      type: 'session/event',
      event: { data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } },
    })
    await new Promise(resolve => setTimeout(resolve, 120))
    const history = ok(await client.sessions.history({ sessionId: created.sessionId }))
    const terminals = history.events.filter(entry => entry.event.type === 'turn/end')
    expect(terminals).toHaveLength(1)
    expect(terminals[0]?.event).toMatchObject({ data: { reason: { kind: 'aborted' } } })
  })

  it('exposes the canonical failed terminal for error-state UI development', async () => {
    const client = await start({ eventDelayMs: 1 })
    const created = ok(await client.sessions.create({ sessionId: 'session-failed' as never }))
    mock?.failNextTurn('adapter unavailable')
    const abort = new AbortController()
    const iterator = client.events.mux({}, abort.signal)[Symbol.asyncIterator]()
    await nextFrame(iterator)
    ok(await client.sessions.prompt({
      sessionId: created.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'fail this turn' }],
    }))
    const terminal = await nextMatching(iterator, frame => frame.type === 'session/event'
      && frame.event.type === 'turn/end')
    abort.abort()
    expect(terminal.payload).toMatchObject({
      type: 'session/event',
      event: {
        type: 'turn/end',
        data: { reason: { kind: 'error', error: { code: 'MOCK_FAILURE', message: 'adapter unavailable' } } },
      },
    })
  })

  it('replays pending questions and accepts only correlated schema-valid answers', async () => {
    const client = await start()
    const created = ok(await client.sessions.create({ sessionId: 'session-question' as never }))
    const pending = mock?.queueQuestion({
      sessionId: created.sessionId,
      question: 'Continue?',
      options: [{ label: 'Yes' }, { label: 'No' }],
    })
    if (pending === undefined) throw new Error('mock was not started')

    const firstAbort = new AbortController()
    const first = client.events.mux({}, firstAbort.signal)[Symbol.asyncIterator]()
    await nextFrame(first)
    const firstQuestion = await nextMatching(first, frame => frame.type === 'question/requested')
    expect(firstQuestion.rpcId).toBe(pending.rpcId)
    firstAbort.abort()

    const replayAbort = new AbortController()
    const replay = client.events.mux({}, replayAbort.signal)[Symbol.asyncIterator]()
    await nextFrame(replay)
    const replayed = await nextMatching(replay, frame => frame.type === 'question/requested')
    expect(replayed.rpcId).toBe(pending.rpcId)

    const questionId = replayed.payload.type === 'question/requested'
      ? replayed.payload.questions[0]?.id
      : undefined
    if (questionId === undefined) throw new Error('mock question is missing its item id')
    const answer = (overrides: Record<string, unknown> = {}) => ({
      type: 'client-response' as const,
      rpcId: pending.rpcId,
      result: {
        ok: true as const,
        value: {
          sessionId: created.sessionId,
          answer: { answers: [{ id: questionId, selected: ['Yes'] }] },
          ...overrides,
        },
      },
    })

    expect(await client.respond({
      ...answer(),
      rpcId: 'not-a-pending-question' as never,
    })).toEqual({ accepted: false, reason: 'not-pending' })
    expect(await client.respond({
      type: 'client-response',
      rpcId: pending.rpcId,
      result: { ok: true, value: { answers: { continue: 'yes' } } },
    }))
      .toEqual({ accepted: false, reason: 'bad-response' })
    expect(await client.respond(answer({ sessionId: 'wrong-session' })))
      .toEqual({ accepted: false, reason: 'bad-response' })
    expect(await client.respond(answer({
      answer: { answers: [{ id: 'wrong-question', selected: ['Yes'] }] },
    }))).toEqual({ accepted: false, reason: 'bad-response' })
    expect(await client.respond(answer({
      answer: { answers: [{ id: questionId, selected: ['Maybe'] }] },
    }))).toEqual({ accepted: false, reason: 'bad-response' })
    expect(await client.respond(answer({
      answer: { answers: [{ id: questionId, selected: ['Yes', 'Yes'] }] },
    }))).toEqual({ accepted: false, reason: 'bad-response' })
    expect(await client.respond(answer({
      answer: { answers: [{ id: questionId, selected: ['Yes'], custom: 'Something else' }] },
    }))).toEqual({ accepted: false, reason: 'bad-response' })

    const response = {
      type: 'client-response' as const,
      rpcId: pending.rpcId,
      result: {
        ok: true as const,
        value: {
          sessionId: created.sessionId,
          answer: { answers: [{ id: questionId, selected: ['Yes'] }] },
        },
      },
    }
    expect(await client.respond(response)).toEqual({ accepted: true })
    expect(await client.respond(response)).toEqual({ accepted: false, reason: 'not-pending' })
    const resolved = await nextMatching(replay, frame => frame.type === 'question/resolved')
    expect(resolved.payload).toEqual({
      type: 'question/resolved',
      sessionId: created.sessionId,
      questionRpcId: pending.rpcId,
      outcome: 'answered',
    })

    const cancelledPending = mock?.queueQuestion({
      sessionId: created.sessionId,
      question: 'Cancel this question?',
      options: [{ label: 'Continue' }],
    })
    if (cancelledPending === undefined) throw new Error('mock was not started')
    await nextMatching(replay, frame => frame.type === 'question/requested')
    expect(await client.respond({
      type: 'client-response',
      rpcId: cancelledPending.rpcId,
      result: { ok: false, error: { code: 'internal', message: 'not a cancellation', details: {} } },
    })).toEqual({ accepted: false, reason: 'bad-response' })
    expect(await client.respond({
      type: 'client-response',
      rpcId: cancelledPending.rpcId,
      result: { ok: false, error: { code: 'cancelled', message: 'cancelled by user', details: {} } },
    })).toEqual({ accepted: true })
    const cancelled = await nextMatching(replay, frame => frame.type === 'question/resolved')
    expect(cancelled.payload).toMatchObject({
      type: 'question/resolved',
      questionRpcId: cancelledPending.rpcId,
      outcome: 'cancelled',
    })
    replayAbort.abort()
  })
})
