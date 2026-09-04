import { afterEach, describe, expect, it } from "vitest";
import {
  CanonicalStreamStore,
  CanonicalStreamWriter,
  HostLifecycleFailureError,
  HostLifecycleFailurePort,
} from "../src/one-stream/index.ts";

const writers: CanonicalStreamWriter[] = [];

afterEach(async () => {
  await Promise.all(writers.splice(0).map((writer) => writer.close()));
});

function harness() {
  const store = new CanonicalStreamStore();
  store.createStream("resident-a");
  const writer = new CanonicalStreamWriter(store, { newEventId: () => "event-1" });
  writers.push(writer);
  const port = new HostLifecycleFailurePort(writer, {
    authoritySource: { kind: "host", id: "mist-host" },
  });
  return { store, port };
}

function submission() {
  return {
    residentId: "resident-a",
    idempotencyKey: "breath:window-a:2:1",
    occurredAt: "2026-09-04T08:40:00.000Z",
    action: "breath" as const,
    subject: { windowId: "window-a", generation: 2 },
    stage: "swap",
    reason: "replacement window did not start",
    windowRecovered: false,
    handling: {
      kind: "user-action" as const,
      action: "Recover viewport window-a before retrying breath",
    },
  };
}

describe("host lifecycle failure port", () => {
  it("makes a real user action explicit while keeping the viewport the subject", async () => {
    const { store, port } = harness();

    await port.submit(submission());

    expect(store.events("resident-a")).toEqual([
      expect.objectContaining({
        purpose: "lifecycle",
        authoritySource: { kind: "host", id: "mist-host" },
        origin: {
          reporter: { kind: "host", id: "mist-host" },
          subject: { kind: "viewport", id: "window-a" },
          viewport: { windowId: "window-a", generation: 2 },
        },
        effect: {
          state: "failed-not-effective",
          requiresUserAction: true,
          retry: "awaiting-external",
        },
        payload: {
          kind: "host-lifecycle-failed",
          action: "breath",
          stage: "swap",
          reason: "replacement window did not start",
          windowRecovered: false,
          userAction: "Recover viewport window-a before retrying breath",
        },
      }),
    ]);
  });

  it("rejects caller-shaped authority and empty user actions before writing", async () => {
    const store = new CanonicalStreamStore();
    const writer = new CanonicalStreamWriter(store);
    writers.push(writer);
    expect(
      () =>
        new HostLifecycleFailurePort(writer, {
          authoritySource: { kind: "viewport", id: "window-a" },
        }),
    ).toThrow(HostLifecycleFailureError);

    const { store: validStore, port } = harness();
    expect(() =>
      port.submit({
        ...submission(),
        handling: { kind: "user-action", action: "   " },
      }),
    ).toThrow("handling.action must be a non-empty string");
    expect(validStore.events("resident-a")).toEqual([]);
  });
});
