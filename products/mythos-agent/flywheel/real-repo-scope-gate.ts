import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { realRepoConfigurationSha256 } from '../eval/real-repo-configuration.js'
import type { CohortSummary } from './analysis.js'
import { evaluateReleaseGate } from './gate-policy.js'

const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(productRoot, '..', '..')
const overlay = join(productRoot, 'eval', 'overlays', 'real-repo-scope-guard.yml')
const dsh = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as { version: string }
const mythos = JSON.parse(await readFile(join(productRoot, 'package.json'), 'utf8')) as { version: string }
const comparison = JSON.parse(await readFile(join(productRoot, 'flywheel', 'data', 'comparison.json'), 'utf8')) as { cohorts: Record<string, CohortSummary> }
const cohortPrefix = [dsh.version, mythos.version, await realRepoConfigurationSha256(productRoot, overlay), 'scope-guard'].join(':')
const result = evaluateReleaseGate(comparison.cohorts, {
  caseIds: ['dsh-session-seed-identity'],
  cohortPrefix,
  maxDurationMsP95: 600_000,
  minEvidenceAfterMutationRate: 1,
  minSamples: 3,
  minTurnsMean: 1,
})
process.stdout.write(`${JSON.stringify({ cohortPrefix, minSamples: 3, ...result }, null, 2)}\n`)
if (!result.passed) process.exitCode = 1
