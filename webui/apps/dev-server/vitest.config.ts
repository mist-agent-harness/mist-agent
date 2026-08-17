import { defineConfig } from 'vitest/config'

/** Package-local run (root config is workspace-project shaped and cwd-sensitive). */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
})
