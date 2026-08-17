import type { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Options for the deterministic in-memory Mist contract implementation. */
export interface MockMistHandlerOptions {
  /** Delay between scripted turn events. */
  eventDelayMs?: number
  /** Product version exposed by host.describe. */
  serverVersion?: string
  /** Synthetic v0 workspace path. */
  workspacePath?: string
}

/** Test-only request for a replayable question frame. */
export interface MockQuestionRequest {
  sessionId: SessionId | string
  question: string
  header?: string
  options?: Array<{ label: string; description?: string }>
}

/** Receipt for the test-only pending-question hook. */
export interface QueuedQuestion {
  rpcId: RpcId
  sessionId: SessionId
}
