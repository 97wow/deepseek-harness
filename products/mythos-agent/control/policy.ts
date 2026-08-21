import { MYTHOS_PROJECT_MODEL } from './project-model.js'
import type { ProjectPrinciple, StrategicDomain } from './project-model.js'
import type {
  ControllerMemory,
  DecisionOption,
  StrategicAction,
  StrategicDecision,
  StrategicQuestion,
} from './types.js'
import { MYTHOS_CONTROLLER_ID } from './types.js'

const ALLOWED_ACTIONS: readonly StrategicAction[] = Object.freeze([
  'approve',
  'reject',
  'request-replan',
  'request-evidence',
  'pause',
  'stop',
  'accept-stage',
  'escalate-owner',
])

export interface PolicyResult {
  readonly decision?: StrategicDecision
  readonly viableOptions: readonly DecisionOption[]
  readonly allowedActions: readonly StrategicAction[]
}

function principle(id: string): ProjectPrinciple | undefined {
  return MYTHOS_PROJECT_MODEL.principles.find(item => item.id === id)
}

function violations(option: DecisionOption): ProjectPrinciple[] {
  return option.principleImpacts
    .filter(impact => impact.startsWith('violates:'))
    .map(impact => principle(impact.slice('violates:'.length)))
    .filter((item): item is ProjectPrinciple => item !== undefined)
}

function supports(option: DecisionOption): ProjectPrinciple[] {
  return option.principleImpacts
    .filter(impact => impact.startsWith('supports:'))
    .map(impact => principle(impact.slice('supports:'.length)))
    .filter((item): item is ProjectPrinciple => item !== undefined)
}

function decision(
  memory: ControllerMemory,
  question: StrategicQuestion,
  action: StrategicAction,
  rationale: string,
  fields: Partial<Pick<StrategicDecision, 'selectedOptionId' | 'governingPrinciples' | 'requiredEvidence' | 'directivesForLead'>> = {},
): StrategicDecision {
  return {
    controller: MYTHOS_CONTROLLER_ID,
    sequence: memory.decisions.length + 1,
    questionId: question.id,
    projectRevision: memory.project.revision,
    action,
    rationale,
    governingPrinciples: fields.governingPrinciples ?? [],
    requiredEvidence: fields.requiredEvidence ?? [],
    directivesForLead: fields.directivesForLead ?? [],
    decidedAtMs: question.submittedAtMs,
    ...(fields.selectedOptionId === undefined ? {} : { selectedOptionId: fields.selectedOptionId }),
  }
}

function score(option: DecisionOption, recommendedOptionId: string | undefined): number {
  return supports(option).reduce((sum, item) => sum + (item.priority === 'constitutional' ? 8 : 3), 0)
    - violations(option).reduce((sum, item) => sum + (item.priority === 'constitutional' ? 100 : 10), 0)
    - option.risks.length
    + (option.id === recommendedOptionId ? 1 : 0)
}

export function applyConstitution(memory: ControllerMemory, question: StrategicQuestion): PolicyResult {
  if (question.requiresExternalAuthority || question.irreversible) {
    return {
      decision: decision(
        memory,
        question,
        'escalate-owner',
        '议题需要新的外部授权或包含不可逆后果，超出总控可自主代行的既有项目权限。',
        { directivesForLead: ['冻结相关执行，保持现状，等待所有者确认。'] },
      ),
      viableOptions: [],
      allowedActions: ALLOWED_ACTIONS,
    }
  }

  if (question.options.length === 0) {
    return {
      decision: decision(memory, question, 'request-replan', '没有可比较的决策选项，不能把模糊议题伪装成项目决策。', {
        directivesForLead: ['提交至少一个包含预期结果、风险、原则影响和验收证据的方案。'],
      }),
      viableOptions: [],
      allowedActions: ALLOWED_ACTIONS,
    }
  }

  const relevantPrinciples = MYTHOS_PROJECT_MODEL.principles.filter(item =>
    item.priority === 'constitutional'
    && (item.domains as readonly StrategicDomain[]).includes(question.domain))
  const incomplete = question.options.filter(option => relevantPrinciples.some(item =>
    !option.principleImpacts.some(impact =>
      impact === `supports:${item.id}` || impact === `violates:${item.id}` || impact === `neutral:${item.id}`)))
  if (incomplete.length > 0) {
    return {
      decision: decision(memory, question, 'request-replan', '候选方案没有逐项声明对相关项目原则的影响，决策输入不完整。', {
        governingPrinciples: relevantPrinciples.map(item => item.id),
        directivesForLead: [
          `为方案 ${incomplete.map(item => item.id).join(', ')} 补齐 supports/violates/neutral 原则影响。`,
        ],
      }),
      viableOptions: [],
      allowedActions: ALLOWED_ACTIONS,
    }
  }

  const viableOptions = question.options.filter(option =>
    violations(option).every(item => item.priority !== 'constitutional'))
  if (viableOptions.length === 0) {
    const violated = [...new Set(question.options.flatMap(option => violations(option).map(item => item.id)))]
    return {
      decision: decision(memory, question, 'reject', '所有候选方案都违反 MYTHOS 的不可变原则，必须重做方案。', {
        governingPrinciples: violated,
        directivesForLead: ['保持当前系统不变，围绕被违反的原则重新提出 harness 级方案。'],
      }),
      viableOptions,
      allowedActions: ALLOWED_ACTIONS,
    }
  }

  const ranked = [...viableOptions].sort((left, right) => score(right, question.recommendedOptionId) - score(left, question.recommendedOptionId))
  const best = ranked[0]
  const tied = ranked[1] !== undefined && score(best, question.recommendedOptionId) === score(ranked[1], question.recommendedOptionId)
  if (tied) return { viableOptions, allowedActions: ALLOWED_ACTIONS }

  if ((question.domain === 'evaluation' || question.domain === 'delivery') && question.evidence.length === 0) {
    return {
      decision: decision(memory, question, 'request-evidence', '评测或交付决策缺少客观证据，不能批准。', {
        selectedOptionId: best.id,
        governingPrinciples: ['evidence-before-claim'],
        requiredEvidence: ['可复查的测试、评测、运行或发布验证结果'],
        directivesForLead: ['补齐证据后，用同一 questionId 重新提交。'],
      }),
      viableOptions,
      allowedActions: ALLOWED_ACTIONS,
    }
  }

  const governedBy = [
    ...supports(best).map(item => item.id),
    ...violations(best).map(item => item.id),
  ]
  return {
    decision: decision(memory, question, best.action, '该方案在当前项目状态下最符合 MYTHOS 的长期目标与原则。', {
      selectedOptionId: best.id,
      governingPrinciples: [...new Set(governedBy)],
      requiredEvidence: question.evidence,
      directivesForLead: [
        `执行获批方案 ${best.id}，不得扩大已提交范围。`,
        '到达下一阶段门禁时提交结果、失败和证据，由总控重新决策。',
      ],
    }),
    viableOptions,
    allowedActions: ALLOWED_ACTIONS,
  }
}
