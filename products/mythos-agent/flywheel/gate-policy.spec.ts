import { describe, expect, it } from 'vitest'
import { evaluateReleaseGate } from './gate-policy.js'

const criteria = { caseIds: ['case'], cohortPrefix: 'd:m:c:v', maxDurationMsP95: 100, minSamples: 3 }

function label(reportVersion: 1 | 2, testCase: Record<string, unknown>): Record<string, unknown> {
  return {
    baseline: { configurationSha256: 'c', dshVersion: 'd', mythosVersion: 'm', variant: 'v' },
    case: { durationMs: 10, id: 'case', metrics: {}, ...testCase },
    raw: {},
    reportVersion,
  }
}

describe('evaluateReleaseGate', () => {
  it('三个以上 v1 passed 样本仍无法通过正式 gate', () => {
    const labels = Array.from({ length: 4 }, () => label(1, { passed: true }))
    expect(evaluateReleaseGate(labels, criteria).passed).toBe(false)
  })

  it('不接受调用方伪造的 accepted、failure 与 capability 字段', () => {
    const labels = Array.from({ length: 3 }, () => label(2, {
      accepted: true,
      capabilityEligible: true,
      failure: { category: null, reason: null },
      passed: true,
    }))
    expect(evaluateReleaseGate(labels, criteria)).toMatchObject({ passed: false })
  })

  it('空归档以 insufficient_evidence fail closed', () => {
    expect(evaluateReleaseGate([], criteria)).toEqual({ failures: ['insufficient_evidence: 归档为空'], passed: false })
  })

  it.each([
    [{ ...criteria, caseIds: [] }, 'caseIds 为空'],
    [{ ...criteria, caseIds: [''] }, 'case ID 为空'],
    [{ ...criteria, caseIds: ['case', 'case'] }, 'case ID 重复'],
    [{ ...criteria, minSamples: 0 }, 'minSamples'],
    [{ ...criteria, minSamples: -1 }, 'minSamples'],
  ])('非法或空策略 %# 返回 policy_invalid', (invalid, reason) => {
    const result = evaluateReleaseGate([label(1, { passed: true })], invalid)
    expect(result.passed).toBe(false)
    expect(result.failures.join('\n')).toContain(`policy_invalid: ${reason}`)
  })

  it('无有效目标 cohort 返回 insufficient_evidence', () => {
    const result = evaluateReleaseGate([label(1, { passed: true })], { ...criteria, cohortPrefix: 'missing' })
    expect(result).toMatchObject({ passed: false, failures: [expect.stringContaining('insufficient_evidence')] })
  })
})
