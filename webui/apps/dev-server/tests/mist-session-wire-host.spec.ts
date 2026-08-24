import { type ChildProcess, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  sessionCreateValueSchema,
  sessionHistoryValueSchema,
  sessionListValueSchema,
} from '@deepseek-ai/dsh-host-apiproxy/api/sessions.schema'
import { afterEach, describe, expect, it } from 'vitest'

interface ReadyMessage {
  type: 'ready'
  port: number
  foreignPort: number
  activeId: string
  archivedId: string
}

interface RpcEnvelope {
  result?: { ok: boolean; value?: unknown; error?: { code?: string } }
}

const children: ChildProcess[] = []
const fixture = fileURLToPath(new URL('./fixtures/mist-session-wire-host.ts', import.meta.url))

function startHost(): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  children.push(child)
  return child
}

function waitForReady(child: ChildProcess): Promise<ReadyMessage> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    const timeout = setTimeout(() => {
      reject(new Error(`wire host startup timed out: ${stderr}`))
    }, 10_000)
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    child.on('message', onMessage)
    child.once('exit', onExit)

    function cleanup(): void {
      clearTimeout(timeout)
      child.off('message', onMessage)
      child.off('exit', onExit)
    }
    function onMessage(message: unknown): void {
      if (typeof message !== 'object' || message === null || !('type' in message)) return
      if (message.type !== 'ready') return
      cleanup()
      resolve(message as ReadyMessage)
    }
    function onExit(code: number | null): void {
      cleanup()
      reject(new Error(`wire host exited ${String(code)} before ready: ${stderr}`))
    }
  })
}

async function stopHost(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => { resolve() })
  })
  child.send?.({ type: 'stop' })
  await exited
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    try {
      await stopHost(child)
    } catch {
      child.kill()
    }
  }))
})

async function request(base: string, method: string, payload: unknown): Promise<RpcEnvelope> {
  const response = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
  })
  return await response.json() as RpcEnvelope
}

async function post(base: string, method: string, payload: unknown): Promise<unknown> {
  const envelope = await request(base, method, payload)
  expect(envelope.result?.ok).toBe(true)
  return envelope.result?.value
}

describe('Mist session wire real host subprocess', () => {
  it('maps list/create/history to actual multi-viewport registry windows', async () => {
    const child = startHost()
    const ready = await waitForReady(child)
    const base = `http://127.0.0.1:${ready.port}`

    const listed = sessionListValueSchema.parse(await post(base, 'session.list', {}))
    expect(listed.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: ready.activeId, scopeId: 'room-live', archived: false, generation: 1,
      }),
      expect.objectContaining({
        sessionId: ready.archivedId, scopeId: 'room-archive', archived: true, generation: 1,
      }),
    ]))

    const created = sessionCreateValueSchema.parse(await post(base, 'session.create', {
      scopeId: 'room-new',
    }))
    expect(created).toMatchObject({ generation: 1 })
    expect(created.sessionId).not.toBe(ready.activeId)

    const history = sessionHistoryValueSchema.parse(await post(base, 'session.history', {
      sessionId: ready.archivedId,
    }))
    expect(history.hasMore).toBe(false)
    const events = Array.isArray(history.events) ? history.events : []
    expect(events).toHaveLength(1)
    expect(JSON.stringify(events)).toContain('"type":"turn/start"')

    const foreignBase = `http://127.0.0.1:${ready.foreignPort}`
    const foreignList = sessionListValueSchema.parse(await post(foreignBase, 'session.list', {}))
    expect(foreignList.items).toEqual([])
    const foreignHistory = await request(foreignBase, 'session.history', {
      sessionId: ready.archivedId,
    })
    expect(foreignHistory.result).toMatchObject({
      ok: false,
      error: { code: 'session-not-found' },
    })

    await stopHost(child)
  })
})
