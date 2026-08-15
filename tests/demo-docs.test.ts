import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEMO_EXPECTED_FORM_OF_ADDRESS, DEMO_SEED } from "../demo/seed.ts";

describe("rough-house demo documentation", () => {
  it("把固定虚构种子的三条验收答案钉在清单里", () => {
    const checklist = readFileSync("demo/CHECKLIST.md", "utf8");

    expect(DEMO_SEED.memories[0]).toContain(DEMO_EXPECTED_FORM_OF_ADDRESS);
    expect(checklist).toContain(`\`${DEMO_EXPECTED_FORM_OF_ADDRESS}\``);
    expect(checklist).toContain(`\`${DEMO_SEED.memories[1]}\``);
    expect(checklist).toContain(`\`${DEMO_SEED.commitments[0]}\``);
  });

  it("README 给出一条龙启动、Kimi 接线和三个不同的清空边界", () => {
    const readme = readFileSync("README.md", "utf8");
    const configExample = readFileSync("demo/kimi-config.example.toml", "utf8");

    expect(readme).toContain("npm install");
    expect(readme).toContain("npm run demo");
    expect(readme).toContain('type = "openai"');
    expect(configExample).toContain('type = "openai"');
    expect(configExample).toContain('base_url = "http://127.0.0.1:4317/v1"');
    expect(readme).toContain("kimi doctor config");
    expect(readme).toContain("kimi web");
    expect(readme).toContain("Kimi Web 的 `/clear`");
    expect(readme).toContain("`POST /demo/clear`");
    expect(readme).toContain("`POST /demo/reset`");
  });
});
