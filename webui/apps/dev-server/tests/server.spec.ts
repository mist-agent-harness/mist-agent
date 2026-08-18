/**
 * Wire-shell tests over real sockets: readiness trio, envelope errors,
 * unimplemented-method shape, respond receipts, static serving, traversal guard.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest, Server as HttpServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { createDevServer, type DevServer } from '../src/server.ts'
import { createBootStubHandler } from '../src/default-handler.ts'
import type { DownlinkFrame, MistHandler } from '../src/handler.ts'

let server: DevServer | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

async function start(handler: MistHandler = createBootStubHandler(), distDir?: string): Promise<string> {
  server = createDevServer({ handler, ...(distDir === undefined ? {} : { distDir }) })
  const address = await server.listen(0)
  return `http://127.0.0.1:${address.port}`
}

function request(method: string, payload: unknown = {}): { type: string; rpcId: string; method: string; payload: unknown } {
  return { type: 'client-request', rpcId: crypto.randomUUID(), method, payload }
}

/** The wire envelope shapes these tests assert against; bodies are typed at the boundary. */
interface RpcEnvelope {
  type?: string
  rpcId?: string
  result?: { ok?: boolean; value?: unknown; error?: unknown }
  accepted?: boolean
  reason?: string
}

/** Result of the raw POST helpers below: status plus the parsed envelope (undefined when not JSON). */
type PostResult = { status: number; json: RpcEnvelope | undefined }

/** Parse a response body as a wire envelope; undefined when the body is not JSON. */
async function readEnvelope(response: Response): Promise<RpcEnvelope | undefined> {
  try {
    return (await response.json()) as RpcEnvelope
  } catch {
    return undefined
  }
}

async function post(base: string, path: string, body: unknown): Promise<PostResult> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: await readEnvelope(response) }
}

describe('unary dispatch', () => {
  it('answers the readiness describe with an ok envelope echoing the rpcId', async () => {
    const base = await start()
    const message = request('host.describe')
    const { status, json } = await post(base, '/api/host.describe', message)
    expect(status).toBe(200)
    expect(json).toMatchObject({ type: 'server-response', rpcId: message.rpcId, result: { ok: true } })
    const value = json?.result?.value
    expect(value).toMatchObject({ attachedSessions: 0, canOpenPath: false })
    expect(typeof (value as { version?: unknown }).version).toBe('string')
    expect(typeof (value as { cwd?: unknown }).cwd).toBe('string')
  })

  it('answers the resync pair with empty-but-schema-true values', async () => {
    const base = await start()
    const sessions = await post(base, '/api/session.list', request('session.list'))
    expect(sessions.json?.result).toEqual({ ok: true, value: { items: [] } })
    const workspaces = await post(base, '/api/workspace.list', request('workspace.list'))
    expect(workspaces.json?.result).toEqual({ ok: true, value: { items: [], archivedSessionIds: [] } })
  })

  it('answers unimplemented methods with a structured internal RpcError, not a bare 500', async () => {
    const base = await start()
    const { status, json } = await post(base, '/api/session.prompt', request('session.prompt', { text: 'hi' }))
    expect(status).toBe(200)
    expect(json?.result).toMatchObject({ ok: false, error: { code: 'internal', details: {} } })
    const message = (json?.result?.error as { message?: unknown } | undefined)?.message
    expect(typeof message).toBe('string')
    expect(message).toContain('session.prompt')
  })

  it('rejects a malformed envelope with 400', async () => {
    const base = await start()
    const { status } = await post(base, '/api/host.describe', { not: 'an envelope' })
    expect(status).toBe(400)
  })

  it('rejects a path/envelope method mismatch with 400', async () => {
    const base = await start()
    const { status } = await post(base, '/api/session.list', request('host.describe'))
    expect(status).toBe(400)
  })

  it('rejects non-POST with 405', async () => {
    const base = await start()
    const response = await fetch(`${base}/api/host.describe`)
    expect(response.status).toBe(405)
  })
})

describe('respond', () => {
  it('returns the handler receipt for a client-response', async () => {
    const base = await start()
    const { status, json } = await post(base, '/api/respond', {
      type: 'client-response', rpcId: crypto.randomUUID(), result: { ok: true, value: { answer: 'yes' } },
    })
    expect(status).toBe(200)
    expect(json).toEqual({ accepted: false, reason: 'not-pending' })
  })
})

describe('downlinks', () => {
  it('withdraws HTTP reachability before terminating WebSocket clients', async () => {
    const closingServer = createDevServer({ handler: createBootStubHandler() })
    const address = await closingServer.listen(0)
    const base = `http://127.0.0.1:${address.port}`
    const socket = new WebSocket(`${base.replace('http', 'ws')}/api/events.mux`)
    await new Promise<void>((resolve) => { socket.on('open', () => { resolve() }) })

    const httpClose = vi.spyOn(HttpServer.prototype, 'close')
    const wsTerminate = vi.spyOn(WebSocket.prototype, 'terminate')
    try {
      const closing = closingServer.close()
      expect(httpClose).toHaveBeenCalledOnce()
      expect(wsTerminate).toHaveBeenCalledOnce()
      expect(httpClose.mock.invocationCallOrder[0])
        .toBeLessThan(wsTerminate.mock.invocationCallOrder[0] as number)
      await expect(fetch(base)).rejects.toThrow()
      await closing
    } finally {
      httpClose.mockRestore()
      wsTerminate.mockRestore()
      socket.terminate()
      await closingServer.close().catch(() => undefined)
    }
  })

  it('delivers published frames as server-request envelopes on the matching stream only', async () => {
    let emitMux: ((frame: DownlinkFrame) => void) | undefined
    const handler: MistHandler = {
      ...createBootStubHandler(),
      subscribe(stream, emit) {
        if (stream === 'mux') emitMux = emit
        return () => undefined
      },
    }
    const base = await start(handler)
    const socket = new WebSocket(`${base.replace('http', 'ws')}/api/events.mux`)
    const received = new Promise<RpcEnvelope>((resolve) => {
      socket.on('message', (data) => {
        // ws delivers text frames as Buffer; narrow before decoding (no-base-to-string).
        const frame = data as Buffer
        resolve(JSON.parse(frame.toString('utf8')) as RpcEnvelope)
      })
    })
    await new Promise<void>((resolve) => { socket.on('open', () => { resolve() }) })
    expect(emitMux).toBeDefined()
    emitMux?.({
      stream: 'mux',
      rpcId: 'stable-server-request-id',
      payload: { type: 'stream/error', message: 'probe' },
    })
    const frame = await received
    expect(frame).toMatchObject({
      type: 'server-request',
      rpcId: 'stable-server-request-id',
      method: 'stream/error',
      payload: { type: 'stream/error', message: 'probe' },
    })
    socket.close()
  })

  it('destroys upgrades on unknown paths', async () => {
    const base = await start()
    const socket = new WebSocket(`${base.replace('http', 'ws')}/api/events.other`)
    const outcome = await new Promise<string>((resolve) => {
      socket.on('error', () => { resolve('rejected') })
      socket.on('open', () => { resolve('opened') })
    })
    expect(outcome).toBe('rejected')
  })
})

describe('static serving', () => {
  it('serves index.html for / and SPA paths, real files by extension, 404 for missing', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'mist-dist-'))
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>mist</title>')
    writeFileSync(join(dist, 'app.js'), 'console.log(1)')
    const base = await start(createBootStubHandler(), dist)
    expect(await (await fetch(`${base}/`)).text()).toContain('mist')
    expect(await (await fetch(`${base}/some/spa/route`)).text()).toContain('mist')
    expect((await fetch(`${base}/app.js`)).headers.get('content-type')).toContain('text/javascript')
    expect((await fetch(`${base}/missing.css`)).status).toBe(404)
  })

  it('refuses path traversal', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'mist-dist-'))
    writeFileSync(join(dist, 'index.html'), 'x')
    const base = await start(createBootStubHandler(), dist)
    const status = (await fetch(`${base}/..%2f..%2fetc%2fpasswd`)).status
    expect([403, 404]).toContain(status)
  })

  it('404s API-only mode static requests', async () => {
    const base = await start()
    expect((await fetch(`${base}/`)).status).toBe(404)
  })
})

describe('token gate', () => {
  const TOKEN = 'test-token-explicit-injection'

  async function startGated(): Promise<string> {
    server = createDevServer({ handler: createBootStubHandler(), token: TOKEN })
    const address = await server.listen(0)
    return `http://127.0.0.1:${address.port}`
  }

  it('401s api, static and unknown paths without a token', async () => {
    const base = await startGated()
    expect((await fetch(`${base}/`)).status).toBe(401)
    const { status } = await post(base, '/api/host.describe', request('host.describe'))
    expect(status).toBe(401)
  })

  it('accepts a bearer token on unary calls', async () => {
    const base = await startGated()
    const message = request('host.describe')
    const response = await fetch(`${base}/api/host.describe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(message),
    })
    expect(response.status).toBe(200)
    const envelope = await readEnvelope(response)
    expect(envelope?.result?.ok).toBe(true)
  })

  it('upgrades a query token into a cookie redirect, and the cookie then passes', async () => {
    const base = await startGated()
    const entry = await fetch(`${base}/?token=${TOKEN}`, { redirect: 'manual' })
    expect(entry.status).toBe(302)
    const cookie = entry.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('mist_dev_token=')
    const followUp = await post0(base, '/api/session.list', request('session.list'), { cookie: cookie.split(';')[0] ?? '' })
    expect(followUp.status).toBe(200)
  })

  it('rejects wrong tokens in constant shape (401, no detail leak)', async () => {
    const base = await startGated()
    const response = await fetch(`${base}/api/host.describe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      body: JSON.stringify(request('host.describe')),
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'token required' })
  })

  it('gates WebSocket upgrades and admits them with a cookie', async () => {
    const base = await startGated()
    const ws = base.replace('http', 'ws')
    const denied = await new Promise<string>((resolve) => {
      const socket = new WebSocket(`${ws}/api/events.mux`)
      socket.on('error', () => { resolve('rejected') })
      socket.on('open', () => { resolve('opened') })
    })
    expect(denied).toBe('rejected')
    const admitted = await new Promise<string>((resolve) => {
      const socket = new WebSocket(`${ws}/api/events.mux`, { headers: { cookie: `mist_dev_token=${TOKEN}` } })
      socket.on('error', () => { resolve('rejected') })
      socket.on('open', () => { socket.close(); resolve('opened') })
    })
    expect(admitted).toBe('opened')
  })

  it('auto-generates a token for non-loopback binds and surfaces it', () => {
    // Construction-only: never listened, so it must not enter the shared afterEach close.
    const unlistened = createDevServer({ handler: createBootStubHandler(), bind: '0.0.0.0' })
    expect(unlistened.token).toBeDefined()
    expect(unlistened.token?.length).toBeGreaterThanOrEqual(24)
  })
})

/** post() variant with extra headers (cookie flows). */
async function post0(base: string, path: string, body: unknown, headers: Record<string, string>): Promise<PostResult> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: await readEnvelope(response) }
}

describe('origin and content-type fences (大审①②)', () => {
  it('rejects a cross-site WebSocket even in tokenless loopback mode', async () => {
    const base = await start()
    const outcome = await new Promise<string>((resolve) => {
      const socket = new WebSocket(`${base.replace('http', 'ws')}/api/events.mux`, { headers: { origin: 'http://evil.example' } })
      socket.on('error', () => { resolve('rejected') })
      socket.on('open', () => { resolve('opened') })
    })
    expect(outcome).toBe('rejected')
  })

  it('admits a same-origin WebSocket', async () => {
    const base = await start()
    const host = new URL(base).host
    const outcome = await new Promise<string>((resolve) => {
      const socket = new WebSocket(`${base.replace('http', 'ws')}/api/events.mux`, { headers: { origin: `http://${host}` } })
      socket.on('error', () => { resolve('rejected') })
      socket.on('open', () => { socket.close(); resolve('opened') })
    })
    expect(outcome).toBe('opened')
  })

  it('rejects cross-site POSTs by Origin with 403', async () => {
    const base = await start()
    const response = await fetch(`${base}/api/host.describe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify(request('host.describe')),
    })
    expect(response.status).toBe(403)
  })

  it('415s text/plain and missing content-type writes', async () => {
    const base = await start()
    const body = JSON.stringify(request('host.describe'))
    const plain = await fetch(`${base}/api/host.describe`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body })
    expect(plain.status).toBe(415)
    const bare = await fetch(`${base}/api/host.describe`, { method: 'POST', headers: { 'content-type': '' }, body })
    expect(bare.status).toBe(415)
  })

  it('rejects a foreign Host header (rebinding defense) and admits a trusted one', async () => {
    // fetch/undici silently drops a custom Host header, so this fence needs raw http.
    server = createDevServer({ handler: createBootStubHandler(), trustedHosts: ['mist.example'] })
    const address = await server.listen(0)
    const rawPost = (hostHeader: string): Promise<number> => new Promise((resolve, reject) => {
      const body = JSON.stringify(request('host.describe'))
      const req = httpRequest({
        host: '127.0.0.1', port: address.port, path: '/api/host.describe', method: 'POST',
        headers: { 'content-type': 'application/json', host: hostHeader, 'content-length': Buffer.byteLength(body) },
      }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
      req.on('error', reject)
      req.end(body)
    })
    expect(await rawPost('evil.example')).toBe(403)
    expect(await rawPost('mist.example')).toBe(200)
  })
})
