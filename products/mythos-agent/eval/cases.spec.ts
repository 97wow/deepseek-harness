import { describe, expect, it } from 'vitest'
import { evaluationCases, selectEvaluationCases } from './cases.js'

describe('selectEvaluationCases', () => {
  it('空参数选择全部用例', () => {
    expect(selectEvaluationCases([])).toBe(evaluationCases)
  })

  it('拒绝未知用例而不是静默忽略', () => {
    expect(() => selectEvaluationCases(['exact-file', 'missing']))
      .toThrow('未知评测用例：missing')
  })
})
