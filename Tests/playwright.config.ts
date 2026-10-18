import { defineConfig, devices } from '@playwright/test'

// The real Colyseus server (server/build) serves client/dist on this port, so
// e2e tests hit the same server players use. Build client/ and server/ first.
const port = Number(process.env.E2E_PORT ?? 2567)

export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Browser pages joinOrCreate the one shared my_room (maxClients 4). One
  // worker keeps specs from landing in each other's room and changing the
  // player counts and boxes they check (e2e/two-players.spec.ts).
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'on-first-retry',
  },
  projects: [
    // Node-side @colyseus/sdk clients against the real server. Runs first, on
    // its own, so browser pages (which joinOrCreate the shared room) can't
    // join its rooms and change the player counts it asserts.
    { name: 'server-integration', testMatch: /\.integration\.spec\.ts$/ },
    {
      name: 'chromium',
      testIgnore: /\.integration\.spec\.ts$/,
      dependencies: ['server-integration'],
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
