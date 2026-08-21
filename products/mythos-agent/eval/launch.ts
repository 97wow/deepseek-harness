import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { evaluationEntryRegistry, parseEvaluationLaunchArguments } from './entry-registry.js'

export type EvaluationModuleLoader = (module: string) => Promise<unknown>

export interface EvaluationLaunchRuntime {
  argv: string[]
  environment: Record<string, string | undefined>
}

interface EvaluationModuleDispatch {
  load(): Promise<unknown>
  module: `eval/${string}.ts`
}

export const evaluationModuleDispatch = new Map([
  ['advanced-journey', { module: 'eval/run-advanced-journeys.ts', load: async () => await import('./run-advanced-journeys.js') }],
  ['advanced-journey-repeat', { module: 'eval/repeat-advanced-journeys.ts', load: async () => await import('./repeat-advanced-journeys.js') }],
  ['comprehensive', { module: 'eval/run-comprehensive.ts', load: async () => await import('./run-comprehensive.js') }],
  ['journey', { module: 'eval/run-journeys.ts', load: async () => await import('./run-journeys.js') }],
  ['journey-repeat', { module: 'eval/repeat-journeys.ts', load: async () => await import('./repeat-journeys.js') }],
  ['qwen-local', { module: 'eval/run-qwen-local.ts', load: async () => await import('./run-qwen-local.js') }],
  ['qwen-local-benchmark', { module: 'eval/qwen-local-benchmark.ts', load: async () => await import('./qwen-local-benchmark.js') }],
  ['real-repository', { module: 'eval/run-real-repo.ts', load: async () => await import('./run-real-repo.js') }],
  ['repeat', { module: 'eval/repeat.ts', load: async () => await import('./repeat.js') }],
  ['standard', { module: 'eval/run.ts', load: async () => await import('./run.js') }],
]) as ReadonlyMap<string, EvaluationModuleDispatch>

export function validateEvaluationModuleDispatch(): void {
  if (evaluationModuleDispatch.size !== evaluationEntryRegistry.size) throw new Error('launcher 与 registry entry 集合不一致')
  for (const [entryId, entry] of evaluationEntryRegistry) {
    const dispatch = evaluationModuleDispatch.get(entryId)
    if (entry.visibility !== 'public' || dispatch?.module !== entry.module) throw new Error(`launcher 与 registry module 不一致：${entryId}`)
  }
  for (const entryId of evaluationModuleDispatch.keys()) {
    if (!evaluationEntryRegistry.has(entryId as never)) throw new Error(`launcher 包含未知 entry：${entryId}`)
  }
}

export async function launchEvaluation(
  parameters: readonly string[],
  loader: EvaluationModuleLoader | undefined = undefined,
  runtime: EvaluationLaunchRuntime = { argv: process.argv, environment: process.env },
): Promise<void> {
  const invocation = parseEvaluationLaunchArguments(parameters)
  validateEvaluationModuleDispatch()
  const dispatch = evaluationModuleDispatch.get(invocation.entryId)
  if (dispatch === undefined) throw new Error('评测 entry 缺少固定 launcher dispatch')
  for (const [name, value] of invocation.entry.environment) runtime.environment[name] = value
  const suite = invocation.options.get('suite')
  if (suite !== undefined) runtime.environment.MYTHOS_EVAL_SUITE = suite
  runtime.environment.MYTHOS_EVAL_ENTRY_ID = invocation.entryId
  runtime.argv.splice(0, runtime.argv.length, runtime.argv[0] ?? process.execPath, dispatch.module, ...invocation.caseIds)
  if (loader === undefined) await dispatch.load()
  else await loader(dispatch.module)
}

const executedPath = process.argv[1] === undefined ? null : resolve(process.argv[1])
if (executedPath === fileURLToPath(import.meta.url)) await launchEvaluation(process.argv.slice(2))
