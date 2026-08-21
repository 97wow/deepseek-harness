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
      { case: { accepted: true, durationMs: 10, failure: { category: null }, metrics: { cacheReadTokens: 3, evidenceAfterMutation: true, failedToolResults: 1, inputTokens: 10, mutationCalls: 1, outputTokens: 2, steps: 1, toolCalls: { bash: 2 } }, passed: true }, raw: {}, reportVersion: 2 },
      { case: { accepted: false, durationMs: 30, failure: { category: 'model_failure' }, metrics: { cacheReadTokens: 5, evidenceAfterMutation: false, failedToolResults: 0, inputTokens: 20, mutationCalls: 1, outputTokens: 4, steps: 3, toolCalls: { read: 2, write: 1 } }, passed: false, timedOut: true }, raw: null, reportVersion: 2 },
    ])).toEqual({
      cacheReadTokensMean: 4,
      capabilityPassRate: 0,
      capabilitySamples: 0,
      compactionSummariesMean: 0,
      durationMsP50: 10,
      durationMsP95: 30,
      evidenceAfterMutationRate: 0.5,
      experienceRecoveriesMean: 0,
      failedToolResultsMean: 0.5,
      inputTokensMean: 15,
      mutationCallsMean: 1,
      maxSubagentCallsPerStepMean: 0,
      outputTokensMean: 3,
      passRate: 0,
      rawCoverage: 0.5,
      resumeBoundariesMean: 0,
      samples: 2,
      stepsMean: 2,
      timeoutRate: 0.5,
      toolCallsMean: 2.5,
      turnsMean: 0,
    })
  })

  it('harness 与 infrastructure failure 不计入模型能力分，正式接受率 fail closed', () => {
    const summary = summarizeCohort([
      { case: { accepted: false, failure: { category: null }, passed: true }, raw: {}, reportVersion: 2 },
      { case: { accepted: false, failure: { category: 'model_failure' }, passed: false }, raw: {}, reportVersion: 2 },
      { case: { accepted: false, failure: { category: 'harness_failure' }, passed: false }, raw: {}, reportVersion: 2 },
      { case: { accepted: false, failure: { category: 'infrastructure_failure' }, passed: false }, raw: {}, reportVersion: 2 },
    ])
    expect(summary).toMatchObject({ capabilityPassRate: 0, capabilitySamples: 0, passRate: 0 })
  })
})
