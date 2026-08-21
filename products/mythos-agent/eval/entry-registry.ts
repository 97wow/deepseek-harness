export type EvaluationEntry = 'advanced-journey' | 'journey' | 'qwen-local' | 'real-repository' | 'standard'

export type EvaluationEntryId =
  | 'advanced-journey'
  | 'advanced-journey-repeat'
  | 'comprehensive'
  | 'journey'
  | 'journey-repeat'
  | 'm3-smoke'
  | 'qwen-local'
  | 'qwen-local-benchmark'
  | 'real-repository'
  | 'repeat'
  | 'standard'

export interface EvaluationEntryDefinition {
  commitment: EvaluationEntry
  environment: ReadonlyMap<string, string>
  environmentDefaults?: ReadonlyMap<string, string>
  internalDependencies: readonly string[]
  fixedCaseIds?: readonly string[]
  load(): Promise<unknown>
  parameters: {
    caseIds: boolean
    options: ReadonlyMap<string, readonly string[]>
  }
  smokePolicy?: {
    attempts: 1
    concurrency: 1
    maxRetries: 0
    maxTokens: number
    timeoutMs: number
  }
  visibility: 'public'
}

function immutableMap<K, V>(entries: readonly (readonly [K, V])[]): ReadonlyMap<K, V> {
  const storage = new Map(entries)
  let view: ReadonlyMap<K, V>
  view = Object.freeze({
    get size() { return storage.size },
    entries: storage.entries.bind(storage),
    forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) {
      storage.forEach((value, key) => callback.call(thisArg, value, key, view))
    },
    get: storage.get.bind(storage),
    has: storage.has.bind(storage),
    keys: storage.keys.bind(storage),
    values: storage.values.bind(storage),
    [Symbol.iterator]: storage[Symbol.iterator].bind(storage),
  })
  return view
}

const noEnvironment = immutableMap<string, string>([])
const noOptions = immutableMap<string, readonly string[]>([])

const evaluationEntryDefinitions: readonly (readonly [EvaluationEntryId, EvaluationEntryDefinition])[] = [
  ['advanced-journey', {
    commitment: 'advanced-journey', load: async () => await import('./run-advanced-journeys.js'),
    parameters: { caseIds: false, options: noOptions }, environment: noEnvironment, visibility: 'public',
    internalDependencies: ['eval/advanced-journey-configuration.ts', 'eval/advanced-journeys.ts', 'eval/journey-turn-runner.ts',
      'eval/overlays/journey.yml'],
  }],
  ['advanced-journey-repeat', {
    commitment: 'advanced-journey', load: async () => await import('./repeat-advanced-journeys.js'),
    parameters: { caseIds: false, options: noOptions }, environment: noEnvironment, visibility: 'public',
    internalDependencies: ['eval/advanced-journey-configuration.ts', 'eval/advanced-journeys.ts', 'eval/journey-turn-runner.ts',
      'eval/options.ts', 'eval/run-advanced-journeys.ts', 'eval/overlays/journey.yml'],
  }],
  ['comprehensive', {
    commitment: 'standard', load: async () => await import('./run.js'),
    parameters: { caseIds: true, options: noOptions }, environment: immutableMap([['MYTHOS_EVAL_SUITE', 'all']]),
    visibility: 'public',
    internalDependencies: ['eval/cases.ts', 'eval/options.ts', 'eval/run.ts'],
  }],
  ['journey', {
    commitment: 'journey', load: async () => await import('./run-journeys.js'),
    parameters: { caseIds: false, options: noOptions }, environment: noEnvironment, visibility: 'public',
    internalDependencies: ['eval/journey-configuration.ts', 'eval/journey-turn-runner.ts', 'eval/journeys.ts',
      'eval/overlays/journey.yml'],
  }],
  ['journey-repeat', {
    commitment: 'journey', load: async () => await import('./repeat-journeys.js'),
    parameters: { caseIds: false, options: noOptions }, environment: noEnvironment, visibility: 'public',
    internalDependencies: ['eval/journey-configuration.ts', 'eval/journey-turn-runner.ts', 'eval/journeys.ts',
      'eval/options.ts', 'eval/run-journeys.ts', 'eval/overlays/journey.yml'],
  }],
  ['m3-smoke', {
    commitment: 'standard', load: async () => await import('./run.js'),
    parameters: { caseIds: true, options: noOptions },
    environment: immutableMap([
      ['MYTHOS_EVAL_ENTRY', 'standard'], ['MYTHOS_EVAL_PATCH', 'eval/overlays/m3-smoke.yml'],
      ['MYTHOS_EVAL_SUITE', 'release'], ['MYTHOS_EVAL_TIMEOUT_MS', '120000'],
    ]),
    fixedCaseIds: Object.freeze(['exact-file']),
    smokePolicy: Object.freeze({ attempts: 1, concurrency: 1, maxRetries: 0, maxTokens: 4096, timeoutMs: 120000 }),
    visibility: 'public',
    internalDependencies: ['eval/cases.ts', 'eval/options.ts', 'eval/run.ts', 'eval/runtime-evidence.ts',
      'eval/runtime-evidence-observer.ts', 'eval/overlays/runtime-evidence.yml', 'eval/overlays/m3-smoke.yml'],
  }],
  ['qwen-local', {
    commitment: 'qwen-local', load: async () => await import('./run.js'),
    parameters: { caseIds: true, options: noOptions }, environment: immutableMap([
      ['DEEPSEEK_API_KEY', 'mythos-loopback-only'], ['DEEPSEEK_BASE_URL', 'http://127.0.0.1:18080/v1'],
      ['MYTHOS_EVAL_ENTRY', 'qwen-local'], ['MYTHOS_EVAL_MODEL', 'mlx-community/Qwen3.8-27B-4bit@3e6447f082e89cc7f0bc6e5441afd38dfce760ff'],
      ['MYTHOS_EVAL_PATCH', 'eval/overlays/qwen-local.yml'], ['MYTHOS_EVAL_SUITE', 'release'],
      ['MYTHOS_EVAL_VARIANT', 'qwen3.8-27b-mlx-4bit'],
    ]),
    environmentDefaults: immutableMap([['MYTHOS_EVAL_TIMEOUT_MS', '600000']]),
    visibility: 'public',
    internalDependencies: ['eval/cases.ts', 'eval/options.ts', 'eval/run.ts', 'eval/overlays/qwen-local.yml'],
  }],
  ['qwen-local-benchmark', {
    commitment: 'qwen-local', load: async () => await import('./qwen-local-benchmark.js'),
    parameters: { caseIds: false, options: noOptions }, environment: noEnvironment, visibility: 'public',
    internalDependencies: ['eval/run.ts', 'eval/options.ts',
      'eval/cases.ts', 'eval/overlays/qwen-local.yml'],
  }],
  ['real-repository', {
    commitment: 'real-repository', load: async () => await import('./run-real-repo.js'),
    parameters: { caseIds: false, options: noOptions }, environment: noEnvironment, visibility: 'public',
    internalDependencies: ['eval/real-repo-cases.ts', 'eval/real-repo-configuration.ts'],
  }],
  ['repeat', {
    commitment: 'standard', load: async () => await import('./repeat.js'),
    parameters: { caseIds: true, options: immutableMap([['suite', Object.freeze(['all'])]]) },
    environment: immutableMap([['MYTHOS_EVAL_SUITE', 'release']]), visibility: 'public',
    internalDependencies: ['eval/cases.ts', 'eval/options.ts', 'eval/run.ts'],
  }],
  ['standard', {
    commitment: 'standard', load: async () => await import('./run.js'),
    parameters: { caseIds: true, options: noOptions }, environment: immutableMap([['MYTHOS_EVAL_SUITE', 'release']]),
    visibility: 'public',
    internalDependencies: ['eval/cases.ts', 'eval/options.ts'],
  }],
]

for (const [, definition] of evaluationEntryDefinitions) {
  if (definition.environmentDefaults !== undefined) Object.freeze(definition.environmentDefaults)
  Object.freeze(definition.parameters)
  Object.freeze(definition.internalDependencies)
  Object.freeze(definition)
}
Object.freeze(evaluationEntryDefinitions)

export const evaluationEntryRegistry = immutableMap(evaluationEntryDefinitions)

export interface EvaluationLaunchInvocation {
  caseIds: string[]
  entry: EvaluationEntryDefinition
  entryId: EvaluationEntryId
  options: Map<string, string>
}

export interface PublicEvaluationInvocation {
  args: readonly string[]
  entryId: EvaluationEntryId
}

export const publicEvaluationScripts = new Map<string, PublicEvaluationInvocation>([
  ['bench:qwen-local', { args: [], entryId: 'qwen-local-benchmark' }],
  ['eval', { args: [], entryId: 'standard' }],
  ['eval:advanced-journey', { args: [], entryId: 'advanced-journey' }],
  ['eval:advanced-journey:repeat', { args: [], entryId: 'advanced-journey-repeat' }],
  ['eval:comprehensive', { args: [], entryId: 'comprehensive' }],
  ['eval:comprehensive:repeat', { args: ['--suite', 'all'], entryId: 'repeat' }],
  ['eval:journey', { args: [], entryId: 'journey' }],
  ['eval:journey:repeat', { args: [], entryId: 'journey-repeat' }],
  ['eval:m3-smoke', { args: ['exact-file'], entryId: 'm3-smoke' }],
  ['eval:qwen-local', { args: [], entryId: 'qwen-local' }],
  ['eval:real-repo', { args: [], entryId: 'real-repository' }],
  ['eval:repeat', { args: [], entryId: 'repeat' }],
])

export type PackageScriptCategory = 'evaluation' | 'internal-tool' | 'non-eval'

export interface CanonicalPackageScript {
  category: PackageScriptCategory
  command: string
}

const entryIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const caseIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u

export const evaluationRuntimeSourceFiles = Object.freeze([
  'eval/workspace-modules.d.ts', 'eval/entry-registry.ts', 'eval/execution-snapshot.ts', 'eval/launch.ts', 'eval/run.ts',
  'eval/run-journeys.ts', 'eval/journeys.ts', 'eval/journey-configuration.ts', 'eval/journey-turn-runner.ts',
  'eval/repeat-journeys.ts', 'eval/advanced-journeys.ts', 'eval/advanced-journey-configuration.ts',
  'eval/run-advanced-journeys.ts', 'eval/repeat-advanced-journeys.ts', 'eval/real-repo-cases.ts',
  'eval/real-repo-configuration.ts', 'eval/run-real-repo.ts', 'eval/qwen-local-benchmark.ts', 'eval/repeat.ts',
  'eval/cases.ts', 'eval/options.ts', 'eval/session-metrics.ts', 'eval/runtime-evidence.ts',
  'eval/runtime-evidence-observer.ts', 'flywheel/analysis.ts', 'flywheel/analyze.ts',
  'flywheel/archive.ts', 'flywheel/build.ts', 'flywheel/comprehensive-gate.ts', 'flywheel/journey-gate.ts',
  'flywheel/advanced-journey-gate.ts', 'flywheel/real-repo-scope-gate.ts', 'flywheel/gate-policy.ts', 'flywheel/gate.ts',
  'flywheel/server-dataset.ts', 'flywheel/server-import.ts', 'flywheel/server-analyze.ts', 'flywheel/server-gate.ts',
  'flywheel/session-curation.ts', 'flywheel/session-curate.ts', 'product/config.ts', 'product/launch.ts',
  'product/smoke-web.ts', 'release/check.ts', 'release/pack.ts', 'release/security.ts', 'release/verify.ts',
] as const)

const typecheckCommand = ['tsc', '--ignoreConfig', '--noEmit', '--target', 'ES2023', '--module', 'NodeNext',
  '--moduleResolution', 'NodeNext', '--types', 'node', ...evaluationRuntimeSourceFiles].join(' ')

export function canonicalEvaluationCommand(scriptName: string): string {
  const definition = publicEvaluationScripts.get(scriptName)
  if (definition === undefined) throw new Error(`未知公开评测 script：${scriptName}`)
  parseEvaluationLaunchArguments([definition.entryId, ...definition.args])
  return ['tsx', 'eval/launch.ts', definition.entryId, ...definition.args].join(' ')
}

export const canonicalPackageScripts = new Map<string, CanonicalPackageScript>([
  ['agent', { category: 'non-eval', command: 'tsx product/launch.ts headless' }],
  ...[...publicEvaluationScripts.keys()].map((name): [string, CanonicalPackageScript] =>
    [name, { category: 'evaluation', command: canonicalEvaluationCommand(name) }]),
  ['flywheel:analyze', { category: 'internal-tool', command: 'tsx flywheel/analyze.ts' }],
  ['flywheel:build', { category: 'internal-tool', command: 'tsx flywheel/build.ts' }],
  ['flywheel:server:analyze', { category: 'internal-tool', command: 'tsx flywheel/server-analyze.ts' }],
  ['flywheel:server:gate', { category: 'internal-tool', command: 'tsx flywheel/server-gate.ts' }],
  ['flywheel:server:import', { category: 'internal-tool', command: 'tsx flywheel/server-import.ts' }],
  ['flywheel:session:curate', { category: 'internal-tool', command: 'tsx flywheel/session-curate.ts' }],
  ['gate', { category: 'internal-tool', command: 'tsx flywheel/gate.ts' }],
  ['gate:advanced-journey', { category: 'internal-tool', command: 'tsx flywheel/advanced-journey-gate.ts' }],
  ['gate:comprehensive', { category: 'internal-tool', command: 'tsx flywheel/comprehensive-gate.ts' }],
  ['gate:journey', { category: 'internal-tool', command: 'tsx flywheel/journey-gate.ts' }],
  ['gate:real-repo-scope', { category: 'internal-tool', command: 'tsx flywheel/real-repo-scope-gate.ts' }],
  ['release:check', { category: 'internal-tool', command: 'tsx release/check.ts' }],
  ['release:pack', { category: 'internal-tool', command: 'tsx release/pack.ts' }],
  ['release:verify', { category: 'internal-tool', command: 'tsx release/verify.ts' }],
  ['smoke:web', { category: 'non-eval', command: 'tsx product/smoke-web.ts' }],
  ['test', { category: 'internal-tool', command: 'vitest run --config vitest.config.ts' }],
  ['typecheck:control', { category: 'internal-tool', command: 'tsc --ignoreConfig --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --types node control/index.ts control/controller.ts control/memory.ts control/policy.ts control/project-model.ts control/review.ts control/watchdog.ts' }],
  ['typecheck', { category: 'internal-tool', command: typecheckCommand }],
  ['web', { category: 'non-eval', command: 'tsx product/launch.ts web' }],
])

export function parseEvaluationLaunchArguments(argv: readonly string[]): EvaluationLaunchInvocation {
  const [rawEntryId, ...parameters] = argv
  if (rawEntryId === undefined || !entryIdPattern.test(rawEntryId)) throw new Error('未知或空评测 entry ID')
  const entry = evaluationEntryRegistry.get(rawEntryId as EvaluationEntryId)
  if (entry === undefined || entry.visibility !== 'public') throw new Error('未知、空或不可启动的评测 entry ID')
  const entryId = rawEntryId as EvaluationEntryId
  const options = new Map<string, string>()
  const caseIds: string[] = []
  let encounteredCaseId = false
  for (let index = 0; index < parameters.length; index += 1) {
    const parameter = parameters[index]!
    if (parameter === '') throw new Error('评测参数不能为空')
    if (parameter.startsWith('--')) {
      if (encounteredCaseId) throw new Error('评测 option 必须位于 case ID 之前')
      const name = parameter.slice(2)
      const allowed = entry.parameters.options.get(name)
      const value = parameters[index + 1]
      if (allowed === undefined || value === undefined || value === '' || value.startsWith('--') || !allowed.includes(value)) {
        throw new Error('未声明或无效的评测 option')
      }
      if (options.has(name)) throw new Error('评测 option 不得重复')
      options.set(name, value)
      index += 1
      continue
    }
    encounteredCaseId = true
    if (!entry.parameters.caseIds || !caseIdPattern.test(parameter) || caseIds.includes(parameter)) {
      throw new Error('未声明、动态或重复的评测 case 参数')
    }
    caseIds.push(parameter)
  }
  if (entry.fixedCaseIds !== undefined
    && JSON.stringify(caseIds) !== JSON.stringify(entry.fixedCaseIds)) throw new Error('评测 entry 的固定 case 集合不匹配')
  return { caseIds, entry, entryId, options }
}

export function validateEvaluationRegistry(
  entries: ReadonlyMap<string, EvaluationEntryDefinition> = evaluationEntryRegistry,
  invocations: ReadonlyMap<string, PublicEvaluationInvocation> = publicEvaluationScripts,
): void {
  const references = new Map<string, number>()
  for (const [scriptName, invocation] of invocations) {
    const entry = entries.get(invocation.entryId)
    if (entry === undefined || entry.visibility !== 'public') throw new Error(`公开 script 引用了未知或内部 entry：${scriptName}`)
    references.set(invocation.entryId, (references.get(invocation.entryId) ?? 0) + 1)
  }
  for (const [entryId, entry] of entries) {
    if (!entryIdPattern.test(entryId)) throw new Error(`entry ID 不符合规范：${entryId}`)
    if (entry.visibility !== 'public') throw new Error(`禁止独立 internal entry：${entryId}`)
    if (!references.has(entryId)) throw new Error(`公开 entry 没有 script invocation：${entryId}`)
  }
}

export function validatePackageEvaluationScripts(scripts: Readonly<Record<string, string>>): void {
  validateEvaluationRegistry()
  const actualNames = Object.keys(scripts)
  if (actualNames.length !== canonicalPackageScripts.size) throw new Error('package scripts 与结构化策略键集合不匹配')
  for (const [scriptName, policy] of canonicalPackageScripts) {
    if (!Object.hasOwn(scripts, scriptName) || scripts[scriptName] !== policy.command) {
      throw new Error(`package script 与结构化策略不匹配：${scriptName}`)
    }
  }
  for (const scriptName of actualNames) {
    if (!canonicalPackageScripts.has(scriptName)) throw new Error(`package script 未纳入结构化策略：${scriptName}`)
  }
}

export function registryEntryIdsForCommitment(entry: EvaluationEntry): EvaluationEntryId[] {
  return [...evaluationEntryRegistry]
    .filter(([, definition]) => definition.commitment === entry)
    .map(([entryId]) => entryId)
}
