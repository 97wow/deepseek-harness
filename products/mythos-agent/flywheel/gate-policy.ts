import { summarizeByCohort } from './analysis.js'
export { readArchivedLabels } from './archive.js'

export interface GateCriteria {
  caseIds: readonly string[]
  cohortPrefix: string
  maxDurationMsP95: number
  minEvidenceAfterMutationRate?: number
  minCompactionSummariesMean?: number
  minMaxSubagentCallsPerStepMean?: number
  minResumeBoundariesMean?: number
  minSamples: number
  minTurnsMean?: number
}

export interface GateResult {
  failures: string[]
  passed: boolean
}

export function evaluateReleaseGate(
  labels: readonly Record<string, unknown>[],
  criteria: GateCriteria,
): GateResult {
  const failures: string[] = []
  const validLabels = Array.isArray(labels) ? labels : []
  const caseIds = Array.isArray(criteria.caseIds)
    ? criteria.caseIds.map(caseId => typeof caseId === 'string' ? caseId.trim() : '')
    : []
  if (validLabels.length === 0) failures.push('insufficient_evidence: 归档为空')
  if (caseIds.length === 0) failures.push('policy_invalid: caseIds 为空')
  if (!Number.isSafeInteger(criteria.minSamples) || criteria.minSamples <= 0) failures.push('policy_invalid: minSamples 必须为正整数')
  if (caseIds.some(caseId => caseId === '')) failures.push('policy_invalid: case ID 为空')
  if (new Set(caseIds).size !== caseIds.length) failures.push('policy_invalid: case ID 重复')
  if (typeof criteria.cohortPrefix !== 'string' || criteria.cohortPrefix.trim() === '') failures.push('policy_invalid: cohortPrefix 为空')
  if (failures.some(failure => failure.startsWith('policy_invalid')) || validLabels.length === 0) return { failures, passed: false }
  const cohorts = summarizeByCohort(validLabels)
  if (Object.keys(cohorts).length === 0) return { failures: [...failures, 'insufficient_evidence: 无有效 cohort'], passed: false }
  for (const caseId of caseIds) {
    const summary = cohorts[`${criteria.cohortPrefix}:${caseId}`]
    if (!summary) {
      failures.push(`insufficient_evidence: ${caseId}: 缺少当前配置 cohort`)
      continue
    }
    if (summary.samples < criteria.minSamples) {
      failures.push(`insufficient_evidence: ${caseId}: 样本 ${summary.samples}/${criteria.minSamples}`)
    }
    if (summary.passRate !== 1) failures.push(`${caseId}: 通过率 ${summary.passRate}`)
    if (summary.timeoutRate !== 0) failures.push(`${caseId}: 超时率 ${summary.timeoutRate}`)
    if (summary.rawCoverage !== 1) failures.push(`${caseId}: 原始覆盖率 ${summary.rawCoverage}`)
    if (criteria.minEvidenceAfterMutationRate !== undefined
      && summary.evidenceAfterMutationRate < criteria.minEvidenceAfterMutationRate) {
      failures.push(`${caseId}: 修改后验证率 ${summary.evidenceAfterMutationRate}`)
    }
    if (criteria.minCompactionSummariesMean !== undefined
      && summary.compactionSummariesMean < criteria.minCompactionSummariesMean) {
      failures.push(`${caseId}: 平均压缩摘要 ${summary.compactionSummariesMean}`)
    }
    if (criteria.minMaxSubagentCallsPerStepMean !== undefined
      && summary.maxSubagentCallsPerStepMean < criteria.minMaxSubagentCallsPerStepMean) {
      failures.push(`${caseId}: 单步最大并行子 Agent 调用均值 ${summary.maxSubagentCallsPerStepMean}`)
    }
    if (criteria.minResumeBoundariesMean !== undefined
      && summary.resumeBoundariesMean < criteria.minResumeBoundariesMean) {
      failures.push(`${caseId}: 平均冷恢复边界 ${summary.resumeBoundariesMean}`)
    }
    if (criteria.minTurnsMean !== undefined && summary.turnsMean < criteria.minTurnsMean) {
      failures.push(`${caseId}: 平均轮次 ${summary.turnsMean}`)
    }
    if (summary.durationMsP95 > criteria.maxDurationMsP95) {
      failures.push(`${caseId}: P95 ${summary.durationMsP95}ms 超过 ${criteria.maxDurationMsP95}ms`)
    }
  }
  return { failures, passed: failures.length === 0 }
}
