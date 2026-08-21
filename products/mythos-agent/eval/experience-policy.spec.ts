import { describe, expect, it } from 'vitest'
import { shouldRecoverPlaceholderTurn } from './journey-turn-runner.js'

describe('shouldRecoverPlaceholderTurn', () => {
  it('识别没有工具证据的占位式结束', () => {
    expect(shouldRecoverPlaceholderTurn([{ seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Let me think about how to handle this effectively.' }] } } }], 1)).toBe(true)
  })

  it('不会重试已有工具行动或有效简短答复', () => {
    expect(shouldRecoverPlaceholderTurn([
      { seq: 2, type: 'tool/call', data: {} },
      { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Let me think.' }] } } },
    ], 1)).toBe(false)
    expect(shouldRecoverPlaceholderTurn([{ seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'JOURNEY_DRIVER_OK' }] } } }], 1)).toBe(false)
  })
})
