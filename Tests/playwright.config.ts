import { defineConfig, devices } from '@playwright/test'

const port = 4173

export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Serves the production build of client/, so run `npm run build` in client/ first.
  webServer: {
    command: `npm run preview -- --port ${port} --strictPort`,
    cwd: '../client',
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
  },
})
