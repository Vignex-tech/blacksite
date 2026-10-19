// E2E TIME BUDGET (#65, milestone 7)
// - Before #65: the CI "Tests - e2e" step took 4.8 min (about 5 min locally),
//   because the chromium project is serial (shared my_room) and ran after the
//   SDK specs on one machine.
// - Now: the same 68 tests run as three parallel CI jobs (shards, see
//   scripts/e2e-shard.mjs and .github/workflows/ci.yml): server-integration
//   (4 workers), browser-a and browser-b (about 100 s of serial tab time
//   each). The slowest shard is the wall time; target <= 3.3 min.
// - Hard ceiling at the M7 gate: 4.0 min for the slowest shard.
// - Rule: a new spec states its added wall time in its closing comment, and
//   says which shard it runs in (a new browser spec lands in browser-b unless
//   listed in BROWSER_A in scripts/e2e-shard.mjs).
// - The workers and projects below still apply to a plain "npm run test:e2e".
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
