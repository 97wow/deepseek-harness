import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ControllerMemory, ControllerMemoryStore, ProjectState } from './types.js'

export function initialProjectState(nowMs = Date.now()): ProjectState {
  return {
    revision: 1,
    phase: 'M3 + DSH 完整评测与 Mythos Agent harness 建设',
    objectives: [
      '建立 M3 在完整 DSH 工作流中的真实能力基线',
      '以非 prompt 优先的 harness 机制提升稳定性与可验证性',
      '让全量 API 与 DSH 会话数据持续支撑评测、诊断和数据飞轮',
    ],
    activeInitiatives: [
      'Mythos Agent 产品化',
      'M3 真实仓库评测',
      '飞轮数据质量与回归门禁',
      'MYTHOS 总控',
    ],
    knownRisks: [
      '把 MythosV3 中转站与 Mythos Agent 产品混为一谈',
      '在 M3 基线不完整时被参考组结果带偏',
      '依赖 prompt 堆积造成注意力稀释',
      '执行陷入重复尝试、无证据完成或范围扩张的黑洞',
    ],
    validatedFacts: [
      'Mythos Agent 基于 DeepSeek Harness 开发',
      'MythosV3 是服务器中转站，M3 是 Mythos Agent 的最终主底座',
      'Qwen 本地模型是体验参考组，不是最终底座',
      'capture-proxy 与 DSH 会话数据需要最大化保留原始信息',
      '用户明确要求优先使用 prompt 之外的 harness 专业机制',
    ],
    openQuestions: [
      'M3 + DSH 完整评测尚需哪些真实任务族才能形成稳定基线',
      '飞轮数据如何转化为最有效的回归集、错误分类与 harness 改进信号',
    ],
    updatedAtMs: nowMs,
  }
}
export function initialControllerMemory(nowMs = Date.now()): ControllerMemory {
  return { revision: 0, project: initialProjectState(nowMs), decisions: [] }
}

function isMemory(value: unknown): value is ControllerMemory {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Partial<ControllerMemory>
  return Number.isSafeInteger(candidate.revision)
    && typeof candidate.project === 'object' && candidate.project !== null
    && Array.isArray(candidate.decisions)
}

/** Durable cross-session memory; the controller model itself receives no file tools. */
export class FileControllerMemoryStore implements ControllerMemoryStore {
  constructor(private readonly path: string, private readonly now: () => number = Date.now) {}

  async load(): Promise<ControllerMemory> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (!isMemory(parsed)) throw new Error('MYTHOS 总控记忆格式无效')
      return parsed
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return initialControllerMemory(this.now())
      throw error
    }
  }

  async commit(expectedRevision: number, next: ControllerMemory): Promise<void> {
    const current = await this.load()
    if (current.revision !== expectedRevision) {
      throw new Error(`MYTHOS 总控记忆并发冲突：期望 ${String(expectedRevision)}，实际 ${String(current.revision)}`)
    }
    if (next.revision !== expectedRevision + 1) throw new Error('MYTHOS 总控记忆修订号必须严格递增')
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp-${String(process.pid)}-${String(this.now())}`
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.path)
  }
}

export class InMemoryControllerStore implements ControllerMemoryStore {
  private memory: ControllerMemory

  constructor(seed: ControllerMemory = initialControllerMemory()) {
    this.memory = structuredClone(seed)
  }

  async load(): Promise<ControllerMemory> {
    return structuredClone(this.memory)
  }

  async commit(expectedRevision: number, next: ControllerMemory): Promise<void> {
    if (this.memory.revision !== expectedRevision) throw new Error('MYTHOS 总控记忆并发冲突')
    if (next.revision !== expectedRevision + 1) throw new Error('MYTHOS 总控记忆修订号必须严格递增')
    this.memory = structuredClone(next)
  }
}
