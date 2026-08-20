import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluationCases } from '../eval/cases.js'
import type { CohortSummary } from './analysis.js'
import { evaluateReleaseGate } from './gate-policy.js'

const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(productRoot, '..', '..')
const profileRoot = join(productRoot, 'home', 'profiles', 'mythos')
const hash = createHash('sha256')
for (const filename of ['cordis.yml', 'cordis.patch.yml', 'package.json']) {
  hash.update(filename)
  hash.update(await readFile(join(profileRoot, filename)))
}
const configurationSha256 = hash.digest('hex')
const dsh = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as { version: string }
const mythos = JSON.parse(await readFile(join(productRoot, 'package.json'), 'utf8')) as { version: string }
const comparison = JSON.parse(
  await readFile(join(productRoot, 'flywheel', 'data', 'comparison.json'), 'utf8'),
) as { cohorts: Record<string, CohortSummary> }
const cohortPrefix = [dsh.version, mythos.version, configurationSha256, 'default'].join(':')
const result = evaluateReleaseGate(comparison.cohorts, {
  caseIds: evaluationCases.map(testCase => testCase.id),
  cohortPrefix,
  maxDurationMsP95: 300_000,
  minSamples: 3,
})
process.stdout.write(`${JSON.stringify({ cohortPrefix, ...result }, null, 2)}\n`)
if (!result.passed) process.exitCode = 1
