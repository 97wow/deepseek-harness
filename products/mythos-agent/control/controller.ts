import { MYTHOS_PROJECT_MODEL } from './project-model.js'
import { applyConstitution } from './policy.js'
import type {
  ControllerMemory,
  ControllerMemoryStore,
  ControllerPort,
  StrategicArbiter,
  StrategicDecision,
  StrategicQuestion,
} from './types.js'
import { MYTHOS_CONTROLLER_ID } from './types.js'

export interface MythosControllerOptions {
  readonly arbiter?: StrategicArbiter
  readonly recentDecisionLimit?: number
}

function validateArbitrated(
  proposed: Awaited<ReturnType<StrategicArbiter['decide']>>,
  question: StrategicQuestion,
  viableOptions: ReadonlyMap<string, StrategicQuestion['options'][number]>,
  allowedActions: ReadonlySet<string>,
): void {
  if (proposed.questionId !== question.id) throw new Error('总控仲裁返回了错误的 questionId')
  if (!allowedActions.has(proposed.action)) throw new Error('总控仲裁返回了未授权动作')
  if (proposed.selectedOptionId !== undefined) {
    const selected = viableOptions.get(proposed.selectedOptionId)
    if (selected === undefined) throw new Error('总控仲裁选择了违反宪法或不存在的方案')
    if (selected.action !== proposed.action) throw new Error('总控仲裁动作与所选方案不一致')
  }
  if (proposed.rationale.trim() === '') throw new Error('总控仲裁缺少决策依据')
  if (proposed.directivesForLead.some(item => /总控.*(?:执行|编写|修改|测试|部署)/u.test(item))) {
    throw new Error('总控仲裁试图把执行工作分配给自己')
  }
}

/** Strategic owner proxy. It can decide and direct, but it has no work tools. */
export class MythosController {
  private readonly arbiter: StrategicArbiter | undefined
  private readonly recentDecisionLimit: number
  private inFlight: Promise<StrategicDecision> | undefined

  constructor(
    private readonly store: ControllerMemoryStore,
    private readonly port: ControllerPort,
    options: MythosControllerOptions = {},
  ) {
    this.arbiter = options.arbiter
    this.recentDecisionLimit = options.recentDecisionLimit ?? 12
  }

  async decide(question: StrategicQuestion): Promise<StrategicDecision> {
    const previous = this.inFlight
    if (previous !== undefined) await previous
    const run = this.decideSerial(question)
    this.inFlight = run
    try {
      return await run
    } finally {
      if (this.inFlight === run) this.inFlight = undefined
    }
  }

  private async decideSerial(question: StrategicQuestion): Promise<StrategicDecision> {
    const memory = await this.store.load()
    const governed = applyConstitution(memory, question)
    let strategicDecision = governed.decision

    if (strategicDecision === undefined) {
      if (this.arbiter === undefined) {
        strategicDecision = {
          controller: MYTHOS_CONTROLLER_ID,
          sequence: memory.decisions.length + 1,
          questionId: question.id,
          projectRevision: memory.project.revision,
          action: 'request-replan',
          rationale: '多个合宪方案得分相同，当前没有足够依据替用户作出可靠取舍。',
          governingPrinciples: [],
          requiredEvidence: ['能够区分候选方案长期收益与风险的新增事实'],
          directivesForLead: ['补充差异化证据后重新提交，不得自行选择。'],
          decidedAtMs: question.submittedAtMs,
        }
      } else {
        const recentDecisions = memory.decisions.slice(-this.recentDecisionLimit)
        const proposed = await this.arbiter.decide({
          projectModel: MYTHOS_PROJECT_MODEL,
          projectState: memory.project,
          recentDecisions,
          question,
          allowedActions: governed.allowedActions,
        })
        validateArbitrated(
          proposed,
          question,
          new Map(governed.viableOptions.map(option => [option.id, option])),
          new Set(governed.allowedActions),
        )
        strategicDecision = {
          ...proposed,
          controller: MYTHOS_CONTROLLER_ID,
          sequence: memory.decisions.length + 1,
          projectRevision: memory.project.revision,
          decidedAtMs: question.submittedAtMs,
        }
      }
    }

    await this.persistAndDispatch(memory, strategicDecision)
    return strategicDecision
  }

  private async persistAndDispatch(memory: ControllerMemory, decision: StrategicDecision): Promise<void> {
    await this.store.commit(memory.revision, {
      ...memory,
      revision: memory.revision + 1,
      decisions: [...memory.decisions, decision],
    })
    await this.port.record(decision)
    await this.port.directLead(decision)
    if (decision.action === 'pause' || decision.action === 'escalate-owner') {
      await this.port.setProjectRunState('paused', decision)
    } else if (decision.action === 'stop') {
      await this.port.setProjectRunState('stopped', decision)
    }
  }
}
