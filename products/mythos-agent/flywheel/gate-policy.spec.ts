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

  it('缺少目标 cohort 时 fail closed', () => {
    expect(evaluateReleaseGate([], criteria)).toEqual({ failures: ['case: 缺少当前配置 cohort'], passed: false })
  })
})
