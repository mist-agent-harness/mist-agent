/**
 * Non-unit acceptance for #111:
 * PluginTransactionHost -> official frontend plugin -> HTTP ->
 * MistSessionWireAdapter -> real SessionRegistry + fixture history port.
 *
 * The history fixture proves delivery/channel correctness only. Production
 * MistWindowHistoryPort persistence is deliberately absent and tracked by #120.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  sessionCreateValueSchema,
  sessionHistoryValueSchema,
  sessionListValueSchema,
} from '@deepseek-ai/dsh-host-apiproxy/api/sessions.schema'
import { afterEach, describe, expect, it } from 'vitest'
import { applyEnabledChange } from '../../../../src/plugin/enable.ts'
import { validateManifest } from '../../../../src/plugin/manifest.ts'
import { moduleRefFromSource } from '../../../../src/plugin/module-ref.ts'
import { PluginOperationStore } from '../../../../src/plugin/operation-store.ts'
import { PluginTransactionHost } from '../../../../src/plugin/transaction-host.ts'
import { SessionRegistry } from '../../../../src/session/session-registry.ts'
import { prepare } from '../../../mist-plugin.ts'
import {
  MistSessionWireAdapter,
  type MistWindowHistoryPage,
  type MistWindowHistoryPort,
  type MistWindowHistoryRef,
  type MistWindowHistorySummary,
} from '../src/mist-session-wire-adapter.ts'

const temporaryPaths: string[] = []

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true })
})

class FixtureHistory implements MistWindowHistoryPort {
  summarize(): Promise<MistWindowHistorySummary> {
    return Promise.resolve({ updatedAt: 27, running: true, blank: false })
  }

  read(window: MistWindowHistoryRef): Promise<MistWindowHistoryPage> {
    return Promise.resolve({
      events: [{ event: { type: 'turn/start', seq: 0, time: 27, data: { turn: window.windowId } } }],
      hasMore: false,
    })
  }
}

function temporaryRoot(): { store: PluginOperationStore; distDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'mist-plugin-composition-'))
  temporaryPaths.push(root)
  const distDir = join(root, 'dist')
  mkdirSync(distDir)
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><html><head></head><body></body></html>')
  return { store: new PluginOperationStore(join(root, 'operations')), distDir }
}

function officialManifest() {
  const result = validateManifest({
    manifestSchemaVersion: 0,
    id: 'mist-official-skin',
    version: '0.1.0',
    requiresMist: '>=0.0.0',
    entrypoint: 'mist-plugin.ts',
    kinds: ['frontend'],
    configSchemaVersion: 0,
    capabilities: [],
    contextInjections: [],
    env: [],
    hostServices: [{ id: 'mist.session-handler', requires: '^1.0.0' }],
    credentials: [],
    permissions: [],
  }, '0.1.0')
  if (!result.ok) throw new Error(result.detail)
  return result.manifest
}

async function post(base: string, token: string, method: string, payload: unknown): Promise<unknown> {
  const response = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
  })
  expect(response.status).toBe(200)
  const envelope = await response.json() as { result?: { ok: boolean; value?: unknown } }
  expect(envelope.result?.ok).toBe(true)
  return envelope.result?.value
}

describe('official frontend host composition', () => {
  it('delivers the real session handler through the plugin transaction', async () => {
    const { store, distDir } = temporaryRoot()
    const sessions = new SessionRegistry<null>()
    const existing = sessions.open('resident-a', { scopeId: 'room-live', context: null })
    const handler = new MistSessionWireAdapter({
      residentId: 'resident-a',
      sessions,
      history: new FixtureHistory(),
      createContext: () => null,
    })
    const host = new PluginTransactionHost({
      store,
      services: [{ id: 'mist.session-handler', version: '1.0.0', service: handler }],
    })
    const port = 45115
    const token = 'real-handler-token'
    const outcome = await applyEnabledChange(host, store, {
      pluginId: 'mist-official-skin',
      manifest: officialManifest(),
      module: { prepare },
      moduleRef: moduleRefFromSource('official frontend host composition'),
      config: { enabled: true, settings: {}, environment: [], credentialRefs: {}, distDir, port, token },
      resolveSecret: () => { throw new Error('no secrets declared') },
    })
    if (outcome.state !== 'active') throw new Error(`activation failed: ${JSON.stringify(outcome)}`)
    const base = `http://127.0.0.1:${port}`
    expect(host.publishedResources('mist-official-skin')).toHaveLength(4)

    const listed = sessionListValueSchema.parse(await post(base, token, 'session.list', {}))
    expect(listed.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: existing.windowId, scopeId: 'room-live' }),
    ]))
    const created = sessionCreateValueSchema.parse(await post(base, token, 'session.create', {
      scopeId: 'room-created',
    }))
    expect(created.sessionId).not.toBe(existing.windowId)
    const history = sessionHistoryValueSchema.parse(await post(base, token, 'session.history', {
      sessionId: existing.windowId,
    }))
    expect(history.hasMore).toBe(false)
    expect(JSON.stringify(history.events)).toContain('turn/start')

    await host.dispose('mist-official-skin')
    await expect(fetch(`${base}/`)).rejects.toThrow()
  })

  it('does not call prepare or publish a listener when the required service is absent', async () => {
    const { store, distDir } = temporaryRoot()
    const host = new PluginTransactionHost({ store })
    const outcome = await applyEnabledChange(host, store, {
      pluginId: 'mist-official-skin',
      manifest: officialManifest(),
      module: { prepare },
      moduleRef: moduleRefFromSource('official frontend missing handler'),
      config: { enabled: true, settings: {}, environment: [], credentialRefs: {}, distDir, port: 45114 },
      resolveSecret: () => { throw new Error('no secrets declared') },
    })
    expect(outcome).toMatchObject({ state: 'blocked', reasonCode: 'REQUIREMENT_MISSING' })
    expect(host.publishedResources('mist-official-skin')).toEqual([])
    await expect(fetch('http://127.0.0.1:45114/')).rejects.toThrow()
  })
})
