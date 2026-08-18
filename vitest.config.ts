import { defineConfig, configDefaults } from "vitest/config";

// webui/ 是 vendored 冻结树（dsh 官方素皮整包，SHA 对账、字节稳定）。
// 界内测试由 webui 自带 pnpm 流水线（oxlint+build+753 项）自管，
// 根仓 vitest 不扫入，避免双套测试体系互踩。
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "webui/**"],
  },
});
