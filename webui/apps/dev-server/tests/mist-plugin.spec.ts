/**
 * Plugin-protocol v0 lifecycle contract for the root mist-plugin entrypoint (#158, route ①):
 * prepare registers exactly the four declared resources and stays unreachable; publication is
 * one atomic step after the host commits every resource; dispose is idempotent and reports the
 * revoked/failed id sets; a never-published teardown is clean bookkeeping, never a failure;
 * rollback is the prepare-phase reversal. Manifest shape is pinned alongside.
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
    // Config is the only settings source: no env bindings until the RFC defines env delivery
    // (Review-seat ⑦, #61) — declaring them would be dead promises the plugin never reads.
    expect(manifest['env']).toBeUndefined()
  })
})

describe('lifecycle transaction', () => {
  it('registers exactly the four declared resources during prepare, none reachable yet', async () => {
    // Fixed port so unreachability is actually probed, not just asserted by title.
    const port = 45113
    const host = makeHost({ token: TOKEN, port })
    const prepared = await prepare(host.context)
    expect(host.registered.map(resource => `${resource.kind}:${resource.id}`).sort()).toEqual([
      'connection:events-ws', 'route:api-dispatch', 'route:plugins-index', 'route:static-root',
    ])
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow()
    await prepared.rollback()
  })

  it('rejects malformed config loudly before any resource exists', async () => {
    for (const config of [
      42,
      { port: 'not-a-number' },
      { port: 1.5 },
      { bind: 7 },
      { trustedHosts: ['ok', 3] },
    ]) {
      const host = makeHost(config)
      await expect(prepare(host.context)).rejects.toThrow('CONFIG_INVALID')
      expect(host.registered).toEqual([])
    }
  })

  it('fails loud at prepare when the built web app is missing', async () => {
    const host = makeHost({ token: TOKEN, distDir: join(ROOT, 'no-such-dist') })
    await expect(prepare(host.context)).rejects.toThrow('PREPARE_FAILED')
    expect(host.registered).toEqual([])
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

  it('revoking a prepared, never-published plugin is clean bookkeeping — not a failure', async () => {
    // Review-seat ③/④ pin (#61): never-listened teardown must record revoked (not
    // DISPOSE_INCOMPLETE), and the host revoke path must therefore resolve, idempotently.
    const host = makeHost({ token: TOKEN })
    const prepared = await prepare(host.context)
    await host.registered[0].dispose()
    await host.registered[1].dispose()
    await expect(prepared.activate()).rejects.toThrow('ACTIVATE_FAILED')
  })

  it('rollback of a never-published plugin leaves a clean terminal report on every handle', async () => {
    const host = makeHost({ token: TOKEN })
    const prepared = await prepare(host.context)
    await prepared.rollback()
    // With the ④ fix, any recorded teardown failure would surface here as a rejection.
    for (const resource of host.registered) await resource.dispose()
  })
})
