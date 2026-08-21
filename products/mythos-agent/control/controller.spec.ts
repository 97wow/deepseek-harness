import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MythosController } from './controller.js'
import { FileControllerMemoryStore, InMemoryControllerStore, initialControllerMemory } from './memory.js'
import { MYTHOS_PROJECT_MODEL } from './project-model.js'
import { projectReviewQuestion, type ProjectReviewSnapshot } from './review.js'
import type { ControllerPort, DecisionOption, StrategicQuestion } from './types.js'
import { ProjectWatchdog } from './watchdog.js'

const NOW = 2_000_000

function port(): ControllerPort {
  return {
    record: vi.fn(async () => undefined),
    directLead: vi.fn(async () => undefined),
    setProjectRunState: vi.fn(async () => undefined),
  }
}

function option(
  id: string,
  principleImpacts: readonly string[],
  risks: readonly string[] = [],
  action: DecisionOption['action'] = 'approve',
): DecisionOption {
  return { id, action, summary: id, expectedOutcomes: [`outcome:${id}`], risks, principleImpacts }
}

function question(overrides: Partial<StrategicQuestion> = {}): StrategicQuestion {
  return {
    id: 'question-1',
    runId: 'run-1',
    domain: 'architecture',
    subject: '选择下一项 Mythos Agent 优化',
    context: ['M3 是最终底座'],
    options: [
      option('harness', [
        'supports:harness-before-prompt',
        'neutral:controller-never-executes',
      ]),
    ],
    recommendedOptionId: 'harness',
    requiresExternalAuthority: false,
    irreversible: false,
    evidence: ['real-repo cohort'],
    submittedAtMs: NOW,
    ...overrides,
  }
}

describe('MYTHOS 项目认知', () => {
  it('明确区分 Agent、V3、M3、参考组、飞轮和总控', () => {
    expect(MYTHOS_PROJECT_MODEL.components.map(item => item.id)).toEqual([
      'mythos-agent',
      'mythos-controller',
      'mythos-v3',
      'm3',
      'qwen-reference',
      'flywheel',
    ])
    expect(MYTHOS_PROJECT_MODEL.principles.map(item => item.id)).toContain('controller-never-executes')
  })
})

describe('MYTHOS 总控战略决策', () => {
  it('批准符合长期目标的 harness 方案并只向 Lead 下令', async () => {
    const controlPort = port()
    const controller = new MythosController(new InMemoryControllerStore(), controlPort)
    const result = await controller.decide(question())
    expect(result.action).toBe('approve')
    expect(result.selectedOptionId).toBe('harness')
    expect(controlPort.directLead).toHaveBeenCalledWith(result)
    expect(Object.keys(controlPort).sort()).toEqual(['directLead', 'record', 'setProjectRunState'])
  })

  it('拒绝以 prompt 堆积替代 harness 的方案', async () => {
    const controller = new MythosController(new InMemoryControllerStore(), port())
    const result = await controller.decide(question({
      options: [option('prompt-pile', [
        'violates:harness-before-prompt',
        'neutral:controller-never-executes',
      ])],
      recommendedOptionId: 'prompt-pile',
    }))
    expect(result.action).toBe('reject')
    expect(result.governingPrinciples).toContain('harness-before-prompt')
  })

  it('拒绝在 M3 基线前让参考组替代主线', async () => {
    const controller = new MythosController(new InMemoryControllerStore(), port())
    const result = await controller.decide(question({
      domain: 'model',
      options: [option('qwen-mainline', [
        'neutral:harness-before-prompt',
        'violates:m3-before-reference-optimization',
      ])],
      recommendedOptionId: 'qwen-mainline',
    }))
    expect(result.action).toBe('reject')
    expect(result.governingPrinciples).toContain('m3-before-reference-optimization')
  })

  it('拒绝破坏原始飞轮真源', async () => {
    const controller = new MythosController(new InMemoryControllerStore(), port())
    const result = await controller.decide(question({
      domain: 'flywheel',
      options: [option('anonymize-and-replace', ['violates:raw-data-first'])],
      recommendedOptionId: 'anonymize-and-replace',
    }))
    expect(result.action).toBe('reject')
    expect(result.governingPrinciples).toContain('raw-data-first')
  })

  it('交付没有证据时要求证据而非批准', async () => {
    const controller = new MythosController(new InMemoryControllerStore(), port())
    const result = await controller.decide(question({
      domain: 'delivery',
      options: [option('release', [
        'neutral:evidence-before-claim',
        'neutral:controller-never-executes',
      ])],
      evidence: [],
    }))
    expect(result.action).toBe('request-evidence')
  })

  it('原则影响缺失时拒绝在不完整输入上决策', async () => {
    const controller = new MythosController(new InMemoryControllerStore(), port())
    const result = await controller.decide(question({
      options: [option('opaque', [])],
    }))
    expect(result.action).toBe('request-replan')
  })

  it('新外部授权与不可逆事项仍交还所有者', async () => {
    const controlPort = port()
    const controller = new MythosController(new InMemoryControllerStore(), controlPort)
    const result = await controller.decide(question({ irreversible: true }))
    expect(result.action).toBe('escalate-owner')
    expect(controlPort.setProjectRunState).toHaveBeenCalledWith('paused', result)
  })
})

describe('MYTHOS 总控长期记忆', () => {
  it('跨实例保留项目认知和决策历史，并使用 0600 数据文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mythos-controller-'))
    const path = join(root, 'memory', 'controller.json')
    const first = new MythosController(new FileControllerMemoryStore(path, () => NOW), port())
    await first.decide(question())

    const secondStore = new FileControllerMemoryStore(path, () => NOW + 1)
    const restored = await secondStore.load()
    expect(restored.revision).toBe(1)
    expect(restored.decisions).toHaveLength(1)
    expect(restored.project.validatedFacts).toContain('Mythos Agent 基于 DeepSeek Harness 开发')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(restored)
  })

  it('拒绝覆盖并发更新的决策历史', async () => {
    const store = new InMemoryControllerStore(initialControllerMemory(NOW))
    const current = await store.load()
    await store.commit(0, { ...current, revision: 1 })
    await expect(store.commit(0, { ...current, revision: 1 })).rejects.toThrow('并发冲突')
  })
})

function review(overrides: Partial<ProjectReviewSnapshot> = {}): ProjectReviewSnapshot {
  return {
    runId: 'run-1',
    revision: 9,
    nowMs: NOW,
    initiative: 'M3 + DSH 完整评测',
    stage: 'real-repo-baseline',
    lastVerifiedProgressAtMs: NOW - 1_000,
    noProgressLimitMs: 60_000,
    budgetUsedRatio: 0.4,
    repeatedFailureCount: 0,
    maxRepeatedFailures: 3,
    principleViolations: [],
    evidenceGaps: [],
    objectiveDrift: [],
    blockers: [],
    ...overrides,
  }
}

describe('MYTHOS 整体项目复审', () => {
  it('健康时继续主线，黑洞或目标漂移时暂停重规划', async () => {
    const healthy = projectReviewQuestion(review())
    const unhealthy = projectReviewQuestion(review({
      lastVerifiedProgressAtMs: NOW - 60_000,
      objectiveDrift: ['开始优化 Qwen，尚未完成 M3 基线'],
    }))
    expect(healthy.options[0]?.action).toBe('approve')
    expect(unhealthy.options[0]?.action).toBe('pause')

    const controlPort = port()
    const controller = new MythosController(new InMemoryControllerStore(), controlPort)
    const result = await controller.decide(unhealthy)
    expect(result.action).toBe('pause')
    expect(controlPort.setProjectRunState).toHaveBeenCalledWith('paused', result)
  })

  it('watchdog 只周期发起治理决策，不拥有 Worker 执行接口', async () => {
    const controller = new MythosController(new InMemoryControllerStore(), port())
    const scheduled: Array<() => void> = []
    const watchdog = new ProjectWatchdog(controller, { snapshot: async () => review() }, {
      intervalMs: 1_000,
      setTimer: callback => {
        scheduled.push(callback)
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => undefined,
    })
    const result = await watchdog.start()
    expect(result.action).toBe('approve')
    expect(scheduled).toHaveLength(1)
    expect(Object.keys(watchdog).sort()).not.toContain('execute')
    watchdog.stop()
  })
})
