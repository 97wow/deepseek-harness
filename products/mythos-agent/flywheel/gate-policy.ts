import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { summarizeByCohort } from './analysis.js'

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
  const cohorts = summarizeByCohort(labels)
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

export async function readArchivedLabels(dataRoot: string): Promise<Record<string, unknown>[]> {
  const root = resolve(dataRoot)
  const index = (await readFile(resolve(root, 'index.jsonl'), 'utf8'))
    .split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
  return await Promise.all(index.map(async row => {
    if (typeof row.label !== 'string') throw new Error('飞轮索引缺少 label 路径')
    const path = resolve(root, row.label)
    if (!path.startsWith(`${root}${sep}`)) throw new Error('飞轮 label 路径越界')
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  }))
}
