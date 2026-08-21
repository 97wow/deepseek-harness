import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { parseEvaluationLaunchArguments } from './entry-registry.js'

export type EvaluationModuleLoader = (module: string) => Promise<unknown>

export interface EvaluationLaunchRuntime {
  argv: string[]
  environment: Record<string, string | undefined>
}

async function defaultLoader(module: string): Promise<unknown> {
  return await import(new URL(`../${module}`, import.meta.url).href)
}

export async function launchEvaluation(
  parameters: readonly string[],
  loader: EvaluationModuleLoader = defaultLoader,
  runtime: EvaluationLaunchRuntime = { argv: process.argv, environment: process.env },
): Promise<void> {
  const invocation = parseEvaluationLaunchArguments(parameters)
  for (const [name, value] of Object.entries(invocation.entry.environment ?? {})) runtime.environment[name] = value
  if (invocation.options.suite !== undefined) runtime.environment.MYTHOS_EVAL_SUITE = invocation.options.suite
  runtime.environment.MYTHOS_EVAL_ENTRY_ID = invocation.entryId
  runtime.argv.splice(0, runtime.argv.length, runtime.argv[0] ?? process.execPath, invocation.entry.module, ...invocation.caseIds)
  await loader(invocation.entry.module)
}

const executedPath = process.argv[1] === undefined ? null : resolve(process.argv[1])
if (executedPath === fileURLToPath(import.meta.url)) await launchEvaluation(process.argv.slice(2))
