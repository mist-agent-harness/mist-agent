/**
 * Static boot-graph composer: the dev-server's stand-in for the host-side
 * ClientModuleRegistry (packages/client/modules package root).
 *
 * Scans workspace packages for `dsh.client` declarations with platform 'web',
 * resolves each `exports["./client"]` bundle, hashes it for the rev, and
 * composes the `window.__DSH_BOOT__` WebBootGraph the shell parses
 * (packages/client/modules/src/client/manifest.ts is the wire single source:
 * entries of { id: package name, url: '/plugins/<id>/client.js?rev=<rev>',
 * rev, inject?, immediately? }).
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface BootGraphRow {
  id: string
  url: string
  rev: string
  inject?: string[]
  immediately?: boolean
}

export interface BootGraph {
  rev: string
  entries: BootGraphRow[]
}

export interface ComposedBootGraph {
  graph: BootGraph
  /** id → absolute bundle path, for the /plugins/<id>/client.js route. */
  bundles: Map<string, string>
}

/**
 * Plugins the static graph drops:
 * - client-hmr: upstream web profile disables it (dev-watcher infra we don't run)
 * - ui-directory-picker-native: both pickers declare platform web and register the
 *   same directoryFlow slots (upstream's host-side roster picks one); mist v0 has
 *   no native host dialogs, so the browse picker is the one that works.
 */
const EXCLUDED_IDS = new Set([
  '@deepseek-ai/dsh-client-hmr',
  '@deepseek-ai/dsh-client-ui-directory-picker-native',
  // dsh's own cordis plugin-management surface: meaningless against mist and the
  // only remaining console-error source (维护145 大审 roster ruling).
  '@deepseek-ai/dsh-client-ui-cordis',
  '@deepseek-ai/dsh-cordis-client-runner',
])

function shortHash(input: Buffer | string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

/** Resolve exports["./client"] (string or { default } conditional) to a relative path. */
function clientExportOf(exportsField: unknown): string | undefined {
  if (typeof exportsField !== 'object' || exportsField === null) return undefined
  const client = (exportsField as Record<string, unknown>)['./client']
  if (client === undefined) return undefined
  if (typeof client === 'string') return client
  if (typeof client === 'object' && client !== null) {
    const fallback = (client as Record<string, unknown>)['default']
    if (typeof fallback === 'string') return fallback
  }
  return undefined
}

/**
 * Compose the graph from every workspace package declaring a web client face.
 * @param workspaceRoot - repo root holding packages/.
 * @returns graph + bundle path table; throws on a declared-but-unbuilt bundle
 *   (loud beats a page that half-boots).
 */
export function composeBootGraph(workspaceRoot: string): ComposedBootGraph {
  const entries: BootGraphRow[] = []
  const bundles = new Map<string, string>()

  const packagesRoot = join(workspaceRoot, 'packages')
  for (const domain of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!domain.isDirectory()) continue
    const domainDir = join(packagesRoot, domain.name)
    for (const pkg of readdirSync(domainDir, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      const pkgDir = join(domainDir, pkg.name)
      const pkgJsonPath = join(pkgDir, 'package.json')
      if (!existsSync(pkgJsonPath)) continue
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
        name?: string
        exports?: unknown
        dsh?: { client?: { platform?: string; inject?: string[]; immediately?: boolean } }
      }
      const declaration = pkgJson.dsh?.client
      if (declaration?.platform !== 'web' || pkgJson.name === undefined) continue
      if (EXCLUDED_IDS.has(pkgJson.name)) continue
      const relBundle = clientExportOf(pkgJson.exports)
      if (relBundle === undefined) {
        throw new Error(`boot-graph: ${pkgJson.name} declares dsh.client but exports no "./client"`)
      }
      const bundlePath = join(pkgDir, relBundle)
      if (!existsSync(bundlePath)) {
        throw new Error(`boot-graph: ${pkgJson.name} client bundle missing at ${bundlePath} — run pnpm run build:lib:client`)
      }
      const rev = shortHash(readFileSync(bundlePath))
      entries.push({
        id: pkgJson.name,
        url: `/plugins/${pkgJson.name}/client.js?rev=${rev}`,
        rev,
        ...(declaration.inject !== undefined ? { inject: declaration.inject } : {}),
        ...(declaration.immediately === true ? { immediately: true } : {}),
      })
      bundles.set(pkgJson.name, bundlePath)
    }
  }

  entries.sort((a, b) => a.id.localeCompare(b.id))
  const graph: BootGraph = { rev: shortHash(entries.map(entry => entry.rev).join(':')), entries }
  return { graph, bundles }
}

/** Inject the graph as the first script in <head> ('<' escaped, upstream injectBootManifest parity). */
export function injectBootManifest(html: string, graph: BootGraph): string {
  const json = JSON.stringify(graph).replaceAll('<', '\\u003c')
  const script = `<script>window.__DSH_BOOT__ = ${json}</script>`
  const head = html.indexOf('<head>')
  if (head !== -1) return `${html.slice(0, head + 6)}${script}${html.slice(head + 6)}`
  return `${script}${html}`
}
