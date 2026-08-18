/**
 * Plugin-protocol v0 lifecycle contract for the root mist-plugin entrypoint (#158, route ①):
 * prepare registers exactly the four declared resources and stays unreachable; publication is
 * one atomic step after the host commits every resource; dispose revokes reachability first and
 * is idempotent; rollback is the prepare-phase reversal. Manifest shape is pinned alongside.
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { prepare } from '../../../mist-plugin.ts'
import type { PluginPrepareContext, ResourceDeclaration } from '../../../mist-plugin.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

interface FakeHost {
  context: PluginPrepareContext
  registered: ResourceDeclaration[]
}

function makeHost(config: unknown): FakeHost {
  const registered: ResourceDeclaration[] = []
  return {
    registered,
    context: {
      pluginId: 'mist-webui',
      config,
      register: (resource) => {
        registered.push(resource)
        return { id: resource.id, revoke: () => resource.dispose() }
      },
    },
  }
}

const TOKEN = 'plugin-spec-token'

describe('manifest', () => {
  it('pins the RFC v0 shape: schema 0, frontend kind, empty injection/capability/permission sets', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'mist-plugin.json'), 'utf8')) as Record<string, unknown>
    expect(manifest['manifestSchemaVersion']).toBe(0)
    expect(manifest['id']).toMatch(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/)
    expect(manifest['kinds']).toEqual(['frontend'])
    expect(manifest['entrypoint']).toBe('mist-plugin.ts')
    expect(manifest['contextInjections']).toEqual([])
    expect(manifest['capabilities']).toEqual([])
    expect(manifest['permissions']).toEqual([])
    const env = manifest['env'] as { name: string; secret: boolean }[]
    expect(env.find(entry => entry.name === 'TOKEN')?.secret).toBe(true)
  })
})

describe('lifecycle transaction', () => {
  it('registers exactly the four declared resources during prepare, none reachable yet', async () => {
    const host = makeHost({ token: TOKEN })
    const prepared = await prepare(host.context)
    expect(host.registered.map(resource => `${resource.kind}:${resource.id}`).sort()).toEqual([
      'connection:events-ws', 'route:api-dispatch', 'route:plugins-index', 'route:static-root',
    ])
    await prepared.rollback()
  })

  it('refuses publication before the host committed every registered resource', async () => {
    const host = makeHost({ token: TOKEN })
    const prepared = await prepare(host.context)
    await expect(prepared.activate()).rejects.toThrow('ACTIVATE_FAILED')
    await prepared.rollback()
  })

  it('publishes atomically after full commit, gates by token, then disposes idempotently', async () => {
    const host = makeHost({ token: TOKEN })
    const prepared = await prepare(host.context)
    for (const resource of host.registered) await resource.activate()
    const active = await prepared.activate()
    const base = `http://127.0.0.1:${active.address.port}`
    expect((await fetch(`${base}/`)).status).toBe(401)
    expect((await fetch(`${base}/?token=${TOKEN}`, { redirect: 'manual' })).status).toBe(302)
    const first = await active.dispose()
    expect(first.failed).toEqual([])
    expect([...first.revoked].sort()).toEqual(['api-dispatch', 'events-ws', 'plugins-index', 'static-root'])
    const second = await active.dispose()
    expect(second).toEqual(first)
    await expect(fetch(`${base}/`)).rejects.toThrow()
  })

  it('auto-generates a mandatory gate token when config omits one — loopback not exempt', async () => {
    const host = makeHost({})
    const prepared = await prepare(host.context)
    for (const resource of host.registered) await resource.activate()
    const active = await prepared.activate()
    expect(active.token.length).toBeGreaterThanOrEqual(24)
    const base = `http://127.0.0.1:${active.address.port}`
    expect((await fetch(`${base}/`)).status).toBe(401)
    expect((await fetch(`${base}/?token=${active.token}`, { redirect: 'manual' })).status).toBe(302)
    const report = await active.dispose()
    expect(report.failed).toEqual([])
  })

  it('rollback is the prepare reversal: idempotent and blocks later activation', async () => {
    const host = makeHost({ token: TOKEN })
    const prepared = await prepare(host.context)
    await prepared.rollback()
    await prepared.rollback()
    await expect(prepared.activate()).rejects.toThrow('ACTIVATE_FAILED')
  })
})
