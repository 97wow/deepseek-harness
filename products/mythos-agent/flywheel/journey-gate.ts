import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { journeyCases } from '../eval/journeys.js'
import { journeyConfigurationSha256 } from '../eval/journey-configuration.js'
import { parseEvaluationRepetitions } from '../eval/options.js'
import { evaluateReleaseGate, readArchivedLabels } from './gate-policy.js'

const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(productRoot, '..', '..')
const dsh = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as { version: string }
const mythos = JSON.parse(await readFile(join(productRoot, 'package.json'), 'utf8')) as { version: string }
const labels = await readArchivedLabels(join(productRoot, 'flywheel', 'data'))
const cohortPrefix = [dsh.version, mythos.version, await journeyConfigurationSha256(productRoot), 'default'].join(':')
const minSamples = parseEvaluationRepetitions(process.env.MYTHOS_EVAL_REPETITIONS)
const result = evaluateReleaseGate(labels, {
  caseIds: journeyCases.map(testCase => testCase.id),
  cohortPrefix,
  maxDurationMsP95: 900_000,
  minEvidenceAfterMutationRate: 1,
  minResumeBoundariesMean: 2,
  minSamples,
  minTurnsMean: 3,
})
process.stdout.write(`${JSON.stringify({ cohortPrefix, minSamples, ...result }, null, 2)}\n`)
if (!result.passed) process.exitCode = 1
