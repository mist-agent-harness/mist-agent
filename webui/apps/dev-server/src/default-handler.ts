/**
 * Boot-stub handler: the smallest honest mist.
 *
 * Answers the readiness trio and the onConnected resync (session.list +
 * workspace.list) with real-but-empty values so the stock client reaches
 * 'connected' and renders an empty home. Every other method answers a
 * structured RpcError ('internal' — the code union is closed upstream and has
 * no 'unimplemented'; the message carries the semantics). The mock lane
 * replaces this with real turn logic behind the same MistHandler face.
 */

import type { DownlinkFrame, MistHandler, UnaryResult } from './handler.ts'

/**
 * Methods the stub answers with real empty-state values.
 * Shapes verified against the freeze-SHA schemas (schema file: field list):
 * - host.schema.ts hostDescribeValueSchema: version/cwd/provider?/model?/attachedSessions/canOpenPath
 * - sessions.schema.ts sessionListValueSchema: { items: SessionSummary[] }
 * - workspace.schema.ts workspaceListValueSchema: { items: WorkspaceView[], archivedSessionIds: SessionId[] }
 */
const STUB_VALUES: Record<string, () => unknown> = {
  'host.describe': () => ({
    version: 'mist-dev-0.0.1',
    cwd: '/',
    attachedSessions: 0,
    canOpenPath: false,
  }),
  'session.list': () => ({ items: [] }),
  'workspace.list': () => ({ items: [], archivedSessionIds: [] }),
}

function unimplemented(method: string): UnaryResult {
  return {
    ok: false,
    error: {
      code: 'internal',
      message: `mist v0 does not implement ${method}`,
      details: {},
    },
  }
}

export function createBootStubHandler(): MistHandler {
  const listeners = { mux: new Set<(f: DownlinkFrame) => void>(), host: new Set<(f: DownlinkFrame) => void>() }
  return {
    unary(method, _payload) {
      const stub = STUB_VALUES[method]
      if (stub === undefined) return Promise.resolve(unimplemented(method))
      return Promise.resolve({ ok: true, value: stub() } as const)
    },
    respond(_rpcId, _result) {
      // The stub never opens a server-initiated interaction, so nothing can be pending.
      return Promise.resolve({ accepted: false, reason: 'not-pending' } as const)
    },
    subscribe(stream, emit) {
      listeners[stream].add(emit)
      return () => { listeners[stream].delete(emit) }
    },
  }
}
