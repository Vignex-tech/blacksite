import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['unit/**/*.test.ts'],
    environment: 'jsdom',
    // No unit tests exist yet (the Vite starter counter test was retired in #3).
    passWithNoTests: true,
  },
})
