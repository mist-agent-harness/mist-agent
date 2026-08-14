import { expect, it } from "vitest";
import { checks } from "../acceptance/checks.ts";
import { MIST_VERSION } from "../src/index.ts";

it("骨架活着", () => {
  expect(MIST_VERSION).toBe("0.0.0");
});

it("判卷程序有且仅有六条验收，编号不重复", () => {
  expect(checks).toHaveLength(6);
  expect(new Set(checks.map((c) => c.id)).size).toBe(6);
});
