import { defineConfig } from "vitest/config";

// webui/ is a vendored member (#56): root tooling does not scan it.
// Same rationale as the root biome `files.ignore` entry (ruling A on #56) —
// webui runs its own full suite (lint + build + test) in its source-repo CI;
// scanning it from the root runner would re-lint/re-run a frozen vendored tree
// against the wrong toolchain and break the audited-SHA accounting.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "webui/**"],
  },
});
