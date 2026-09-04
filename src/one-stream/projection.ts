import { type CanonicalEvent, cloneEvent, verifyCanonicalEvent } from "./event-contract.ts";
import type { CanonicalStreamReadPort } from "./store.ts";

export class ProjectionIntegrityError extends Error {
  readonly code = "PROJECTION_INTEGRITY";
  constructor(message: string) {
    super(message);
    this.name = "ProjectionIntegrityError";
  }
}

export class CanonicalStreamProjection {
  readonly #readPort: CanonicalStreamReadPort;
  readonly #residentId: string;
  readonly #events: CanonicalEvent[] = [];
  #cursor = 0;

  constructor(readPort: CanonicalStreamReadPort, residentId: string) {
    this.#readPort = readPort;
    this.#residentId = residentId;
  }

  get cursor(): number {
    return this.#cursor;
  }

  async pull(): Promise<CanonicalEvent[]> {
    const incoming = this.#readPort.eventsAfter(this.#residentId, this.#cursor);
    const verified: CanonicalEvent[] = [];
    let expected = this.#cursor + 1;
    try {
      for (const event of incoming) {
        verifyCanonicalEvent(event);
        if (event.residentId !== this.#residentId) {
          throw new ProjectionIntegrityError("projection received an event for another resident");
        }
        if (event.streamSeq !== expected) {
          throw new ProjectionIntegrityError(
            `projection sequence gap: expected ${expected}, got ${event.streamSeq}`,
          );
        }
        verified.push(cloneEvent(event));
        expected += 1;
      }
    } catch (error) {
      if (error instanceof ProjectionIntegrityError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ProjectionIntegrityError(message);
    }

    this.#events.push(...verified);
    if (verified.length > 0) this.#cursor = verified.at(-1)?.streamSeq ?? this.#cursor;
    return verified.map(cloneEvent);
  }

  snapshot(): CanonicalEvent[] {
    return this.#events.map(cloneEvent);
  }
}
