import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['unit/**/*.test.ts'],
    environment: 'jsdom',
    // Kept so an empty run (e.g. a filtered one) does not fail.
    passWithNoTests: true,
  },
})
