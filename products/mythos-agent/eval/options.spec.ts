import { describe, expect, it } from 'vitest'
import { DEFAULT_EVALUATION_TIMEOUT_MS, parseEvaluationTimeoutMs } from './options.js'

describe('parseEvaluationTimeoutMs', () => {
  it('使用五分钟默认值', () => {
    expect(parseEvaluationTimeoutMs(undefined)).toBe(DEFAULT_EVALUATION_TIMEOUT_MS)
  })

  it.each(['0', '999', '1.5', '3600001', 'nope'])('拒绝无效值 %s', (value) => {
    expect(() => parseEvaluationTimeoutMs(value)).toThrow('MYTHOS_EVAL_TIMEOUT_MS')
  })
})
