import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  expectedResidentContinuityCheckIds,
  residentContinuityChecks,
} from "../acceptance/resident-continuity-checks.ts";
import type { ResidentContinuityDriver } from "../acceptance/resident-continuity-driver.ts";

describe("D22 / D23 acceptance contract", () => {
  it("freezes all 21 check ids in order without duplicates", () => {
    const ids = residentContinuityChecks.map((check) => check.id);
    expect(ids).toEqual(expectedResidentContinuityCheckIds);
    expect(new Set(ids).size).toBe(21);
  });

  it("keeps every executable check paired with one scenario row and one unchecked lamp", () => {
    const path = fileURLToPath(new URL("../acceptance/resident-continuity.md", import.meta.url));
    const markdown = readFileSync(path, "utf8");

    for (const id of expectedResidentContinuityCheckIds) {
      const occurrences = markdown.match(new RegExp(`\\b${id}\\b`, "g"))?.length ?? 0;
      expect(
        occurrences,
        `${id} should appear once in the scenario table and once in the lamp list`,
      ).toBe(2);
      expect(markdown).toContain(`- [ ] ${id} `);
    }
  });

  it("declares only real driver methods and every check includes cleanup", () => {
    const methodNames = new Set<keyof ResidentContinuityDriver>([
      "reset",
      "createCandidate",
      "attestCandidate",
      "readCandidate",
      "readResident",
      "restartHost",
      "openViewport",
      "switchViewportScope",
      "recordRelationshipAssertion",
      "confirmRelationshipAssertion",
      "readRelationshipAssertion",
      "attachScope",
      "detachScope",
      "readScopeContext",
      "tryOperation",
      "introduceEvidenceGap",
      "project",
      "readProjectionReceipt",
      "revisePersona",
      "createMigrationCase",
      "recordMachineConformance",
      "submitBlindEvidence",
      "submitResidentContinuity",
      "submitRelationshipContinuity",
      "activateMigration",
      "readMigrationCase",
      "changeMigrationTarget",
      "runSyntheticEvaluation",
      "createPrivateSource",
      "grantPrivateProjection",
      "projectPrivateSource",
      "inspectEvaluationStorage",
      "revokePrivateSource",
      "readPrivateSource",
      "readEvaluationReceipt",
    ]);

    for (const check of residentContinuityChecks) {
      expect(check.uses).toContain("reset");
      expect(check.uses.length).toBeGreaterThan(1);
      for (const method of check.uses) expect(methodNames.has(method)).toBe(true);
    }
  });
});
