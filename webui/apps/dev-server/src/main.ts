/** CLI entry: executable Mist mock + built web dist, loopback:4700. */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createMockMistHandler } from '@mist-webui/mock-contract'
import { composeBootGraph } from './boot-graph.ts'
import { createDevServer } from './server.ts'

const here = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = join(here, '..', '..', '..')
const distDir = join(workspaceRoot, 'apps', 'web', 'dist')
if (!existsSync(join(distDir, 'index.html'))) {
  console.error(`[dev-server] no built web app at ${distDir} — run \`pnpm run build:web\` first`)
  process.exit(1)
}

const bootGraph = composeBootGraph(workspaceRoot)
const port = Number(process.env['PORT'] ?? 4700)
const bind = process.env['BIND'] ?? '127.0.0.1'
// mist#49 楼内采纳（kimicode 形状）：CLI 入口默认强制鉴权，loopback 也不豁免——
// 前置反代永远不替应用鉴权。库层保持显式注入合同（测试穿闸用）；强制默认
// 活在进程边界。INSECURE_NO_TOKEN=1 仅供本机/CI 逃生。
const insecure = process.env['INSECURE_NO_TOKEN'] === '1'
const token = insecure ? undefined : (process.env['TOKEN'] ?? randomBytes(24).toString('base64url'))
const trustedHosts = (process.env['TRUSTED_HOSTS'] ?? '').split(',').map(h => h.trim()).filter(h => h.length > 0)
const server = createDevServer({
  handler: createMockMistHandler(), distDir, bootGraph,
  bind, trustedHosts, ...(token === undefined ? {} : { token }),
})
const address = await server.listen(port)
if (server.token !== undefined) {
  console.log(JSON.stringify({ access: `http://${address.address}:${address.port}/?token=${server.token}` }))
}
console.log(JSON.stringify({
  ok: true, host: address.address, port: address.port, dist: distDir,
  plugins: bootGraph.graph.entries.length, graphRev: bootGraph.graph.rev,
}))

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().finally(() => process.exit(0))
  })
}
