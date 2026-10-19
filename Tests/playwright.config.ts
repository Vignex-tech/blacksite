import { defineConfig, devices } from '@playwright/test'

// The real Colyseus server (server/build) serves client/dist on this port, so
// e2e tests hit the same server players use. Build client/ and server/ first.
const port = Number(process.env.E2E_PORT ?? 2567)

export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Browser pages joinOrCreate the one shared my_room (MAX_CLIENTS 8), so the
  // chromium project runs on one worker: specs must not land in each other's
  // room and change the player counts and boxes they check. The SDK specs
  // only create fresh rooms and join them by id, so they run on up to four
  // workers at once (the height and climbing specs are in parallel mode). Their
  // walks are paced by the 20 Hz move rate, not CPU, so this keeps e2e at
  // about 2 min with the M4 climbing routes (#25, #32).
  workers: 4,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'on-first-retry',
  },
  projects: [
    // Node-side @colyseus/sdk clients against the real server. Runs first, on
    // its own, so browser pages (which joinOrCreate the shared room) can't
    // join its rooms and change the player counts it asserts.
    { name: 'server-integration', testMatch: /\.integration\.spec\.ts$/, workers: 4 },
    {
      name: 'chromium',
      testIgnore: /\.integration\.spec\.ts$/,
      dependencies: ['server-integration'],
      workers: 1,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'node build/index.js',
    cwd: '../server',
    env: { NODE_ENV: 'production', PORT: String(port) },
    // /hi is a plain express route; it answers once the server is listening.
    url: `http://localhost:${port}/hi`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
