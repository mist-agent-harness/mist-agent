import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { HistoryEntry } from '@deepseek-ai/dsh-host-apiproxy/api'
import { createDevServer } from '../../src/server.ts'
import {
  MistSessionWireAdapter,
  type MistViewportRegistry,
  type MistViewportSnapshot,
  type MistWindowHistoryPage,
  type MistWindowHistoryPort,
  type MistWindowHistoryRef,
  type MistWindowHistorySummary,
} from '../../src/mist-session-wire-adapter.ts'

interface HostRegistry extends MistViewportRegistry<null> {
  kill(windowId: string): MistViewportSnapshot | undefined
}

interface RegistryModule {
  SessionRegistry: new () => HostRegistry
}

class FixtureHistory implements MistWindowHistoryPort {
  constructor(
    readonly activeId: string,
    readonly archivedId: string,
  ) {}

  summarize(window: MistWindowHistoryRef): Promise<MistWindowHistorySummary> {
    if (window.windowId === this.activeId) {
      return Promise.resolve({ updatedAt: 20, running: true, blank: true })
    }
    return Promise.resolve({ updatedAt: 10, running: false, blank: false })
  }

  read(window: MistWindowHistoryRef): Promise<MistWindowHistoryPage> {
    const events: HistoryEntry[] = window.windowId === this.archivedId
      ? [{ event: { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } } }]
      : []
    return Promise.resolve({ events, hasMore: false })
  }
}

const root = resolve(import.meta.dirname, '../../../../..')
const registryUrl = pathToFileURL(resolve(root, 'src/session/session-registry.ts')).href
const { SessionRegistry } = await import(registryUrl) as RegistryModule
const sessions = new SessionRegistry()
const active = sessions.open('resident-a', { scopeId: 'room-live', context: null })
const archived = sessions.open('resident-a', { scopeId: 'room-archive', context: null })
const killedSnapshot = sessions.kill(archived.windowId)
const fetchedSnapshot = sessions.getArchived(archived.windowId)
const listedSnapshot = sessions.archivedWindowsOf('resident-a')[0]
for (const snapshot of [killedSnapshot, fetchedSnapshot, listedSnapshot]) {
  if (snapshot === undefined) throw new Error('expected archived snapshot')
  snapshot.residentId = 'resident-b'
  snapshot.scopeId = 'room-mutated'
  snapshot.generation = 99
  snapshot.headId = 'node-mutated'
}

const history = new FixtureHistory(active.windowId, archived.windowId)
const server = createDevServer({
  handler: new MistSessionWireAdapter({
    residentId: 'resident-a',
    sessions,
    history,
    createContext: () => null,
  }),
})
const foreignServer = createDevServer({
  handler: new MistSessionWireAdapter({
    residentId: 'resident-b',
    sessions,
    history,
    createContext: () => null,
  }),
})
const address = await server.listen(0)
const foreignAddress = await foreignServer.listen(0)

async function stop(): Promise<void> {
  await Promise.all([server.close(), foreignServer.close()])
  process.exit(0)
}

process.on('message', (message: unknown) => {
  if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'stop') {
    void stop()
  }
})
process.on('SIGTERM', () => void stop())
process.send?.({
  type: 'ready',
  port: address.port,
  foreignPort: foreignAddress.port,
  activeId: active.windowId,
  archivedId: archived.windowId,
})
