import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { advancedJourneyCases } from '../eval/advanced-journeys.js'
import { advancedJourneyConfigurationSha256 } from '../eval/advanced-journey-configuration.js'
import { parseEvaluationRepetitions } from '../eval/options.js'
import { evaluateReleaseGate, readArchivedLabels } from './gate-policy.js'

const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(productRoot, '..', '..')
const dsh = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as { version: string }
const mythos = JSON.parse(await readFile(join(productRoot, 'package.json'), 'utf8')) as { version: string }
const labels = await readArchivedLabels(join(productRoot, 'flywheel', 'data'))
const cohortPrefix = [dsh.version, mythos.version, await advancedJourneyConfigurationSha256(productRoot), 'default'].join(':')
const minSamples = parseEvaluationRepetitions(process.env.MYTHOS_EVAL_REPETITIONS)
const failures: string[] = []
if (advancedJourneyCases.length === 0) failures.push('policy_invalid: advancedJourneyCases 为空')
for (const testCase of advancedJourneyCases) {
  const result = evaluateReleaseGate(labels, {
    caseIds: [testCase.id], cohortPrefix, maxDurationMsP95: 900_000,
    minCompactionSummariesMean: testCase.minCompactionSummaries,
    minEvidenceAfterMutationRate: 1,
    minMaxSubagentCallsPerStepMean: testCase.minParallelSubagents,
    minResumeBoundariesMean: testCase.stages.length - 1,
    minSamples,
    minTurnsMean: testCase.stages.length,
  })
  failures.push(...result.failures)
}
const result = { failures, passed: failures.length === 0 }
process.stdout.write(`${JSON.stringify({ cohortPrefix, minSamples, ...result }, null, 2)}\n`)
if (!result.passed) process.exitCode = 1
