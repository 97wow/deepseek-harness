import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { parseEvaluationLaunchArguments, type EvaluationEntryId } from './entry-registry.js'

export type EvaluationExecutionHook = (entryId: EvaluationEntryId, load: () => Promise<unknown>) => Promise<void>

export interface EvaluationLaunchRuntime {
  argv: string[]
  environment: Record<string, string | undefined>
}

const executeEntry: EvaluationExecutionHook = async (_entryId, load) => { await load() }

export async function launchEvaluation(
  parameters: readonly string[],
  executionHook: EvaluationExecutionHook = executeEntry,
  runtime: EvaluationLaunchRuntime = { argv: process.argv, environment: process.env },
): Promise<void> {
  const invocation = parseEvaluationLaunchArguments(parameters)
  for (const [name, value] of invocation.entry.environment) runtime.environment[name] = value
  const suite = invocation.options.get('suite')
  if (suite !== undefined) runtime.environment.MYTHOS_EVAL_SUITE = suite
  runtime.environment.MYTHOS_EVAL_ENTRY_ID = invocation.entryId
  runtime.argv.splice(0, runtime.argv.length, runtime.argv[0] ?? process.execPath, 'eval/launch.ts', ...invocation.caseIds)
  await executionHook(invocation.entryId, invocation.entry.load)
}

const executedPath = process.argv[1] === undefined ? null : resolve(process.argv[1])
if (executedPath === fileURLToPath(import.meta.url)) await launchEvaluation(process.argv.slice(2))
