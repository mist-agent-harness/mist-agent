/**
 * Wire shell: static dist + POST /api/{method} + /api/respond + two
 * downlink-only WebSockets (/api/events.mux, /api/events.host).
 *
 * Owns transport and envelope framing only; business results come from the
 * injected MistHandler. Loopback by default — no public-bind escape hatch
 * (same posture as both upstreams).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { clientRequestSchema, clientResponseSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import { authorize, generateToken, isLoopback, originAllowed } from './auth.ts'
import type { ComposedBootGraph } from './boot-graph.ts'
import { injectBootManifest } from './boot-graph.ts'
import type { DownlinkFrame, MistHandler } from './handler.ts'

const LOOPBACK_HOST = '127.0.0.1'
const MAX_BODY_BYTES = 1024 * 1024
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

export interface DevServerOptions {
  handler: MistHandler
  /** Absolute path of the built web app (apps/web/dist). Omit to run API-only (tests). */
  distDir?: string
  /** Composed plugin graph: injected into index.html and served under /plugins/. Omit for API-only. */
  bootGraph?: ComposedBootGraph
  /** Bind host. Default 127.0.0.1; a non-loopback bind without a token auto-generates one. */
  bind?: string
  /** Access token (explicit injection keeps tests running THROUGH the gate). Absent on loopback = gate off. */
  token?: string
  /** Extra `Host` authorities the origin fence admits (reverse-proxy names). Loopback is always allowed. */
  trustedHosts?: readonly string[]
}

export interface DevServer {
  listen(port: number): Promise<AddressInfo>
  close(): Promise<void>
  /** Active token when the gate is on (auto-generated tokens surface here exactly once). */
  readonly token: string | undefined
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    request.on('error', reject)
  })
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(text)
}

/** Wrap a downlink frame in the server-request envelope the client parses. */
function envelopeFrame(frame: DownlinkFrame): string {
  const payloadType = typeof frame.payload === 'object' && frame.payload !== null
    && typeof (frame.payload as { type?: unknown }).type === 'string'
    ? (frame.payload as { type: string }).type
    : frame.stream === 'mux' ? 'events.mux' : 'events.host'
  return JSON.stringify({
    type: 'server-request',
    rpcId: frame.rpcId ?? crypto.randomUUID(),
    method: payloadType,
    payload: frame.payload,
  })
}

export function createDevServer(options: DevServerOptions): DevServer {
  const { handler, distDir, bootGraph } = options
  const bind = options.bind ?? LOOPBACK_HOST
  // Non-loopback exposure must never be tokenless (mist#49 maintainer directive).
  const token = options.token ?? (isLoopback(bind) ? undefined : generateToken())
  const trustedHosts = options.trustedHosts ?? []

  /** GET /plugins/<id>/client.js — plugin bundle route (id may be a scoped package name). */
  async function handlePlugin(response: ServerResponse, pathname: string): Promise<void> {
    const match = /^\/plugins\/(.+)\/client\.js$/.exec(decodeURIComponent(pathname))
    const bundlePath = match?.[1] !== undefined ? bootGraph?.bundles.get(match[1]) : undefined
    if (bundlePath === undefined) {
      response.writeHead(404).end()
      return
    }
    const body = await readFile(bundlePath)
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' })
    response.end(body)
  }

  async function handleApi(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
    if (request.method !== 'POST') {
      response.writeHead(405).end()
      return
    }
    // 大审②: cross-site no-preflight POSTs arrive as text/plain or bare — a JSON
    // content-type is the write fence (upstream parity: 415 before any body read).
    const contentType = request.headers['content-type'] ?? ''
    if (!contentType.toLowerCase().startsWith('application/json')) {
      sendJson(response, 415, { error: 'content-type must be application/json' })
      return
    }
    let parsedBody: unknown
    try {
      parsedBody = JSON.parse(await readBody(request))
    } catch {
      sendJson(response, 400, { error: 'malformed JSON body' })
      return
    }

    if (pathname === '/api/respond') {
      const message = clientResponseSchema.safeParse(parsedBody)
      if (!message.success) {
        sendJson(response, 400, { error: 'malformed client-response envelope' })
        return
      }
      const receipt = await handler.respond(message.data.rpcId, message.data.result)
      sendJson(response, 200, receipt)
      return
    }

    const message = clientRequestSchema.safeParse(parsedBody)
    if (!message.success) {
      sendJson(response, 400, { error: 'malformed client-request envelope' })
      return
    }
    // Path and envelope must agree on the method (client always sends /api/{method}).
    const pathMethod = pathname.slice('/api/'.length)
    if (pathMethod !== message.data.method) {
      sendJson(response, 400, { error: `method mismatch: path ${pathMethod}, envelope ${message.data.method}` })
      return
    }
    const result = await handler.unary(message.data.method, message.data.payload, message.data.rpcId)
    sendJson(response, 200, { type: 'server-response', rpcId: message.data.rpcId, result })
  }

  async function handleStatic(response: ServerResponse, pathname: string): Promise<void> {
    if (distDir === undefined) {
      response.writeHead(404).end()
      return
    }
    // SPA fallback: non-file paths serve index.html; traversal is rejected.
    const clean = normalize(pathname).replace(/^([/\\])+/, '')
    if (clean.startsWith('..')) {
      response.writeHead(403).end()
      return
    }
    const candidate = clean === '' || extname(clean) === '' ? 'index.html' : clean
    try {
      const body = await readFile(join(distDir, candidate))
      if (candidate === 'index.html' && bootGraph !== undefined) {
        // Host parity: the boot manifest rides the page, first script in <head>.
        const html = injectBootManifest(body.toString('utf8'), bootGraph.graph)
        response.writeHead(200, { 'content-type': MIME['.html'] as string })
        response.end(html)
        return
      }
      response.writeHead(200, { 'content-type': MIME[extname(candidate)] ?? 'application/octet-stream' })
      response.end(body)
    } catch {
      response.writeHead(404).end()
    }
  }

  const httpServer: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`)
    const pathname = url.pathname
    // 大审①: origin fence ahead of everything — cross-site pages never reach
    // the API even in tokenless loopback mode.
    if (!originAllowed(request.headers, trustedHosts)) {
      sendJson(response, 403, { error: 'origin not allowed' })
      return
    }
    const decision = authorize(token, request.headers, url)
    if (!decision.ok) {
      sendJson(response, 401, { error: 'token required' })
      return
    }
    if (decision.setCookie !== undefined) {
      // Query-token entry: pin the cookie and strip the token from the address bar.
      response.writeHead(302, { 'set-cookie': decision.setCookie, location: pathname })
      response.end()
      return
    }
    const route = pathname.startsWith('/api/')
      ? handleApi(request, response, pathname)
      : pathname.startsWith('/plugins/')
        ? handlePlugin(response, pathname)
        : handleStatic(response, pathname)
    route.catch((error: unknown) => {
      console.error('[dev-server] request failed:', error)
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
  })

  // Downlink-only sockets: one subscription per connection, torn down on close.
  const wss = new WebSocketServer({ noServer: true })
  const socketCleanups = new Map<WebSocket, () => void>()
  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`)
    const pathname = url.pathname
    // 大审①: a browser WebSocket handshake always carries Origin — the fence
    // closes the cross-site-WS hole a tokenless loopback bind had.
    if (!originAllowed(request.headers, trustedHosts)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    // Same gate as HTTP: an unauthorized socket never reaches the frame stream.
    if (!authorize(token, request.headers, url).ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    const stream = pathname === '/api/events.mux' ? 'mux' : pathname === '/api/events.host' ? 'host' : undefined
    if (stream === undefined) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const unsubscribe = handler.subscribe(stream, (frame) => {
        if (frame.stream === stream && ws.readyState === ws.OPEN) ws.send(envelopeFrame(frame))
      })
      socketCleanups.set(ws, unsubscribe)
      ws.on('close', () => {
        unsubscribe()
        socketCleanups.delete(ws)
      })
      // Client sends no application data on downlinks; ignore rather than kill.
      ws.on('message', () => undefined)
    })
  })

  return {
    token,
    listen(port: number): Promise<AddressInfo> {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(port, bind, () => {
          httpServer.removeListener('error', reject)
          resolve(httpServer.address() as AddressInfo)
        })
      })
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        let pending = 2
        let firstError: Error | undefined
        const settle = (error?: Error): void => {
          firstError ??= error
          pending -= 1
          if (pending !== 0) return
          if (firstError === undefined) resolve()
          else reject(firstError)
        }

        // Withdraw reachability before touching upgraded sockets: close() stops
        // accepting new HTTP connections synchronously, while its callback
        // waits for ordinary in-flight requests to drain.
        httpServer.close(settle)
        for (const [ws, cleanup] of socketCleanups) {
          cleanup()
          ws.terminate()
        }
        socketCleanups.clear()
        wss.close(settle)
      })
    },
  }
}
