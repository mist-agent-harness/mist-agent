import { spawn } from 'node:child_process'
import { rename, writeFile } from 'node:fs/promises'

const [statePath] = process.argv.slice(2)
if (statePath === undefined) throw new Error('usage: managed-tree.ts <state-path>')

process.on('SIGTERM', () => {})
process.on('SIGHUP', () => {})
const descendant = spawn(process.execPath, [
  '-e',
  'process.on("SIGTERM",()=>{});process.on("SIGHUP",()=>{});setInterval(()=>{},60_000)',
], { stdio: 'ignore' })
if (descendant.pid === undefined) throw new Error('managed descendant did not publish a pid')

// Publish only after the complete JSON is durable at a same-directory temporary
// path. Observers treat statePath's existence as the readiness boundary, so a
// direct write could expose an empty or partial file between open and write.
const pendingStatePath = `${statePath}.${process.pid}.pending`
await writeFile(pendingStatePath, JSON.stringify({ root: process.pid, descendant: descendant.pid }))
await rename(pendingStatePath, statePath)
setInterval(() => {}, 60_000)
