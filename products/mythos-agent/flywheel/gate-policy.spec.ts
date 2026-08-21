import { describe, expect, it } from 'vitest'
import { evaluateReleaseGate } from './gate-policy.js'
import { summarizeCohort } from './analysis.js'

const healthy = {
  cacheReadTokensMean: 0,
  capabilityPassRate: 1,
  capabilitySamples: 3,
  compactionSummariesMean: 0,
  durationMsP50: 10,
  durationMsP95: 20,
  evidenceAfterMutationRate: 1,
  experienceRecoveriesMean: 0,
  failedToolResultsMean: 0,
  inputTokensMean: 1,
  mutationCallsMean: 1,
  maxSubagentCallsPerStepMean: 2,
  outputTokensMean: 1,
  passRate: 1,
  rawCoverage: 1,
  resumeBoundariesMean: 2,
  samples: 3,
  stepsMean: 1,
  timeoutRate: 0,
  toolCallsMean: 2,
  turnsMean: 3,
}

describe('evaluateReleaseGate', () => {
  it('当前 cohort 达到全部门槛时放行', () => {
    expect(evaluateReleaseGate({ 'current:case': healthy }, {
      caseIds: ['case'], cohortPrefix: 'current', maxDurationMsP95: 100, minSamples: 3,
    })).toEqual({ failures: [], passed: true })
  })

  it('汇总缺样本、失败、超时、原始缺失和延迟问题', () => {
    const result = evaluateReleaseGate({
      'current:case': {
        ...healthy,
        durationMsP95: 101,
        compactionSummariesMean: 0,
        evidenceAfterMutationRate: 0.5,
        passRate: 0.5,
        rawCoverage: 0.5,
        samples: 2,
        timeoutRate: 0.5,
        resumeBoundariesMean: 1,
        turnsMean: 2,
        maxSubagentCallsPerStepMean: 1,
      },
    }, {
      caseIds: ['case', 'missing'],
      cohortPrefix: 'current',
      maxDurationMsP95: 100,
      minEvidenceAfterMutationRate: 1,
      minCompactionSummariesMean: 1,
      minMaxSubagentCallsPerStepMean: 2,
      minResumeBoundariesMean: 2,
      minSamples: 3,
      minTurnsMean: 3,
    })
    expect(result.passed).toBe(false)
    expect(result.failures).toHaveLength(11)
  })

  it('三个以上 v1 passed 样本仍无法通过正式 gate', () => {
    const labels = Array.from({ length: 4 }, () => ({
      case: { id: 'case', passed: true }, raw: {}, reportVersion: 1,
    }))
    const summary = summarizeCohort(labels)
    expect(summary).toMatchObject({ capabilitySamples: 0, passRate: 0, samples: 4 })
    expect(evaluateReleaseGate({ 'current:case': summary }, {
      caseIds: ['case'], cohortPrefix: 'current', maxDurationMsP95: 100, minSamples: 3,
    }).passed).toBe(false)
  })
})
