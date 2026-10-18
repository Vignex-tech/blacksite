import { describe, expect, it } from 'vitest'
import { setupCounter } from '../../client/src/counter'

describe('setupCounter', () => {
  it('starts at 0 and increments on click', () => {
    const button = document.createElement('button')
    setupCounter(button)
    expect(button.innerHTML).toBe('Count is 0')

    button.click()
    expect(button.innerHTML).toBe('Count is 1')
  })
})
