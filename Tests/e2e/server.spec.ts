import { expect, test } from '@playwright/test'

// Playwright's webServer starts the real Colyseus server (NODE_ENV=production).

test('Colyseus server serves the built client at /', async ({ request }) => {
  const res = await request.get('/')
  expect(res.ok()).toBe(true)
  expect(res.headers()['content-type']).toContain('text/html')
  expect(await res.text()).toContain('<div id="app">')
})

test('Colyseus server answers its API route', async ({ request }) => {
  const res = await request.get('/api/hello')
  expect(res.ok()).toBe(true)
  expect(await res.json()).toEqual({ message: 'Hello World' })
})

test('dev-only routes are disabled in production', async ({ request }) => {
  for (const path of ['/playground', '/monitor']) {
    const res = await request.get(path)
    // Falls through to express.static / 404, never the dev tool.
    expect(res.status(), path).toBe(404)
  }
})
