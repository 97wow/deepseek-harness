export type EvaluationEntry = 'advanced-journey' | 'journey' | 'qwen-local' | 'real-repository' | 'standard'

export interface EvaluationEntryDefinition {
  commitment: EvaluationEntry
  dependencies: readonly string[]
  environment?: Readonly<Record<string, string>>
  module: `eval/${string}.ts`
  parameters: {
    caseIds: boolean
    options: Readonly<Record<string, readonly string[]>>
  }
}

export const evaluationEntryRegistry = {
  'advanced-journey': {
    commitment: 'advanced-journey', module: 'eval/run-advanced-journeys.ts', parameters: { caseIds: false, options: {} },
    dependencies: ['eval/advanced-journey-configuration.ts', 'eval/advanced-journeys.ts', 'eval/journey-turn-runner.ts',
      'eval/run-advanced-journeys.ts', 'eval/overlays/journey.yml'],
  },
  'advanced-journey-repeat': {
    commitment: 'advanced-journey', module: 'eval/repeat-advanced-journeys.ts', parameters: { caseIds: false, options: {} },
    dependencies: ['eval/advanced-journey-configuration.ts', 'eval/advanced-journeys.ts', 'eval/journey-turn-runner.ts',
      'eval/repeat-advanced-journeys.ts', 'eval/run-advanced-journeys.ts', 'eval/overlays/journey.yml'],
  },
  comprehensive: {
    commitment: 'standard', module: 'eval/run-comprehensive.ts', parameters: { caseIds: true, options: {} },
    environment: { MYTHOS_EVAL_SUITE: 'all' },
    dependencies: ['eval/cases.ts', 'eval/options.ts', 'eval/run-comprehensive.ts', 'eval/run.ts'],
  },
  journey: {
    commitment: 'journey', module: 'eval/run-journeys.ts', parameters: { caseIds: false, options: {} },
    dependencies: ['eval/journey-configuration.ts', 'eval/journey-turn-runner.ts', 'eval/journeys.ts',
      'eval/run-journeys.ts', 'eval/overlays/journey.yml'],
  },
  'journey-repeat': {
    commitment: 'journey', module: 'eval/repeat-journeys.ts', parameters: { caseIds: false, options: {} },
    dependencies: ['eval/journey-configuration.ts', 'eval/journey-turn-runner.ts', 'eval/journeys.ts',
      'eval/repeat-journeys.ts', 'eval/run-journeys.ts', 'eval/overlays/journey.yml'],
  },
  'qwen-local': {
    commitment: 'qwen-local', module: 'eval/run-qwen-local.ts', parameters: { caseIds: true, options: {} },
    environment: { MYTHOS_EVAL_SUITE: 'release' },
    dependencies: ['eval/cases.ts', 'eval/options.ts', 'eval/run-qwen-local.ts', 'eval/run.ts', 'eval/overlays/qwen-local.yml'],
  },
  'qwen-local-benchmark': {
    commitment: 'qwen-local', module: 'eval/qwen-local-benchmark.ts', parameters: { caseIds: false, options: {} },
    dependencies: ['eval/qwen-local-benchmark.ts', 'eval/run-qwen-local.ts', 'eval/run.ts', 'eval/options.ts',
      'eval/cases.ts', 'eval/overlays/qwen-local.yml'],
  },
  'real-repository': {
    commitment: 'real-repository', module: 'eval/run-real-repo.ts', parameters: { caseIds: false, options: {} },
    dependencies: ['eval/real-repo-cases.ts', 'eval/real-repo-configuration.ts', 'eval/run-real-repo.ts'],
  },
  repeat: {
    commitment: 'standard', module: 'eval/repeat.ts', parameters: { caseIds: true, options: { suite: ['all'] } },
    environment: { MYTHOS_EVAL_SUITE: 'release' },
    dependencies: ['eval/cases.ts', 'eval/options.ts', 'eval/repeat.ts', 'eval/run-comprehensive.ts', 'eval/run.ts'],
  },
  standard: {
    commitment: 'standard', module: 'eval/run.ts', parameters: { caseIds: true, options: {} },
    environment: { MYTHOS_EVAL_SUITE: 'release' },
    dependencies: ['eval/cases.ts', 'eval/options.ts', 'eval/run.ts'],
  },
} as const satisfies Readonly<Record<string, EvaluationEntryDefinition>>

export type EvaluationEntryId = keyof typeof evaluationEntryRegistry

export interface EvaluationLaunchInvocation {
  caseIds: string[]
  entry: EvaluationEntryDefinition
  entryId: EvaluationEntryId
  options: Record<string, string>
}

export const publicEvaluationScripts = {
  'bench:qwen-local': { args: [], entryId: 'qwen-local-benchmark' },
  eval: { args: [], entryId: 'standard' },
  'eval:advanced-journey': { args: [], entryId: 'advanced-journey' },
  'eval:advanced-journey:repeat': { args: [], entryId: 'advanced-journey-repeat' },
  'eval:comprehensive': { args: [], entryId: 'comprehensive' },
  'eval:comprehensive:repeat': { args: ['--suite', 'all'], entryId: 'repeat' },
  'eval:journey': { args: [], entryId: 'journey' },
  'eval:journey:repeat': { args: [], entryId: 'journey-repeat' },
  'eval:qwen-local': { args: [], entryId: 'qwen-local' },
  'eval:real-repo': { args: [], entryId: 'real-repository' },
  'eval:repeat': { args: [], entryId: 'repeat' },
} as const satisfies Readonly<Record<string, { args: readonly string[]; entryId: EvaluationEntryId }>>

export const registeredEvaluationReferenceScripts = {
  agent: 'tsx product/launch.ts headless',
  typecheck: "tsc --ignoreConfig --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --types node eval/entry-registry.ts eval/launch.ts eval/run.ts eval/run-comprehensive.ts eval/run-journeys.ts eval/journeys.ts eval/journey-configuration.ts eval/journey-turn-runner.ts eval/repeat-journeys.ts eval/advanced-journeys.ts eval/advanced-journey-configuration.ts eval/run-advanced-journeys.ts eval/repeat-advanced-journeys.ts eval/real-repo-cases.ts eval/real-repo-configuration.ts eval/run-real-repo.ts eval/run-qwen-local.ts eval/qwen-local-benchmark.ts eval/repeat.ts eval/cases.ts eval/options.ts eval/session-metrics.ts flywheel/analysis.ts flywheel/analyze.ts flywheel/archive.ts flywheel/build.ts flywheel/comprehensive-gate.ts flywheel/journey-gate.ts flywheel/advanced-journey-gate.ts flywheel/real-repo-scope-gate.ts flywheel/gate-policy.ts flywheel/gate.ts flywheel/server-dataset.ts flywheel/server-import.ts flywheel/server-analyze.ts flywheel/server-gate.ts flywheel/session-curation.ts flywheel/session-curate.ts product/config.ts product/launch.ts product/smoke-web.ts release/check.ts release/pack.ts release/security.ts release/verify.ts",
  web: 'tsx product/launch.ts web',
} as const satisfies Readonly<Record<string, string>>

const caseIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u

export function parseEvaluationLaunchArguments(argv: readonly string[]): EvaluationLaunchInvocation {
  const [rawEntryId, ...parameters] = argv
  if (rawEntryId === undefined || rawEntryId === '' || !(rawEntryId in evaluationEntryRegistry)) {
    throw new Error('未知或空评测 entry ID')
  }
  const entryId = rawEntryId as EvaluationEntryId
  const entry = evaluationEntryRegistry[entryId]
  const options: Record<string, string> = {}
  const caseIds: string[] = []
  for (let index = 0; index < parameters.length; index += 1) {
    const parameter = parameters[index]!
    if (parameter === '') throw new Error('评测参数不能为空')
    if (parameter.startsWith('--')) {
      const name = parameter.slice(2)
      const allowed = (entry.parameters.options as Readonly<Record<string, readonly string[]>>)[name]
      const value = parameters[index + 1]
      if (!allowed || value === undefined || value.startsWith('--') || !allowed.includes(value)) {
        throw new Error('未声明或无效的评测 option')
      }
      if (options[name] !== undefined) throw new Error('评测 option 不得重复')
      options[name] = value
      index += 1
      continue
    }
    if (!entry.parameters.caseIds || !caseIdPattern.test(parameter) || caseIds.includes(parameter)) {
      throw new Error('未声明、动态或重复的评测 case 参数')
    }
    caseIds.push(parameter)
  }
  return { caseIds, entry, entryId, options }
}

export function canonicalEvaluationCommand(scriptName: keyof typeof publicEvaluationScripts): string {
  const definition = publicEvaluationScripts[scriptName]
  parseEvaluationLaunchArguments([definition.entryId, ...definition.args])
  return ['tsx', 'eval/launch.ts', definition.entryId, ...definition.args].join(' ')
}

const legacyRunnerNames = new Set(Object.values(evaluationEntryRegistry)
  .flatMap(entry => [entry.module, entry.module.slice('eval/'.length)]))

export function validatePackageEvaluationScripts(scripts: Readonly<Record<string, string>>): void {
  for (const scriptName of Object.keys(publicEvaluationScripts) as (keyof typeof publicEvaluationScripts)[]) {
    if (scripts[scriptName] !== canonicalEvaluationCommand(scriptName)) throw new Error(`公开评测 script 不匹配 registry：${scriptName}`)
  }
  for (const [scriptName, command] of Object.entries(registeredEvaluationReferenceScripts)) {
    if (scripts[scriptName] !== command) throw new Error(`评测引用 script 不匹配 registry：${scriptName}`)
  }
  for (const [scriptName, command] of Object.entries(scripts)) {
    if (scriptName in publicEvaluationScripts || scriptName in registeredEvaluationReferenceScripts) continue
    if (/^(?:eval|bench:qwen-local)(?::|$)/u.test(scriptName) || command.includes('eval/') || command.includes('launch.ts')
      || [...legacyRunnerNames].some(path => command.includes(path))) {
      throw new Error(`检测到未注册评测 script：${scriptName}`)
    }
  }
}

export function registryEntryIdsForCommitment(entry: EvaluationEntry): EvaluationEntryId[] {
  return (Object.keys(evaluationEntryRegistry) as EvaluationEntryId[])
    .filter(entryId => evaluationEntryRegistry[entryId].commitment === entry)
}
