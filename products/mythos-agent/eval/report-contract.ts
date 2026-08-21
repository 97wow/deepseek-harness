import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type FailureCategory = 'model_failure' | 'harness_failure' | 'infrastructure_failure'

export interface CommitmentInput {
  config: Readonly<Record<string, unknown>>
  files: readonly string[]
  productRoot: string
}

export interface ReportCase {
  id: string
  metrics?: {
    cacheReadTokens?: number
    inputTokens?: number
    outputTokens?: number
    turnReason?: string
  }
  metricsError?: string
  passed: boolean
  processExitCode?: number
  timedOut?: boolean
  verification?: { passed?: boolean }
}

interface ProductManifest {
  mythos?: { dshCommit?: string; dshVersion?: string }
  version?: string
}

function canonical(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

async function git(repoRoot: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return stdout
}

/** Computes a deterministic commitment without exposing file contents. */
export async function evaluationCommitment(input: CommitmentInput): Promise<{
  algorithm: 'sha256-v1'
  files: { path: string; sha256: string }[]
  sha256: string
}> {
  const root = resolve(input.productRoot)
  const paths = [...new Set(input.files.map(path => resolve(root, path)))].sort()
  const files = await Promise.all(paths.map(async path => {
    if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error('评测 commitment 文件越出产品目录')
    return {
      path: relative(root, path).replaceAll(sep, '/'),
      sha256: createHash('sha256').update(await readFile(path)).digest('hex'),
    }
  }))
  const sha256 = createHash('sha256').update(canonical({ config: input.config, files })).digest('hex')
  return { algorithm: 'sha256-v1', files, sha256 }
}

/** Captures the source revision and a digest of the tracked HEAD diff. */
export async function sourceEvidence(repoRoot: string): Promise<{
  dirtyDiff: { algorithm: 'sha256'; scope: 'tracked-head-diff'; sha256: string }
  gitHead: string
  worktree: { clean: boolean; untrackedPathsPresent: boolean }
}> {
  const [gitHead, status, diff] = await Promise.all([
    git(repoRoot, ['rev-parse', 'HEAD']),
    git(repoRoot, ['status', '--porcelain=v1', '--untracked-files=normal']),
    git(repoRoot, ['diff', '--binary', '--no-ext-diff', 'HEAD', '--']),
  ])
  return {
    dirtyDiff: {
      algorithm: 'sha256',
      scope: 'tracked-head-diff',
      sha256: createHash('sha256').update(diff).digest('hex'),
    },
    gitHead: gitHead.trim(),
    worktree: { clean: status === '', untrackedPathsPresent: status.split('\n').some(line => line.startsWith('?? ')) },
  }
}

export function classifyFailure(testCase: ReportCase): { category: FailureCategory | null; reason: string | null } {
  if (testCase.passed) return { category: null, reason: null }
  if (testCase.metricsError || !testCase.metrics) return { category: 'harness_failure', reason: 'observability_gap' }
  if (testCase.timedOut || (testCase.processExitCode ?? 0) !== 0) {
    return { category: 'infrastructure_failure', reason: testCase.timedOut ? 'timeout' : 'runner_process_failure' }
  }
  if (testCase.verification?.passed === false) return { category: 'model_failure', reason: 'external_verifier_rejected' }
  return { category: 'harness_failure', reason: 'observability_gap' }
}

function safeRequestedIdentity(requestedModel: string, requestedProvider: string): Record<string, unknown> {
  return {
    requested: { model: requestedModel, provider: requestedProvider },
    server: { deployment: null, model: null, provider: null, status: 'unknown_unverified' },
  }
}

/** Adds v2 evidence and computes the fail-closed formal acceptance result. */
export async function buildEvaluationReport(input: {
  cases: readonly ReportCase[]
  commitment: CommitmentInput
  draft: object
  repoRoot: string
  requestedModel: string
  requestedProvider: string
}): Promise<Record<string, unknown>> {
  const manifest = JSON.parse(await readFile(resolve(input.commitment.productRoot, 'package.json'), 'utf8')) as ProductManifest
  const cases = input.cases.map(testCase => {
    const failure = classifyFailure(testCase)
    return {
      ...testCase,
      accepted: false,
      billing: {
        amount: null,
        currency: null,
        source: 'unavailable',
        tokens: {
          cache: testCase.metrics?.cacheReadTokens ?? null,
          input: testCase.metrics?.inputTokens ?? null,
          output: testCase.metrics?.outputTokens ?? null,
        },
        tokensVerified: testCase.metrics !== undefined,
        verified: false,
      },
      completionEvidence: {
        agentIdle: { status: 'unknown_unverified', value: null },
        externalVerifier: {
          status: typeof testCase.verification?.passed === 'boolean' ? 'observed' : 'unknown_unverified',
          value: testCase.verification?.passed ?? null,
        },
        sessionFlush: { status: 'unknown_unverified', value: null },
        turnReason: testCase.metrics?.turnReason
          ? { status: 'observed', value: testCase.metrics.turnReason }
          : { status: 'unknown_unverified', value: null },
      },
      failure,
    }
  })
  const acceptanceFailures: string[] = []
  if (cases.length === 0) acceptanceFailures.push('zero_cases')
  if (!cases.every(testCase => testCase.passed === true)) acceptanceFailures.push('case_failure')
  acceptanceFailures.push('server_identity_unverified')
  if (cases.some(testCase => testCase.billing.verified !== true)) acceptanceFailures.push('billing_unverified')
  if (cases.some(testCase => testCase.completionEvidence.agentIdle.status !== 'observed'
    || testCase.completionEvidence.sessionFlush.status !== 'observed'
    || testCase.completionEvidence.turnReason.status !== 'observed'
    || testCase.completionEvidence.externalVerifier.status !== 'observed')) acceptanceFailures.push('completion_evidence_incomplete')

  return {
    ...input.draft,
    acceptance: { failures: acceptanceFailures, passed: acceptanceFailures.length === 0 },
    cases,
    implementation: await evaluationCommitment({
      ...input.commitment,
      config: {
        ...input.commitment.config,
        requestedModel: input.requestedModel,
        requestedProvider: input.requestedProvider,
      },
    }),
    modelIdentity: safeRequestedIdentity(input.requestedModel, input.requestedProvider),
    passed: acceptanceFailures.length === 0,
    reportVersion: 2,
    source: {
      ...await sourceEvidence(input.repoRoot),
      dsh: {
        declaredCommit: manifest.mythos?.dshCommit ?? null,
        declaredVersion: manifest.mythos?.dshVersion ?? null,
      },
      productVersion: manifest.version ?? null,
    },
  }
}

/** Accepts historical v1 reports and current v2 reports without silently upgrading evidence. */
export function parseEvaluationReport(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('评测报告必须是对象')
  const report = value as Record<string, unknown>
  if (report.reportVersion !== 1 && report.reportVersion !== 2) throw new Error('不支持的评测报告版本')
  if (!Array.isArray(report.cases)) throw new Error('评测报告缺少 cases')
  return report
}
