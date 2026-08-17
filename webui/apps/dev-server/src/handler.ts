/**
 * The pluggable seam between the wire shell (server.ts) and mist semantics.
 *
 * Contract: docs/research/mist-wire-contract.md. The shell owns transport and
 * envelope framing; a MistHandler owns business results. The default boot-stub
 * (default-handler.ts) proves the readiness trio; the mock (tata-codex lane)
 * and eventually the real mist orchestration layer implement the same face.
 */

import type { RpcError } from '@deepseek-ai/dsh-host-apiproxy/api'

/** Business result of one unary call. Value stays wide — the client runs the method-level parse. */
export type UnaryResult =
  | { ok: true; value: unknown }
  | { ok: false; error: RpcError }

/** A server-request frame pushed down one of the two event streams. */
export interface DownlinkFrame {
  stream: 'mux' | 'host'
  /** Stable correlation id for answerable/replayed frames; pure pushes omit it. */
  rpcId?: string
  /** Frame payload (MuxFrame / HostFrame shape — handler's responsibility to match the schema). */
  payload: unknown
}

export interface MistHandler {
  /**
   * Answer one unary /api/{method} call.
   * Must never throw for business failures — return { ok: false, error } with a
   * structured RpcError (closed code union; use 'internal' with an explanatory
   * message for not-yet-implemented methods). Throwing is reserved for genuine
   * shell-level bugs and surfaces as a transport 500.
   */
  unary(method: string, payload: unknown, rpcId: string): Promise<UnaryResult>

  /**
   * Answer a client-response (answer to a pending server-initiated interaction).
   * @returns whether the response was accepted (drives the RpcReceipt).
   */
  respond(rpcId: string, result: unknown): Promise<{ accepted: true } | { accepted: false; reason: 'not-pending' | 'bad-response' }>

  /**
   * Subscribe to downlink frames. The shell calls this once per live socket's
   * stream and forwards every emitted frame to that socket wrapped in a
   * server-request envelope. Returns an unsubscribe function.
   */
  subscribe(stream: 'mux' | 'host', emit: (frame: DownlinkFrame) => void): () => void
}
