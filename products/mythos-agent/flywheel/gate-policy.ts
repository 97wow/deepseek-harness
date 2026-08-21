import type { CohortSummary } from './analysis.js'

export interface GateCriteria {
  caseIds: readonly string[]
  cohortPrefix: string
  maxDurationMsP95: number
  minEvidenceAfterMutationRate?: number
  minSamples: number
}

export interface GateResult {
  failures: string[]
  passed: boolean
}

export function evaluateReleaseGate(
  cohorts: Readonly<Record<string, CohortSummary>>,
  criteria: GateCriteria,
): GateResult {
  const failures: string[] = []
  for (const caseId of criteria.caseIds) {
    const summary = cohorts[`${criteria.cohortPrefix}:${caseId}`]
    if (!summary) {
      failures.push(`${caseId}: 缺少当前配置 cohort`)
      continue
    }
    if (summary.samples < criteria.minSamples) {
      failures.push(`${caseId}: 样本 ${summary.samples}/${criteria.minSamples}`)
    }
    if (summary.passRate !== 1) failures.push(`${caseId}: 通过率 ${summary.passRate}`)
    if (summary.timeoutRate !== 0) failures.push(`${caseId}: 超时率 ${summary.timeoutRate}`)
    if (summary.rawCoverage !== 1) failures.push(`${caseId}: 原始覆盖率 ${summary.rawCoverage}`)
    if (criteria.minEvidenceAfterMutationRate !== undefined
      && summary.evidenceAfterMutationRate < criteria.minEvidenceAfterMutationRate) {
      failures.push(`${caseId}: 修改后验证率 ${summary.evidenceAfterMutationRate}`)
    }
    if (summary.durationMsP95 > criteria.maxDurationMsP95) {
      failures.push(`${caseId}: P95 ${summary.durationMsP95}ms 超过 ${criteria.maxDurationMsP95}ms`)
    }
  }
  return { failures, passed: failures.length === 0 }
}
