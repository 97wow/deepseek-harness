import { describe, expect, it } from 'vitest'
import {
  evaluationCases,
  productEvaluationCases,
  releaseEvaluationCases,
  selectEvaluationCases,
  selectEvaluationSuite,
} from './cases.js'

describe('selectEvaluationCases', () => {
  it('空参数选择全部用例', () => {
    expect(selectEvaluationCases([])).toBe(evaluationCases)
  })

  it('区分发布、产品与完整套件', () => {
    expect(selectEvaluationSuite(undefined, [])).toBe(releaseEvaluationCases)
    expect(selectEvaluationSuite('product', [])).toBe(productEvaluationCases)
    expect(selectEvaluationSuite('all', [])).toBe(evaluationCases)
    expect(selectEvaluationSuite('product', ['exact-file'])).toEqual([releaseEvaluationCases[0]])
    expect(() => selectEvaluationSuite('missing', [])).toThrow('未知评测套件：missing')
  })

  it('每个用例都有唯一 ID、层级与能力维度', () => {
    expect(new Set(evaluationCases.map(testCase => testCase.id)).size).toBe(evaluationCases.length)
    expect(evaluationCases.every(testCase => testCase.dimensions.length > 0)).toBe(true)
    expect(releaseEvaluationCases.every(testCase => testCase.tier === 'release')).toBe(true)
    expect(productEvaluationCases.every(testCase => testCase.tier === 'product')).toBe(true)
  })

  it('拒绝未知用例而不是静默忽略', () => {
    expect(() => selectEvaluationCases(['exact-file', 'missing']))
      .toThrow('未知评测用例：missing')
  })
})
