import type { StrategicQuestion } from './types.js'

export interface ProjectReviewSnapshot {
  readonly runId: string
  readonly revision: number
  readonly nowMs: number
  readonly initiative: string
  readonly stage: string
  readonly lastVerifiedProgressAtMs: number
  readonly noProgressLimitMs: number
  readonly budgetUsedRatio: number
  readonly repeatedFailureCount: number
  readonly maxRepeatedFailures: number
  readonly principleViolations: readonly string[]
  readonly evidenceGaps: readonly string[]
  readonly objectiveDrift: readonly string[]
  readonly blockers: readonly string[]
}

export interface ProjectReviewSource {
  snapshot(): Promise<ProjectReviewSnapshot>
}

function unhealthyReasons(snapshot: ProjectReviewSnapshot): string[] {
  return [
    ...(snapshot.nowMs - snapshot.lastVerifiedProgressAtMs >= snapshot.noProgressLimitMs
      ? [`超过 ${String(snapshot.noProgressLimitMs)}ms 没有已验证进展`]
      : []),
    ...(snapshot.budgetUsedRatio >= 1 ? ['预算已耗尽'] : []),
    ...(snapshot.repeatedFailureCount >= snapshot.maxRepeatedFailures
      ? [`连续失败 ${String(snapshot.repeatedFailureCount)} 次`]
      : []),
    ...snapshot.principleViolations.map(item => `原则冲突:${item}`),
    ...snapshot.objectiveDrift.map(item => `目标漂移:${item}`),
  ]
}

/** Convert a whole-project checkpoint into the same auditable decision protocol. */
export function projectReviewQuestion(snapshot: ProjectReviewSnapshot): StrategicQuestion {
  const unhealthy = unhealthyReasons(snapshot)
  const context = [
    `initiative=${snapshot.initiative}`,
    `stage=${snapshot.stage}`,
    `budget-used-ratio=${snapshot.budgetUsedRatio.toFixed(3)}`,
    ...unhealthy,
    ...snapshot.evidenceGaps.map(item => `evidence-gap:${item}`),
    ...snapshot.blockers.map(item => `blocker:${item}`),
  ]

  return {
    id: `project-review:${snapshot.runId}:${String(snapshot.revision)}`,
    runId: snapshot.runId,
    domain: 'product',
    subject: unhealthy.length === 0 ? 'MYTHOS 项目阶段性健康复审' : 'MYTHOS 项目黑洞与目标偏移复审',
    context,
    options: unhealthy.length === 0
      ? [{
          id: 'continue-current-stage',
          action: 'approve',
          summary: '维持当前方向，到下一检查点再次复审。',
          expectedOutcomes: ['继续产生与 MYTHOS 目标一致的可验证进展'],
          risks: snapshot.evidenceGaps,
          principleImpacts: [
            'neutral:harness-before-prompt',
            'supports:evidence-before-claim',
            'neutral:controller-never-executes',
          ],
        }]
      : [{
          id: 'pause-and-replan',
          action: 'pause',
          summary: '暂停当前执行，要求 Lead 围绕目标、证据和失败原因重新规划。',
          expectedOutcomes: ['停止无效消耗', '恢复与 MYTHOS 长期目标一致的执行路径'],
          risks: ['短期推进速度下降'],
          principleImpacts: [
            'supports:harness-before-prompt',
            'supports:evidence-before-claim',
            'supports:controller-never-executes',
          ],
        }],
    recommendedOptionId: unhealthy.length === 0 ? 'continue-current-stage' : 'pause-and-replan',
    requiresExternalAuthority: false,
    irreversible: false,
    evidence: context,
    submittedAtMs: snapshot.nowMs,
  }
}
