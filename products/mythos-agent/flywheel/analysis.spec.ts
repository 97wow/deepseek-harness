import { describe, expect, it } from 'vitest'
import { cohortKey, summarizeCohort } from './analysis.js'

describe('flywheel analysis', () => {
  it('按版本、配置、variant 和用例生成 cohort 键', () => {
    expect(cohortKey({
      baseline: { configurationSha256: 'cfg', dshVersion: 'dsh', mythosVersion: 'mythos', variant: 'high' },
      case: { id: 'bugfix' },
    })).toBe('dsh:mythos:cfg:high:bugfix')
  })

  it('计算通过率、覆盖率、分位数和均值', () => {
    expect(summarizeCohort([
      { case: { durationMs: 10, metrics: { cacheReadTokens: 3, inputTokens: 10, outputTokens: 2, steps: 1 }, passed: true }, raw: {} },
      { case: { durationMs: 30, metrics: { cacheReadTokens: 5, inputTokens: 20, outputTokens: 4, steps: 3 }, passed: false, timedOut: true }, raw: null },
    ])).toEqual({
      cacheReadTokensMean: 4,
      durationMsP50: 10,
      durationMsP95: 30,
      inputTokensMean: 15,
      outputTokensMean: 3,
      passRate: 0.5,
      rawCoverage: 0.5,
      samples: 2,
      stepsMean: 2,
      timeoutRate: 0.5,
    })
  })
})
