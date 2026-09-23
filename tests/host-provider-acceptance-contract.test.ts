import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  expectedHostProviderCheckIds,
  hostProviderChecks,
} from "../acceptance/host-provider-checks.ts";
import type { HostProviderDriver } from "../acceptance/host-provider-driver.ts";

describe("D24 HostProvider acceptance contract", () => {
  it("freezes all 14 check ids in order without duplicates", () => {
    const ids = hostProviderChecks.map((check) => check.id);
    expect(ids).toEqual(expectedHostProviderCheckIds);
    expect(new Set(ids).size).toBe(14);
  });

  it("keeps every executable check paired with one scenario row and one unchecked lamp", () => {
    const path = fileURLToPath(new URL("../acceptance/host-provider.md", import.meta.url));
    const markdown = readFileSync(path, "utf8");

    for (const id of expectedHostProviderCheckIds) {
      const occurrences = markdown.match(new RegExp(`\\b${id}\\b`, "g"))?.length ?? 0;
      expect(occurrences, `${id} should appear once in a table and once in the lamp list`).toBe(2);
      expect(markdown).toContain(`- [ ] ${id} `);
    }
  });

  it("declares only real driver methods and every check includes cleanup", () => {
    const methodNames = new Set<keyof HostProviderDriver>([
      "reset",
      "createResidentFixture",
      "createScopeFixture",
      "createCredentialReference",
      "provisionProvider",
      "attachProvider",
      "wakeProvider",
      "stopProvider",
      "revokeProvider",
      "readProvider",
      "configureHealthScenario",
      "readHealth",
      "dispatch",
      "readDispatch",
      "settleDispatch",
      "readEffects",
      "advanceScopeGeneration",
      "inspectCredentialBoundary",
      "simulateProviderFailure",
      "readCanonicalState",
      "readObservability",
      "setObservabilityAvailability",
      "readEgressLog",
      "exportResident",
      "importResident",
      "beginInFlightWake",
      "completeInFlightWake",
      "bindExternalAddress",
      "resolveExternalAddress",
      "replaceProviderSession",
    ]);

    for (const check of hostProviderChecks) {
      expect(check.uses).toContain("reset");
      expect(check.uses.length).toBeGreaterThan(1);
      for (const method of check.uses) expect(methodNames.has(method)).toBe(true);
    }
  });
});
