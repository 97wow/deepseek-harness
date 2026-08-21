export type StrategicDomain =
  | 'product'
  | 'architecture'
  | 'model'
  | 'evaluation'
  | 'flywheel'
  | 'delivery'
  | 'resources'

export interface ProjectComponent {
  readonly id: string
  readonly role: string
  readonly isNot: readonly string[]
}

export interface ProjectPrinciple {
  readonly id: string
  readonly statement: string
  readonly domains: readonly StrategicDomain[]
  readonly priority: 'constitutional' | 'strategic'
}

export interface MythosProjectModel {
  readonly version: string
  readonly ownerRole: string
  readonly mission: string
  readonly successDefinition: readonly string[]
  readonly components: readonly ProjectComponent[]
  readonly principles: readonly ProjectPrinciple[]
}

/** Stable project truth supplied by the owner, not inferred from one run. */
export const MYTHOS_PROJECT_MODEL = Object.freeze({
  version: 'mythos-project/1',
  ownerRole: 'MYTHOS 总控是用户的代理所有者和最终项目决策层；Lead 与 Worker 负责执行。',
  mission: '基于 DeepSeek Harness 打造 Mythos Agent，并持续利用 M3 与高质量飞轮数据提升真实软件工程任务表现。',
  successDefinition: Object.freeze([
    'Mythos Agent 在真实、多轮、复杂工程任务中稳定完成目标，而非只在提示词样例上表现良好。',
    'M3 是最终主底座；其他本地模型只作为参考组，不替代 M3 的完整基线评测。',
    '评测、生产会话与 API 计费数据形成可追溯的数据飞轮，能够支撑能力诊断、回归和迭代。',
    '系统保留最大化的原始数据与证据，不以默认匿名化或过早清洗损失未来价值。',
    '产品改进优先落在 harness、状态机、工具、记忆、上下文工程、验证和控制机制，而非堆积 prompt。',
  ]),
  components: Object.freeze([
    {
      id: 'mythos-agent',
      role: '当前要开发的用户侧 Agent 产品；以 DSH 为基础，由 M3 驱动并接受总控治理。',
      isNot: Object.freeze(['MythosV3 中转站', '单纯 prompt 模板', '飞轮数据集本身']),
    },
    {
      id: 'mythos-controller',
      role: '代表用户治理整个 MYTHOS 项目，作战略与阶段决策，不执行项目工作。',
      isNot: Object.freeze(['Worker', '编码 Agent', '项目进度机器人']),
    },
    {
      id: 'mythos-v3',
      role: '服务器端中转站系统，并提供可用于 Mythos Agent 迭代的 M3 后端能力。',
      isNot: Object.freeze(['Mythos Agent', 'MYTHOS 总控']),
    },
    {
      id: 'm3',
      role: 'Mythos Agent 的最终主模型底座，必须以完整、真实 DSH 任务评测建立能力基线。',
      isNot: Object.freeze(['Qwen 参考组', 'V3 后端的泛称']),
    },
    {
      id: 'qwen-reference',
      role: '用于比较思维链与工作流体验的本地参考组，不决定最终产品上限。',
      isNot: Object.freeze(['最终底座', 'M3 评测的替代品']),
    },
    {
      id: 'flywheel',
      role: '由 capture-proxy 全量采集、DSH 会话、评测结果和人工判断组成的学习与回归证据系统。',
      isNot: Object.freeze(['Mythos Agent', '只用于 API 计费的日志']),
    },
  ]),
  principles: Object.freeze([
    {
      id: 'harness-before-prompt',
      statement: 'prompt 不是首选优化面；优先使用可验证的 harness 机制，避免注意力稀释和规则竞争。',
      domains: ['architecture', 'product', 'model'] as const,
      priority: 'constitutional',
    },
    {
      id: 'm3-before-reference-optimization',
      statement: '没有完成 M3 + DSH 完整基线前，不得用 Qwen 参考组替代主线判断或盲目对标。',
      domains: ['model', 'evaluation'] as const,
      priority: 'constitutional',
    },
    {
      id: 'raw-data-first',
      statement: '采集层最大化保存原始数据；清理、标注和派生数据不得破坏原始真源。',
      domains: ['flywheel'] as const,
      priority: 'constitutional',
    },
    {
      id: 'evidence-before-claim',
      statement: '任何完成、质量提升和发布判断都必须绑定可复查证据。',
      domains: ['evaluation', 'delivery', 'product'] as const,
      priority: 'constitutional',
    },
    {
      id: 'controller-never-executes',
      statement: '总控只决策、授权、否决、暂停和验收；不得领取或实施任何项目任务。',
      domains: ['product', 'architecture', 'delivery', 'resources'] as const,
      priority: 'constitutional',
    },
    {
      id: 'whole-project-optimization',
      statement: '局部指标改进不得以损害 MYTHOS 长期产品目标、可维护性或数据飞轮为代价。',
      domains: ['product', 'architecture', 'evaluation', 'flywheel', 'delivery', 'resources'] as const,
      priority: 'strategic',
    },
  ]),
} as const satisfies MythosProjectModel)
