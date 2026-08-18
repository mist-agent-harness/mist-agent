/**
 * Mist plugin-protocol v0 entrypoint — the whole webui as ONE `frontend` plugin (#49 route ①).
 *
 * Contract (RFC v0 §3): `prepare` registers every outward resource through the host context and
 * MUST NOT be publicly reachable; the host calls each resource's `activate()` during its atomic
 * commit, then `PreparedPlugin.activate()` performs the single publication step (binding the
 * listener). `dispose` is idempotent and reports the revoked/failed id sets; teardown delegates
 * to `server.close()`, which terminates live sockets and then closes the listener — the RFC
 * revoke-reachability-first ordering inside close() is dev-server work, tracked in 基建075/⑤.
 * Plugin-side C10/C11 obligations are met here (unreachable prepare, listen only in activate,
 * idempotent dispose); the C10/C11 verdicts themselves judge the host implementation.
 * Config is this plugin's only settings source — the manifest deliberately declares no `env`
 * bindings until the RFC defines env delivery (Review-seat ⑦, #61). The 35 internal client
 * modules stay implementation detail behind this one plugin (Review-seat口径, #56).
 */

import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
// Root-level entry: the workspace alias '@mist-webui/mock-contract' is not linkable from the
// repo root, so the mock handler is imported by its in-tree path (apps/mist-mock-server).
import { createMockMistHandler } from './apps/mist-mock-server/src/index.ts'
import { composeBootGraph } from './apps/dev-server/src/boot-graph.ts'
import { createDevServer, type DevServer } from './apps/dev-server/src/server.ts'

interface ResourceDeclaration {
  readonly id: string
  readonly kind: 'route' | 'tool' | 'listener' | 'timer' | 'connection'
  readonly capabilityId?: string
  activate(): Promise<void>
  dispose(): Promise<void>
}

interface DisposableHandle {
  readonly id: string
  revoke(): Promise<void>
}

interface PluginPrepareContext {
  readonly pluginId: string
  readonly config: unknown
  register(resource: ResourceDeclaration): DisposableHandle
}

interface DisposeReport {
  readonly revoked: readonly string[]
  readonly failed: readonly { id: string; reasonCode: string }[]
}

interface ActivePlugin {
  dispose(): Promise<DisposeReport>
}

interface PreparedPlugin {
  activate(): Promise<ActivePlugin>
  rollback(): Promise<void>
}

interface ActiveWebuiPlugin extends ActivePlugin {
  readonly address: { readonly address: string; readonly port: number }
  /** The gate token in force — config-supplied or auto-generated; hosts surface it as an access URL. */
  readonly token: string
}

interface PreparedWebuiPlugin extends PreparedPlugin {
  activate(): Promise<ActiveWebuiPlugin>
}

interface WebuiPluginConfig {
  readonly port?: number
  readonly bind?: string
  readonly token?: string
  readonly trustedHosts?: readonly string[]
  readonly distDir?: string
}

/** Narrow unknown instance config to the shapes this plugin understands; reject the rest loudly. */
function readConfig(raw: unknown): WebuiPluginConfig {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object') throw new Error('CONFIG_INVALID: webui plugin config must be an object')
  const record = raw as Record<string, unknown>
  const config: {
    port?: number; bind?: string; token?: string; trustedHosts?: readonly string[]; distDir?: string
  } = {}
  if (record['port'] !== undefined) {
    if (typeof record['port'] !== 'number' || !Number.isInteger(record['port'])) {
      throw new Error('CONFIG_INVALID: port must be an integer')
    }
    config.port = record['port']
  }
  for (const key of ['bind', 'token', 'distDir'] as const) {
    const value = record[key]
    if (value !== undefined) {
      if (typeof value !== 'string') throw new Error(`CONFIG_INVALID: ${key} must be a string`)
      config[key] = value
    }
  }
  if (record['trustedHosts'] !== undefined) {
    const hosts = record['trustedHosts']
    if (!Array.isArray(hosts) || hosts.some(entry => typeof entry !== 'string')) {
      throw new Error('CONFIG_INVALID: trustedHosts must be a string array')
    }
    config.trustedHosts = hosts as readonly string[]
  }
  return config
}

const RESOURCES: readonly { id: string; kind: ResourceDeclaration['kind'] }[] = [
  { id: 'static-root', kind: 'route' },
  { id: 'plugins-index', kind: 'route' },
  { id: 'api-dispatch', kind: 'route' },
  { id: 'events-ws', kind: 'connection' },
]

/** PluginModuleV0.prepare — see contract note in the file header. */
export async function prepare(context: PluginPrepareContext): Promise<PreparedWebuiPlugin> {
  const config = readConfig(context.config)
  const here = dirname(fileURLToPath(import.meta.url))
  const distDir = config.distDir ?? join(here, 'apps', 'web', 'dist')
  if (!existsSync(join(distDir, 'index.html'))) {
    throw new Error(`PREPARE_FAILED: no built web app at ${distDir} — run \`pnpm run build\` first`)
  }
  const bind = config.bind ?? '127.0.0.1'
  // #12/#49 deployment shape: the gate is mandatory at every process-entry surface, loopback
  // included — an absent config token means auto-generate, never gate-off (小鉴 P2, PR #13).
  // Secret-delivery caveat (maintainer ruling B, #61): a settings-supplied `config.token`
  // lands in host config snapshots, which conflicts with RFC §2's secret clause. Kept as-is
  // for now; migrates to the env/secret delivery channel once #62 (env via context.env)
  // lands — until then hosts must not persist this key into snapshots (debt tracked on #62).
  const token = config.token ?? randomBytes(24).toString('base64url')
  const server: DevServer = createDevServer({
    handler: createMockMistHandler(),
    distDir,
    bootGraph: composeBootGraph(here),
    bind,
    trustedHosts: [...(config.trustedHosts ?? [])],
    token,
  })

  // Host-driven commit bookkeeping: nothing is reachable until listen() in activate() below.
  const hostActivated = new Set<string>()
  const revoked = new Set<string>()
  let phase: 'prepared' | 'active' | 'rolled-back' | 'disposed' = 'prepared'
  let listened = false
  let terminalReport: DisposeReport | undefined

  const teardown = async (): Promise<DisposeReport> => {
    if (terminalReport !== undefined) return terminalReport
    const failed: { id: string; reasonCode: string }[] = []
    if (!listened) {
      // Never published: no listener or socket exists, so this is a pure bookkeeping reversal —
      // closing a never-listened server would reject ERR_SERVER_NOT_RUNNING (Review-seat ③, #61).
      for (const { id } of RESOURCES) revoked.add(id)
    } else {
      try {
        // Sockets and listener fall via server.close() before any per-resource bookkeeping.
        await server.close()
        for (const { id } of RESOURCES) revoked.add(id)
      } catch {
        for (const { id } of RESOURCES) {
          if (!revoked.has(id)) failed.push({ id, reasonCode: 'DISPOSE_INCOMPLETE' })
        }
      }
    }
    terminalReport = { revoked: [...revoked], failed }
    phase = 'disposed'
    return terminalReport
  }

  for (const { id, kind } of RESOURCES) {
    context.register({
      id,
      kind,
      activate: () => {
        hostActivated.add(id)
        return Promise.resolve()
      },
      dispose: async () => {
        // A swallowed teardown failure would project a quarantine-worthy state as a clean
        // unload on the host's revoke path — surface it instead (Review-seat ④, #61).
        const report = await teardown()
        if (report.failed.length > 0) {
          throw new Error(
            `DISPOSE_INCOMPLETE: teardown left ${report.failed.map(entry => entry.id).join(', ')} unreleased`,
          )
        }
      },
    })
  }

  return {
    activate: async (): Promise<ActiveWebuiPlugin> => {
      if (phase !== 'prepared') throw new Error(`ACTIVATE_FAILED: cannot activate from ${phase}`)
      if (hostActivated.size !== RESOURCES.length) {
        throw new Error('ACTIVATE_FAILED: host must commit all registered resources before publication')
      }
      const address = await server.listen(config.port ?? 0)
      listened = true
      phase = 'active'
      return {
        address,
        token,
        dispose: teardown,
      }
    },
    rollback: async (): Promise<void> => {
      if (phase === 'active') throw new Error('ACTIVATE_FAILED: rollback is a prepare-phase reversal')
      await teardown()
      phase = 'rolled-back'
    },
  }
}

/** Exposed for tests: the server address once active (undefined otherwise). */
export type {
  WebuiPluginConfig, PreparedPlugin, ActivePlugin, ActiveWebuiPlugin, PreparedWebuiPlugin,
  DisposeReport, PluginPrepareContext, ResourceDeclaration,
}
