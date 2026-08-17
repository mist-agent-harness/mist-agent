# Mist webui mock contract

This app is the executable Mist conversation contract used while the production
session orchestration API is still being built. It implements the three-method
`MistHandler` seam from `apps/dev-server`; the dev server continues to own static
files, HTTP/WebSocket transport, and four-quadrant RPC envelopes.

The mock is in-memory, deterministic, loopback-only through the dev server, and
never proxies `mist/demo/server.ts`. That demo produces one final string and
cannot model thinking, tools, cancellation, reconnect repair, or pending
interactions.

## Use

```ts
import { createDevServer } from '../dev-server/src/server.ts'
import { createMockMistHandler } from './src/index.ts'

const handler = createMockMistHandler()
const server = createDevServer({ handler })
await server.listen(4700)
```

Run the contract lane with Node 22 or newer:

```bash
pnpm --filter @mist-webui/mock-contract test
```

The integration suite drives the stock `WebApiClient` through the real dev
server and both WebSocket downlinks. It therefore exercises both schema levels,
RPC echoing, and browser transport rather than calling implementation methods
directly.

## Implemented P0

- `host.describe`
- `session.list`
- `session.create`
- `session.history`
- `session.prompt`
- `session.cancel`
- `workspace.list`
- `settings.describe`
- `settings.mutate`
- `api.respond`
- `events.mux`
- `events.host`

Every other recognized unary method returns `result.ok=false` with the closed
upstream `internal` error code and an explanatory message. P0 validation and
business failures use the specific codes recorded in
`docs/research/mist-wire-contract.md`; they never throw into a carrier 500.

The settings mock owns a generic in-memory namespace map and path mutation
engine. It initially registers `ui-onboarding`, allowing the welcome notice to
persist its acknowledged copy version; unknown namespaces stay closed rather
than becoming writable through probing.

## Session and reconnect model

Each session owns an append-only upstream `SessionEvent` log. Sequence numbers
start at zero and remain contiguous. A mux subscription first emits
`session/subscribed(lastSeq)` for each existing session, where an empty log has
`lastSeq=-1`; live events then use `session/event`. Reconnection reopens both
streams and refetches `session.list` plus the `session.history` tail.

The scripted successful turn covers reasoning chunks, a tool call/result, text
chunks, assembled messages, and a completed `turn/end`. `session.cancel`
produces one aborted terminal and suppresses later completion.
`handler.failNextTurn()` exposes the canonical error terminal for UI tests.

`handler.queueQuestion()` is a test-only hook for pending-interaction recovery.
The requested frame carries a stable outer `rpcId`; every reconnect replays that
same id until `api.respond` accepts it. Duplicate or late responses return
`not-pending`. A response is accepted only when that `rpcId` is still pending
and its session, ordered question ids, selected option labels, multiplicity,
and optional custom answer all match the original request; malformed answers
leave the interaction pending and return `bad-response`.

## Boundary

The wire carries UI semantics only. It contains no provider name, channel id,
credential, or adapter selection. The real Mist implementation will resolve
resident and lane bindings behind this same handler surface.
