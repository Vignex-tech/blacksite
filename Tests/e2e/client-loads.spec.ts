import { expect, test } from '@playwright/test'

test('client loads without console errors', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })

  await page.goto('/')
  await expect(page.locator('#app')).not.toBeEmpty()
  expect(errors).toEqual([])
})
