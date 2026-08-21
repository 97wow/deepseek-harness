export type EvaluationEntry = 'advanced-journey' | 'journey' | 'qwen-local' | 'real-repository' | 'standard'

export type EvaluationEntryId =
  | 'advanced-journey'
  | 'advanced-journey-repeat'
  | 'comprehensive'
  | 'journey'
  | 'journey-repeat'
  | 'qwen-local'
  | 'qwen-local-benchmark'
  | 'real-repository'
  | 'repeat'
  | 'standard'

export interface ScopedDependencyPath {
  path: string
  scope: 'product' | 'workspace'
}

export type DynamicDependencyRoot = {
  kind: 'file'
  loader: ScopedDependencyPath
  root: ScopedDependencyPath
} | {
  kind: 'workspace-package'
  loader: ScopedDependencyPath
  manifest: string
  packageName: string
  sourceEntry: string
}

export interface EvaluationEntryDefinition {
  commitment: EvaluationEntry
  dynamicDependencyRoots: readonly DynamicDependencyRoot[]
  environment: ReadonlyMap<string, string>
  internalDependencies: readonly string[]
  module: `eval/${string}.ts`
  parameters: {
    caseIds: boolean
    options: ReadonlyMap<string, readonly string[]>
  }
  visibility: 'public'
}

const noEnvironment = new Map<string, string>()
const noOptions = new Map<string, readonly string[]>()
const launcherLoader = { path: 'eval/launch.ts', scope: 'product' } as const
const journeyLoader = { path: 'eval/journey-turn-runner.ts', scope: 'product' } as const

function launcherDependency(module: `eval/${string}.ts`): DynamicDependencyRoot {
  return { kind: 'file', loader: launcherLoader, root: { path: module, scope: 'product' } }
}

const journeyWorkspaceDependencies: readonly DynamicDependencyRoot[] = [
  { kind: 'workspace-package', loader: journeyLoader, packageName: '@deepseek-ai/dsh-agent',
    manifest: 'packages/core/agent/package.json', sourceEntry: 'packages/core/agent/src/index.ts' },
  { kind: 'workspace-package', loader: journeyLoader, packageName: '@deepseek-ai/dsh-llm',
    manifest: 'packages/llm/llm/package.json', sourceEntry: 'packages/llm/llm/src/index.ts' },
  { kind: 'workspace-package', loader: journeyLoader, packageName: '@deepseek-ai/dsh-session',
    manifest: 'packages/core/session/package.json', sourceEntry: 'packages/core/session/src/index.ts' },
]

export const evaluationEntryRegistry = new Map<EvaluationEntryId, EvaluationEntryDefinition>([
  ['advanced-journey', {
    commitment: 'advanced-journey', module: 'eval/run-advanced-journeys.ts',
    parameters: { caseIds: false, options: noOptions }, environment: noEnvironment, visibility: 'public',
    dynamicDependencyRoots: [launcherDependency('eval/run-advanced-journeys.ts'), ...journeyWorkspaceDependencies],
    internalDependencies: ['eval/advanced-journey-configuration.ts', 'eval/advanced-journeys.ts', 'eval/journey-turn-runner.ts',
      'eval/run-advanced-journeys.ts', 'eval/overlays/journey.yml'],
  }],
  ['advanced-journey-repeat', {
    commitment: 'advanced-journey', module: 'eval/repeat-advanced-journeys.ts',
    parameters: { caseIds: false, options: noOptions }, environment: noEnvironment, visibility: 'public',
    dynamicDependencyRoots: [launcherDependency('eval/repeat-advanced-journeys.ts'), ...journeyWorkspaceDependencies],
    internalDependencies: ['eval/advanced-journey-configuration.ts', 'eval/advanced-journeys.ts', 'eval/journey-turn-runner.ts',
      'eval/options.ts', 'eval/repeat-advanced-journeys.ts', 'eval/run-advanced-journeys.ts', 'eval/overlays/journey.yml'],
  }],
  ['comprehensive', {
    commitment: 'standard', module: 'eval/run-comprehensive.ts',
    parameters: { caseIds: true, options: noOptions }, environment: new Map([['MYTHOS_EVAL_SUITE', 'all']]),
    visibility: 'public', dynamicDependencyRoots: [launcherDependency('eval/run-comprehensive.ts')],
    internalDependencies: ['eval/cases.ts', 'eval/options.ts', 'eval/run-comprehensive.ts', 'eval/run.ts'],
  }],
  ['journey', {
    commitment: 'journey', module: 'eval/run-journeys.ts',
    parameters: { caseIds: false, options: noOptions }, environment: noEnvironment, visibility: 'public',
    dynamicDependencyRoots: [launcherDependency('eval/run-journeys.ts'), ...journeyWorkspaceDependencies],
    internalDependencies: ['eval/journey-configuration.ts', 'eval/journey-turn-runner.ts', 'eval/journeys.ts',
      'eval/run-journeys.ts', 'eval/overlays/journey.yml'],
  }],
  ['journey-repeat', {
    commitment: 'journey', module: 'eval/repeat-journeys.ts',
    parameters: { caseIds: false, options: noOptions }, environment: noEnvironment, visibility: 'public',
    dynamicDependencyRoots: [launcherDependency('eval/repeat-journeys.ts'), ...journeyWorkspaceDependencies],
    internalDependencies: ['eval/journey-configuration.ts', 'eval/journey-turn-runner.ts', 'eval/journeys.ts',
      'eval/options.ts', 'eval/repeat-journeys.ts', 'eval/run-journeys.ts', 'eval/overlays/journey.yml'],
  }],
  ['qwen-local', {
    commitment: 'qwen-local', module: 'eval/run-qwen-local.ts',
    parameters: { caseIds: true, options: noOptions }, environment: new Map([['MYTHOS_EVAL_SUITE', 'release']]),
    visibility: 'public', dynamicDependencyRoots: [launcherDependency('eval/run-qwen-local.ts')],
    internalDependencies: ['eval/cases.ts', 'eval/options.ts', 'eval/run-qwen-local.ts', 'eval/run.ts', 'eval/overlays/qwen-local.yml'],
  }],
  ['qwen-local-benchmark', {
    commitment: 'qwen-local', module: 'eval/qwen-local-benchmark.ts',
    parameters: { caseIds: false, options: noOptions }, environment: noEnvironment, visibility: 'public',
    dynamicDependencyRoots: [launcherDependency('eval/qwen-local-benchmark.ts')],
    internalDependencies: ['eval/qwen-local-benchmark.ts', 'eval/run-qwen-local.ts', 'eval/run.ts', 'eval/options.ts',
      'eval/cases.ts', 'eval/overlays/qwen-local.yml'],
  }],
  ['real-repository', {
    commitment: 'real-repository', module: 'eval/run-real-repo.ts',
    parameters: { caseIds: false, options: noOptions }, environment: noEnvironment, visibility: 'public',
    dynamicDependencyRoots: [launcherDependency('eval/run-real-repo.ts')],
    internalDependencies: ['eval/real-repo-cases.ts', 'eval/real-repo-configuration.ts', 'eval/run-real-repo.ts'],
  }],
  ['repeat', {
    commitment: 'standard', module: 'eval/repeat.ts',
    parameters: { caseIds: true, options: new Map([['suite', ['all']]]) },
    environment: new Map([['MYTHOS_EVAL_SUITE', 'release']]), visibility: 'public',
    dynamicDependencyRoots: [launcherDependency('eval/repeat.ts')],
    internalDependencies: ['eval/cases.ts', 'eval/options.ts', 'eval/repeat.ts', 'eval/run-comprehensive.ts', 'eval/run.ts'],
  }],
  ['standard', {
    commitment: 'standard', module: 'eval/run.ts',
    parameters: { caseIds: true, options: noOptions }, environment: new Map([['MYTHOS_EVAL_SUITE', 'release']]),
    visibility: 'public', dynamicDependencyRoots: [launcherDependency('eval/run.ts')],
    internalDependencies: ['eval/cases.ts', 'eval/options.ts', 'eval/run.ts'],
  }],
])

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
const dependencyPathSegmentPattern = /^[a-zA-Z0-9._@-]+$/u

const typecheckCommand = 'tsc --ignoreConfig --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --types node eval/entry-registry.ts eval/import-closure.ts eval/launch.ts eval/run.ts eval/run-comprehensive.ts eval/run-journeys.ts eval/journeys.ts eval/journey-configuration.ts eval/journey-turn-runner.ts eval/repeat-journeys.ts eval/advanced-journeys.ts eval/advanced-journey-configuration.ts eval/run-advanced-journeys.ts eval/repeat-advanced-journeys.ts eval/real-repo-cases.ts eval/real-repo-configuration.ts eval/run-real-repo.ts eval/run-qwen-local.ts eval/qwen-local-benchmark.ts eval/repeat.ts eval/cases.ts eval/options.ts eval/session-metrics.ts flywheel/analysis.ts flywheel/analyze.ts flywheel/archive.ts flywheel/build.ts flywheel/comprehensive-gate.ts flywheel/journey-gate.ts flywheel/advanced-journey-gate.ts flywheel/real-repo-scope-gate.ts flywheel/gate-policy.ts flywheel/gate.ts flywheel/server-dataset.ts flywheel/server-import.ts flywheel/server-analyze.ts flywheel/server-gate.ts flywheel/session-curation.ts flywheel/session-curate.ts product/config.ts product/launch.ts product/smoke-web.ts release/check.ts release/pack.ts release/security.ts release/verify.ts'

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
    if (entry.dynamicDependencyRoots.length === 0) throw new Error(`公开 entry 缺少 launcher 动态依赖：${entryId}`)
    const rootKeys = new Set<string>()
    let launcherRoots = 0
    for (const root of entry.dynamicDependencyRoots) {
      const paths = root.kind === 'file' ? [root.loader.path, root.root.path] : [root.loader.path, root.manifest, root.sourceEntry]
      if (paths.some(path => path.split('/').some(segment => segment === '' || segment === '.' || segment === '..'
        || !dependencyPathSegmentPattern.test(segment)))) {
        throw new Error(`动态依赖路径不符合规范：${entryId}`)
      }
      if (root.loader.scope === 'product' && root.loader.path !== 'eval/launch.ts'
        && !entry.internalDependencies.includes(root.loader.path)) {
        throw new Error(`动态依赖 loader 未由 public entry 反向引用：${entryId}`)
      }
      if (root.kind === 'workspace-package'
        && (root.loader.scope !== 'product' || !/^@[a-z0-9-]+\/[a-z0-9-]+$/u.test(root.packageName))) {
        throw new Error(`workspace package 动态依赖声明无效：${entryId}`)
      }
      const key = root.kind === 'file' ? `file:${root.root.scope}:${root.root.path}` : `package:${root.packageName}`
      if (rootKeys.has(key)) throw new Error(`动态依赖 root 重复：${entryId}`)
      rootKeys.add(key)
      if (root.kind === 'file' && root.loader.scope === 'product' && root.loader.path === 'eval/launch.ts') {
        launcherRoots += 1
        if (root.root.scope !== 'product' || root.root.path !== entry.module) {
          throw new Error(`launcher 动态 root 与 entry module 不一致：${entryId}`)
        }
      }
    }
    if (launcherRoots !== 1) throw new Error(`public entry 必须且只能声明一个 launcher root：${entryId}`)
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
