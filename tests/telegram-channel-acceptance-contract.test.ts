import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  expectedTelegramChannelCheckIds,
  telegramChannelChecks,
} from "../acceptance/telegram-channel-checks.ts";
import type { TelegramChannelDriver } from "../acceptance/telegram-channel-driver.ts";

describe("D26 Telegram channel acceptance contract", () => {
  it("freezes all 14 check ids in order without duplicates", () => {
    const ids = telegramChannelChecks.map((check) => check.id);
    expect(ids).toEqual(expectedTelegramChannelCheckIds);
    expect(new Set(ids).size).toBe(14);
  });

  it("pairs every executable check with one scenario row and one unchecked lamp", () => {
    const path = fileURLToPath(new URL("../acceptance/telegram-channel.md", import.meta.url));
    const markdown = readFileSync(path, "utf8");
    for (const id of expectedTelegramChannelCheckIds) {
      const occurrences = markdown.match(new RegExp(`\\b${id}\\b`, "g"))?.length ?? 0;
      expect(occurrences, `${id} should appear once in a table and once in the lamp list`).toBe(2);
      expect(markdown).toContain(`- [ ] ${id} `);
    }
  });

  it("declares real driver methods and cleanup for every check", () => {
    const methodNames = new Set<keyof TelegramChannelDriver>([
      "reset",
      "createResidentFixture",
      "createScopeFixture",
      "setScopeVisibility",
      "advanceScopeGeneration",
      "bindAddress",
      "readBinding",
      "resolveAddress",
      "revokeBinding",
      "ingestUpdate",
      "readInboundEffects",
      "readHostDispatch",
      "sendOutbound",
      "readOutbound",
      "readOutboundEffects",
      "createTokenReference",
      "attachToken",
      "inspectTokenBoundary",
      "revokeToken",
      "beginInFlightChannelOperation",
      "completeInFlightChannelOperation",
      "readObservability",
      "setTelegramAvailability",
      "restartChannel",
      "switchResidentModel",
      "setContinuityVotes",
      "activateContinuity",
      "createGroupFixture",
      "runGroupRound",
      "readCanonicalState",
    ]);
    for (const check of telegramChannelChecks) {
      expect(check.uses).toContain("reset");
      expect(check.uses.length).toBeGreaterThan(1);
      for (const method of check.uses) expect(methodNames.has(method)).toBe(true);
    }
  });
});
