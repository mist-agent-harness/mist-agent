import { defineConfig } from 'vitest/config'

/** Package-local node integration lane. */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
})
