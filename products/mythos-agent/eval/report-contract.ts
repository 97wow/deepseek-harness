import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import {
  evaluationEntryRegistry,
  parseEvaluationLaunchArguments,
  validateEvaluationRegistry,
  type EvaluationEntry,
  type EvaluationEntryId,
} from './entry-registry.js'
import {
  commitExecutionSnapshot,
  readExecutionArtifactManifest,
  verifyExecutionArtifact,
  type ExecutionArtifactCommitment,
} from './execution-snapshot.js'
import { aggregateProviderEvidence, type CaseRuntimeEvidence } from './runtime-evidence.js'

export type { EvaluationEntry, EvaluationEntryId } from './entry-registry.js'

const execFileAsync = promisify(execFile)
const safeToken = /^[a-zA-Z0-9._@/-]+$/u
const safeSessionPath = /^home\/sessions\/[a-zA-Z0-9._/-]+\.zstd$/u
const knownOverlays = new Set([
  'eval/overlays/journey-compaction.yml', 'eval/overlays/journey-subagent.yml', 'eval/overlays/journey.yml',
  'eval/overlays/qwen-local.yml', 'eval/overlays/reasoning-high.yml', 'eval/overlays/real-repo-scope-guard.yml',
  'eval/overlays/runtime-evidence.yml', 'eval/overlays/m3-smoke.yml',
])
const knownTurnReasons = new Set(['aborted', 'blocked', 'completed', 'error', 'interrupted', 'max-tokens'])
const supportedCurrencies = new Set(['USD'])

export type FailureCategory = 'model_failure' | 'harness_failure' | 'infrastructure_failure'

export interface EvaluationReportAttestation {
  readonly artifactSha256: string | null
  readonly observationSha256: string
  readonly reportSha256: string
  readonly runId: string
  readonly sourceCommitmentSha256: string
  readonly sourceGitCommit: string
  readonly sourceGitTree: string
}

export interface AttestedEvaluationReport {
  attestation: EvaluationReportAttestation
  report: Record<string, unknown>
}

const issuedReportAttestations = new WeakSet<object>()

export interface ReportCase {
  /** Legacy/untrusted labels are retained only so old callers fail closed. */
  agentIdleObserved?: boolean
  billing?: unknown
  dimensions?: readonly string[]
  durationMs?: number
  id: string
  metrics?: object
  metricsError?: string
  metricsSource?: string
  passed: boolean
  processExitCode?: number
  rawSession?: string
  relatedRawSessions?: readonly string[]
  runtimeEvidence?: CaseRuntimeEvidence
  sessionFlushObserved?: boolean
  timedOut?: boolean
  tier?: string
  verification?: { passed?: boolean }
}

/** Compatibility helper for fixture construction; formal commitment always covers the complete Git tree. */
export function implementationFiles(entry: EvaluationEntry, overlays: readonly string[] = []): string[] {
  for (const overlay of overlays) {
    if (!knownOverlays.has(overlay)) throw new Error('评测 overlay 不在中央已知集合')
  }
  const entryIds = [...evaluationEntryRegistry.entries()]
    .filter(([, definition]) => definition.commitment === entry)
    .map(([entryId]) => entryId)
  return [...new Set([
    'package.json', 'home/profiles/mythos/cordis.yml', 'home/profiles/mythos/cordis.patch.yml',
    'home/profiles/mythos/package.json', 'eval/entry-registry.ts', 'eval/execution-snapshot.ts', 'eval/launch.ts',
    'eval/report-contract.ts', 'eval/session-metrics.ts', 'eval/snapshot-loader.mjs', 'eval/snapshot-register.mjs',
    ...entryIds.flatMap(entryId => evaluationEntryRegistry.get(entryId)!.internalDependencies), ...overlays,
  ])].sort()
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

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every(key => keys.has(key))
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function safeString(value: unknown): string | null {
  return typeof value === 'string' && safeToken.test(value) ? value : null
}

function safeTimestamp(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
    && Number.isFinite(Date.parse(value)) ? value : null
}

function safeTurnReason(value: unknown): string | null {
  return typeof value === 'string' && knownTurnReasons.has(value) ? value : null
}

function projectMetrics(value: unknown): Record<string, unknown> | null {
  const metrics = record(value)
  if (Object.keys(metrics).length === 0) return null
  const projected: Record<string, unknown> = {}
  for (const key of ['cacheReadTokens', 'compactionSummaries', 'experienceRecoveries', 'failedToolResults', 'inputTokens',
    'maxSubagentCallsPerStep', 'mutationCalls', 'outputTokens', 'resumeBoundaries', 'steps', 'toolResults', 'turns']) {
    const number = nonNegativeInteger(metrics[key])
    if (number !== null) projected[key] = number
  }
  if (typeof metrics.evidenceAfterMutation === 'boolean') projected.evidenceAfterMutation = metrics.evidenceAfterMutation
  if (typeof metrics.usageObserved === 'boolean') projected.usageObserved = metrics.usageObserved
  const turnReason = safeTurnReason(metrics.turnReason)
  if (turnReason !== null) projected.turnReason = turnReason
  return projected
}

function resolveEvaluationEntryId(entry: EvaluationEntry, config: Readonly<Record<string, unknown>>): EvaluationEntryId {
  if (entry === 'qwen-local') return 'qwen-local'
  if (entry === 'real-repository') return 'real-repository'
  if (entry === 'journey') return config.repetition === null || config.repetition === undefined ? 'journey' : 'journey-repeat'
  if (entry === 'advanced-journey') {
    return config.repetition === null || config.repetition === undefined ? 'advanced-journey' : 'advanced-journey-repeat'
  }
  if (config.replay !== null && config.replay !== undefined) return 'repeat'
  return config.suite === 'all' ? 'comprehensive' : 'standard'
}

async function trackedWorkspace(productRoot: string): Promise<{ productPrefix: string; workspaceRoot: string }> {
  const { stdout: rootOutput } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
    cwd: productRoot, encoding: 'utf8',
  })
  const workspaceRoot = rootOutput.trim()
  const canonicalProductRoot = await realpath(productRoot)
  const productPrefix = relative(workspaceRoot, canonicalProductRoot).split(sep).join('/')
  if (productPrefix === '' || productPrefix.startsWith('../')) throw new Error('产品目录必须位于 Git workspace 内')
  return { productPrefix, workspaceRoot }
}

function commitmentPath(workspacePath: string, productPrefix: string): string {
  const prefix = `${productPrefix}/`
  return workspacePath.startsWith(prefix) ? workspacePath.slice(prefix.length) : `workspace:${workspacePath}`
}

export function endpointCommitment(value: unknown): { algorithm: 'sha256'; sha256: string } {
  if (typeof value !== 'string') throw new Error('评测 endpoint 缺失')
  const endpoint = new URL(value)
  if (endpoint.username !== '' || endpoint.password !== '') throw new Error('评测 endpoint 禁止 userinfo 凭据')
  return { algorithm: 'sha256', sha256: createHash('sha256').update(endpoint.href).digest('hex') }
}

export async function evaluationCommitment(input: {
  config: Readonly<Record<string, unknown>>
  entry: EvaluationEntry
  entryId?: EvaluationEntryId
  overlays?: readonly string[]
  productRoot: string
}): Promise<{
  algorithm: 'git-tree-sha256-v1'
  artifact: null | {
    algorithm: 'execution-artifact-sha256-v1'
    build: ExecutionArtifactCommitment['build']
    files: ExecutionArtifactCommitment['files']
    mutableRoots: ExecutionArtifactCommitment['mutableRoots']
    sha256: string
  }
  entry: EvaluationEntry
  entryId: EvaluationEntryId
  files: { mode: string; objectId: string; path: string; type: 'blob' | 'commit' }[]
  runtime: {
    command: string
    cwd: string
    artifactSha256: string | null
    dependencyState: 'offline_artifact_verified' | 'offline_artifact_required'
    endpoint: { algorithm: 'sha256'; sha256: string }
    entrySummarySha256: string
    environment: { keys: string[]; sha256: string }
    parametersSha256: string
  }
  snapshot: { gitCommit: string; gitObjectFormat: 'sha1' | 'sha256'; gitTree: string; sha256: string }
  sha256: string
}> {
  const productRoot = resolve(input.productRoot)
  const { endpoint, ...parameters } = input.config
  const endpointDigest = endpointCommitment(endpoint)
  const entryId = input.entryId ?? resolveEvaluationEntryId(input.entry, input.config)
  validateEvaluationRegistry()
  const registryEntry = evaluationEntryRegistry.get(entryId)
  if (registryEntry === undefined || registryEntry.visibility !== 'public') throw new Error('未知或不可启动的评测 entry ID')
  if (registryEntry.commitment !== input.entry) throw new Error('评测 entry ID 与 commitment 归属不一致')
  for (const overlay of input.overlays ?? []) {
    if (!knownOverlays.has(overlay)) throw new Error('评测 overlay 不在中央已知集合')
  }
  let artifact: ExecutionArtifactCommitment | undefined
  let workspaceRoot: string
  let productPrefix: string
  if (process.env.MYTHOS_EVAL_ARTIFACT_MANIFEST !== undefined && process.env.MYTHOS_EVAL_ARTIFACT_ROOT !== undefined) {
    artifact = await readExecutionArtifactManifest(process.env.MYTHOS_EVAL_ARTIFACT_MANIFEST)
    await verifyExecutionArtifact(process.env.MYTHOS_EVAL_ARTIFACT_ROOT, artifact)
    workspaceRoot = await realpath(process.env.MYTHOS_EVAL_ARTIFACT_ROOT)
    const canonicalProductRoot = await realpath(productRoot)
    productPrefix = relative(workspaceRoot, canonicalProductRoot).split(sep).join('/')
    if (productPrefix === '' || productPrefix.startsWith('../')) throw new Error('产品目录必须位于执行产物内')
  } else ({ productPrefix, workspaceRoot } = await trackedWorkspace(productRoot))
  const repository = artifact?.source ?? await commitExecutionSnapshot(workspaceRoot)
  const files = repository.files.map(file => ({ ...file, path: commitmentPath(file.path, productPrefix) }))
  const observedInvocation = artifact === undefined || process.env.MYTHOS_EVAL_INVOCATION_JSON === undefined
    ? null : JSON.parse(process.env.MYTHOS_EVAL_INVOCATION_JSON) as unknown
  if (Array.isArray(observedInvocation) && observedInvocation[0] !== entryId) {
    throw new Error('实际执行 entry 与报告 commitment 不一致')
  }
  const caseIds = Array.isArray(parameters.caseIds)
    ? parameters.caseIds.filter((value): value is string => typeof value === 'string')
    : [...registryEntry.fixedCaseIds ?? []]
  const invocationParameters = Array.isArray(observedInvocation)
    && observedInvocation.every(value => typeof value === 'string')
    ? observedInvocation.slice(1) as string[]
    : entryId === 'repeat' && parameters.suite === 'all' ? ['--suite', 'all', ...caseIds] : caseIds
  parseEvaluationLaunchArguments([entryId, ...invocationParameters])
  const command = ['tsx', 'eval/launch.ts', entryId, ...invocationParameters].join(' ')
  const environmentValues = [...registryEntry.environment, ...(registryEntry.environmentDefaults ?? [])]
    .sort(([left], [right]) => left.localeCompare(right))
  const environment = { keys: environmentValues.map(([name]) => name),
    sha256: createHash('sha256').update(canonical(environmentValues)).digest('hex') }
  const entrySummary = {
    command, commitment: registryEntry.commitment, entryId, environment,
    internalDependencies: registryEntry.internalDependencies,
    parameters: { caseIds: registryEntry.parameters.caseIds, fixedCaseIds: registryEntry.fixedCaseIds ?? null,
      options: [...registryEntry.parameters.options] }, smokePolicy: registryEntry.smokePolicy ?? null,
    visibility: registryEntry.visibility,
  }
  const runtime = {
    artifactSha256: artifact?.sha256 ?? null, command, cwd: productPrefix,
    dependencyState: artifact === undefined ? 'offline_artifact_required' as const : 'offline_artifact_verified' as const,
    endpoint: endpointDigest, entrySummarySha256: createHash('sha256').update(canonical(entrySummary)).digest('hex'),
    environment, parametersSha256: createHash('sha256').update(canonical(parameters)).digest('hex'),
  }
  const snapshot = { gitCommit: repository.gitCommit, gitObjectFormat: repository.gitObjectFormat,
    gitTree: repository.gitTree, sha256: repository.sha256 }
  return {
    algorithm: 'git-tree-sha256-v1', artifact: artifact === undefined ? null : {
      algorithm: artifact.algorithm, build: artifact.build, files: artifact.files,
      mutableRoots: artifact.mutableRoots, sha256: artifact.sha256,
    }, entry: input.entry, entryId, files, runtime, snapshot,
    sha256: createHash('sha256').update(canonical({ entry: input.entry, entryId, files, parameters, runtime, snapshot })).digest('hex'),
  }
}

async function git(repoRoot: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return stdout
}

/** The digest covers tracked HEAD differences only; untracked contents are never read. */
export async function sourceEvidence(repoRoot: string): Promise<{
  dirtyDiff: { algorithm: 'sha256'; scope: 'tracked-head-diff-only'; sha256: string }
  gitHead: string
  worktree: { trackedDirty: boolean; untrackedPresent: boolean }
}> {
  if (process.env.MYTHOS_EVAL_ARTIFACT_MANIFEST !== undefined && process.env.MYTHOS_EVAL_ARTIFACT_ROOT !== undefined) {
    const artifact = await readExecutionArtifactManifest(process.env.MYTHOS_EVAL_ARTIFACT_MANIFEST)
    await verifyExecutionArtifact(process.env.MYTHOS_EVAL_ARTIFACT_ROOT, artifact)
    return {
      dirtyDiff: { algorithm: 'sha256', scope: 'tracked-head-diff-only', sha256: createHash('sha256').update('').digest('hex') },
      gitHead: artifact.source.gitCommit, worktree: { trackedDirty: false, untrackedPresent: false },
    }
  }
  const [gitHead, trackedStatus, untrackedNames, diff] = await Promise.all([
    git(repoRoot, ['rev-parse', 'HEAD']),
    git(repoRoot, ['status', '--porcelain=v1', '--untracked-files=no']),
    git(repoRoot, ['ls-files', '--others', '--exclude-standard']),
    git(repoRoot, ['diff', '--binary', '--no-ext-diff', 'HEAD', '--']),
  ])
  return {
    dirtyDiff: { algorithm: 'sha256', scope: 'tracked-head-diff-only', sha256: createHash('sha256').update(diff).digest('hex') },
    gitHead: gitHead.trim(), worktree: { trackedDirty: trackedStatus !== '', untrackedPresent: untrackedNames !== '' },
  }
}

export function validateTokens(metrics: unknown, source: unknown): {
  cache: number | null; input: number | null; output: number | null; verified: boolean
} {
  const value = record(metrics)
  const tokens = { cache: nonNegativeInteger(value.cacheReadTokens), input: nonNegativeInteger(value.inputTokens), output: nonNegativeInteger(value.outputTokens) }
  return { ...tokens, verified: source === 'dsh_session_log' && value.usageObserved === true
    && Object.values(tokens).every(token => token !== null) }
}

export function validateBilling(value: unknown, trustedSource = false): {
  amount: number | null; currency: string | null; source: string | null; verified: boolean
} {
  const billing = record(value)
  const rawAmount = finiteNumber(billing.amount)
  const amount = rawAmount !== null && rawAmount >= 0 ? rawAmount : null
  const currency = typeof billing.currency === 'string' && supportedCurrencies.has(billing.currency) ? billing.currency : null
  const source = billing.source === 'provider_invoice' || billing.source === 'provider_signed_usage' ? billing.source : null
  return { amount, currency, source, verified: trustedSource && amount !== null && currency !== null && source !== null && billing.verified === true }
}

function completionComplete(testCase: ReportCase): boolean {
  return testCase.runtimeEvidence?.agentIdleObserved === true && testCase.runtimeEvidence.sessionFlushObserved === true
    && typeof testCase.verification?.passed === 'boolean' && safeTurnReason(record(testCase.metrics).turnReason) !== null
}

export function classifyFailure(testCase: ReportCase): {
  category: FailureCategory | null; reason: string | null
} {
  const observed = aggregateProviderEvidence(testCase.runtimeEvidence?.providerResponses ?? [])
  if (!testCase.metrics || testCase.metricsError || !validateTokens(testCase.metrics, testCase.metricsSource).verified
    || !validateBilling(observed.billing === null ? null : { ...observed.billing, verified: true }, observed.billing !== null).verified
    || !completionComplete(testCase) || observed.identity === null) {
    return { category: 'harness_failure', reason: 'observability_gap' }
  }
  if (testCase.timedOut || (testCase.processExitCode ?? 0) !== 0) {
    return { category: 'infrastructure_failure', reason: testCase.timedOut ? 'timeout' : 'runner_process_failure' }
  }
  if (testCase.verification?.passed === false || !testCase.passed) return { category: 'model_failure', reason: 'external_verifier_rejected' }
  return { category: null, reason: null }
}

function projectCase(testCase: ReportCase): Record<string, unknown> {
  const metrics = projectMetrics(testCase.metrics)
  const tokens = validateTokens(testCase.metrics, testCase.metricsSource)
  const observed = aggregateProviderEvidence(testCase.runtimeEvidence?.providerResponses ?? [])
  const billing = validateBilling(observed.billing === null ? null : { ...observed.billing, verified: true }, observed.billing !== null)
  const rawSession = typeof testCase.rawSession === 'string' && safeSessionPath.test(testCase.rawSession) ? testCase.rawSession : undefined
  const relatedRawSessions = testCase.relatedRawSessions?.filter(path => safeSessionPath.test(path))
  const raw = {
    billing: { ...billing, tokens: { cache: tokens.cache, input: tokens.input, output: tokens.output }, tokensVerified: tokens.verified },
    completionEvidence: {
      agentIdle: { status: testCase.runtimeEvidence?.agentIdleObserved === true ? 'observed' : 'unknown_unverified', value: testCase.runtimeEvidence?.agentIdleObserved === true ? true : null },
      externalVerifier: { status: typeof testCase.verification?.passed === 'boolean' ? 'observed' : 'unknown_unverified', value: testCase.verification?.passed ?? null },
      sessionFlush: { status: testCase.runtimeEvidence?.sessionFlushObserved === true ? 'observed' : 'unknown_unverified', value: testCase.runtimeEvidence?.sessionFlushObserved === true ? true : null },
      turnReason: metrics?.turnReason ? { status: 'observed', value: metrics.turnReason } : { status: 'unknown_unverified', value: null },
    },
    durationMs: nonNegativeInteger(testCase.durationMs),
    id: safeString(testCase.id) ?? 'invalid-case-id', metrics, passed: testCase.passed === true,
    observationSource: testCase.metricsSource === 'dsh_session_log' ? 'dsh_session_log' : 'unknown_unverified',
    processExitCode: nonNegativeInteger(testCase.processExitCode), ...(rawSession ? { rawSession } : {}),
    ...(relatedRawSessions?.length ? { relatedRawSessions } : {}), timedOut: testCase.timedOut === true,
    tier: safeString(testCase.tier), verification: { passed: typeof testCase.verification?.passed === 'boolean' ? testCase.verification.passed : null },
  }
  return { ...raw, ...authoritativeCaseSemantics(raw) }
}

export function authoritativeCaseSemantics(testCase: Record<string, unknown>): {
  accepted: boolean
  capabilityEligible: boolean
  failure: { category: FailureCategory | null; reason: string | null }
} {
  const billing = record(testCase.billing)
  const completion = record(testCase.completionEvidence)
  const complete = billing.verified === true && billing.tokensVerified === true
    && record(completion.agentIdle).status === 'observed' && record(completion.agentIdle).value === true
    && record(completion.sessionFlush).status === 'observed' && record(completion.sessionFlush).value === true
    && record(completion.turnReason).status === 'observed'
      && safeTurnReason(record(completion.turnReason).value) !== null
    && record(completion.externalVerifier).status === 'observed'
      && typeof record(completion.externalVerifier).value === 'boolean'
  if (!complete) return { accepted: false, capabilityEligible: false,
    failure: { category: 'harness_failure', reason: 'observability_gap' } }
  if (testCase.timedOut === true || (testCase.processExitCode ?? 0) !== 0) {
    return { accepted: false, capabilityEligible: false,
      failure: { category: 'infrastructure_failure', reason: testCase.timedOut === true ? 'timeout' : 'runner_process_failure' } }
  }
  if (record(testCase.verification).passed === false || testCase.passed !== true) {
    return { accepted: false, capabilityEligible: true,
      failure: { category: 'model_failure', reason: 'external_verifier_rejected' } }
  }
  return { accepted: true, capabilityEligible: true, failure: { category: null, reason: null } }
}

function authoritativeReportFailures(
  cases: readonly Record<string, unknown>[],
  source: Record<string, unknown>,
  implementation: Record<string, unknown> = {},
  serverIdentity: Record<string, unknown> = {},
): string[] {
  const failures: string[] = []
  if (serverIdentity.status !== 'observed') failures.push('server_identity_unverified')
  if (cases.length === 0 || cases.some(testCase => record(testCase.billing).verified !== true)) failures.push('billing_unverified')
  if (cases.length === 0 || cases.some(testCase => {
    const completion = record(testCase.completionEvidence)
    return ['agentIdle', 'externalVerifier', 'sessionFlush', 'turnReason']
      .some(key => record(completion[key]).status !== 'observed')
  })) failures.push('completion_evidence_incomplete')
  if (cases.length === 0) failures.push('zero_cases')
  if (cases.some(testCase => testCase.passed !== true || testCase.accepted !== true)) failures.push('case_failure')
  const worktree = record(source.worktree)
  if (worktree.trackedDirty === true) failures.push('tracked_source_dirty')
  if (worktree.untrackedPresent === true) failures.push('untracked_source_present')
  if (implementation.algorithm === 'git-tree-sha256-v1'
    && record(record(implementation).runtime).dependencyState !== 'offline_artifact_verified') {
    failures.push('execution_snapshot_unverified')
  }
  return failures
}

function projectDraft(draft: object): Record<string, unknown> {
  const value = record(draft)
  const baseline = record(value.baseline)
  const replay = record(value.replay)
  return {
    baseline: {
      configurationSha256: safeString(baseline.configurationSha256), dshVersion: safeString(baseline.dshVersion),
      mythosVersion: safeString(baseline.mythosVersion), suite: safeString(baseline.suite),
      timeoutMs: nonNegativeInteger(baseline.timeoutMs), variant: safeString(baseline.variant),
    },
    completedAt: safeTimestamp(value.completedAt),
    profile: safeString(value.profile),
    ...(Object.keys(replay).length ? { replay: { iteration: nonNegativeInteger(replay.iteration), total: nonNegativeInteger(replay.total) } } : {}),
    runId: safeString(value.runId), startedAt: safeTimestamp(value.startedAt),
  }
}

export interface EvaluationReportInput {
  cases: readonly ReportCase[]
  config: Readonly<Record<string, unknown>>
  draft: object
  entry: EvaluationEntry
  entryId?: EvaluationEntryId
  overlays?: readonly string[]
  productRoot: string
  repoRoot: string
  requestedModel: string
  requestedProvider: string
}

async function projectEvaluationReport(input: EvaluationReportInput): Promise<Record<string, unknown>> {
  const manifest = JSON.parse(await readFile(resolve(input.productRoot, 'package.json'), 'utf8')) as ProductManifest
  const [source, implementation] = await Promise.all([
    sourceEvidence(input.repoRoot),
    evaluationCommitment({ config: { ...input.config, requestedModel: input.requestedModel, requestedProvider: input.requestedProvider },
      entry: input.entry, entryId: input.entryId, overlays: input.overlays, productRoot: input.productRoot }),
  ])
  const cases = input.cases.map(projectCase)
  const identities = input.cases.map(testCase => aggregateProviderEvidence(testCase.runtimeEvidence?.providerResponses ?? []).identity)
  const firstIdentity = identities[0]
  const serverIdentity = identities.length > 0 && firstIdentity !== null
    && identities.every(identity => identity !== null && canonical(identity) === canonical(firstIdentity))
    ? { ...firstIdentity, source: 'm3_provider_response', status: 'observed' }
    : { deployment: null, model: null, provider: null, source: null, status: 'unknown_unverified' }
  const failures = authoritativeReportFailures(cases, source, implementation, serverIdentity)
  const accepted = failures.length === 0
  return {
    ...projectDraft(input.draft), acceptance: { failures, passed: accepted }, cases, implementation,
    modelIdentity: { requested: { model: safeString(input.requestedModel), provider: safeString(input.requestedProvider) },
      server: serverIdentity },
    passed: accepted, reportVersion: 2,
    source: { ...source, dsh: { declaredCommit: safeString(manifest.mythos?.dshCommit), declaredVersion: safeString(manifest.mythos?.dshVersion) },
      productVersion: safeString(manifest.version) },
  }
}

function reportObservationSha256(report: Record<string, unknown>): string {
  return createHash('sha256').update(canonical({
    cases: report.cases,
    serverIdentity: record(record(report.modelIdentity).server),
  })).digest('hex')
}

function issueReportAttestation(report: Record<string, unknown>): EvaluationReportAttestation {
  const implementation = record(report.implementation)
  const runtime = record(implementation.runtime)
  const snapshot = record(implementation.snapshot)
  const attestation = Object.freeze({
    artifactSha256: safeString(runtime.artifactSha256),
    observationSha256: reportObservationSha256(report),
    reportSha256: createHash('sha256').update(canonical(report)).digest('hex'),
    runId: safeString(report.runId) ?? '',
    sourceCommitmentSha256: safeString(snapshot.sha256) ?? '',
    sourceGitCommit: safeString(snapshot.gitCommit) ?? '',
    sourceGitTree: safeString(snapshot.gitTree) ?? '',
  })
  issuedReportAttestations.add(attestation)
  return attestation
}

function attestationMatches(report: Record<string, unknown>, attestation: EvaluationReportAttestation | undefined): boolean {
  if (attestation === undefined || !issuedReportAttestations.has(attestation)) return false
  const implementation = record(report.implementation)
  const runtime = record(implementation.runtime)
  const snapshot = record(implementation.snapshot)
  return attestation.reportSha256 === createHash('sha256').update(canonical(report)).digest('hex')
    && attestation.runId === report.runId
    && attestation.artifactSha256 === (safeString(runtime.artifactSha256) ?? null)
    && attestation.sourceCommitmentSha256 === snapshot.sha256
    && attestation.sourceGitCommit === snapshot.gitCommit
    && attestation.sourceGitTree === snapshot.gitTree
    && attestation.observationSha256 === reportObservationSha256(report)
}

function untrustedReport(report: Record<string, unknown>, reason: 'trusted_attestation_invalid' | 'trusted_attestation_missing'):
Record<string, unknown> {
  const acceptance = record(report.acceptance)
  const declaredFailures = Array.isArray(acceptance.failures)
    ? acceptance.failures.filter((failure): failure is string => typeof failure === 'string') : []
  return { ...report, acceptance: { failures: [...new Set([...declaredFailures, reason])], passed: false }, passed: false }
}

export async function buildAttestedEvaluationReport(input: EvaluationReportInput): Promise<AttestedEvaluationReport> {
  const report = await projectEvaluationReport(input)
  const attestation = issueReportAttestation(report)
  return { attestation, report: parseEvaluationReport(report, attestation) }
}

/** Compatibility builder: the report is readable, but formal acceptance requires the separate attestation API. */
export async function buildEvaluationReport(input: EvaluationReportInput): Promise<Record<string, unknown>> {
  return parseEvaluationReport(await projectEvaluationReport(input))
}

export function parseEvaluationReport(
  value: unknown,
  attestation?: EvaluationReportAttestation,
): Record<string, unknown> {
  const report = record(value)
  if (report.reportVersion !== 1 && report.reportVersion !== 2) throw new Error('不支持的评测报告版本')
  if (!Array.isArray(report.cases)) throw new Error('评测报告缺少 cases')
  if (report.reportVersion === 2) {
    const acceptance = record(report.acceptance)
    const implementation = record(report.implementation)
    const runtime = record(implementation.runtime)
    const identity = record(report.modelIdentity)
    const source = record(report.source)
    const worktree = record(source.worktree)
    if (!hasOnlyKeys(report, ['acceptance', 'baseline', 'cases', 'completedAt', 'implementation', 'modelIdentity', 'passed', 'profile', 'replay', 'reportVersion', 'runId', 'source', 'startedAt'])
      || typeof acceptance.passed !== 'boolean' || !Array.isArray(acceptance.failures)
      || typeof report.passed !== 'boolean' || typeof report.runId !== 'string'
      || typeof implementation.sha256 !== 'string' || !Array.isArray(implementation.files)
      || !entriesInclude(implementation.entry) || typeof record(runtime.endpoint).sha256 !== 'string'
      || (implementation.entryId !== undefined
        && (typeof implementation.entryId !== 'string' || !evaluationEntryRegistry.has(implementation.entryId as EvaluationEntryId)))
      || typeof runtime.parametersSha256 !== 'string'
      || typeof record(identity.server).status !== 'string' || typeof source.gitHead !== 'string'
      || typeof worktree.trackedDirty !== 'boolean' || typeof worktree.untrackedPresent !== 'boolean') {
      throw new Error('v2 评测报告顶层 schema 无效')
    }
    for (const item of report.cases) {
      const testCase = record(item)
      const failure = record(testCase.failure)
      const billing = record(testCase.billing)
      const completion = record(testCase.completionEvidence)
      const tokenValues = record(billing.tokens)
      const expectedBilling = validateBilling(billing, true)
      const expectedTokensVerified = testCase.observationSource === 'dsh_session_log'
        && record(testCase.metrics).usageObserved === true
        && [tokenValues.cache, tokenValues.input, tokenValues.output].every(value => nonNegativeInteger(value) !== null)
      if (!hasOnlyKeys(testCase, ['accepted', 'billing', 'capabilityEligible', 'completionEvidence', 'durationMs', 'failure', 'id', 'metrics',
        'observationSource', 'passed', 'processExitCode', 'rawSession', 'relatedRawSessions', 'tier', 'timedOut', 'verification'])
        || typeof testCase.id !== 'string' || typeof testCase.passed !== 'boolean' || typeof testCase.accepted !== 'boolean'
        || !['model_failure', 'harness_failure', 'infrastructure_failure', null].includes(failure.category as never)
        || billing.amount !== expectedBilling.amount || billing.currency !== expectedBilling.currency
        || billing.source !== expectedBilling.source || billing.verified !== expectedBilling.verified
        || billing.tokensVerified !== expectedTokensVerified
        || typeof completion.turnReason !== 'object'
        || !['observed', 'unknown_unverified'].includes(String(record(completion.agentIdle).status))
        || !['observed', 'unknown_unverified'].includes(String(record(completion.sessionFlush).status))) {
        throw new Error('v2 评测报告 case schema 无效')
      }
      const expected = authoritativeCaseSemantics(testCase)
      if (testCase.accepted !== expected.accepted || testCase.capabilityEligible !== expected.capabilityEligible
        || canonical(testCase.failure) !== canonical(expected.failure)) throw new Error('v2 评测报告 case 派生语义不一致')
    }
    const serverIdentity = record(identity.server)
    if (serverIdentity.status === 'observed'
      && (serverIdentity.source !== 'm3_provider_response'
        || [serverIdentity.deployment, serverIdentity.model, serverIdentity.provider].some(value => safeString(value) === null))) {
      throw new Error('v2 评测报告服务端身份 schema 无效')
    }
    if (serverIdentity.status !== 'observed' && (serverIdentity.status !== 'unknown_unverified'
      || serverIdentity.source !== null
      || [serverIdentity.deployment, serverIdentity.model, serverIdentity.provider].some(value => value !== null))) {
      throw new Error('v2 评测报告服务端身份 schema 无效')
    }
    const expectedFailures = authoritativeReportFailures(report.cases.map(record), source, implementation, serverIdentity)
    const expectedPassed = expectedFailures.length === 0
    const declaredFailures = acceptance.failures.filter((failure): failure is string => typeof failure === 'string')
    const attestationFailures = declaredFailures.filter(failure => failure === 'trusted_attestation_missing'
      || failure === 'trusted_attestation_invalid')
    const baseFailures = declaredFailures.filter(failure => failure !== 'trusted_attestation_missing'
      && failure !== 'trusted_attestation_invalid')
    const declaredPassed = attestationFailures.length === 0 ? expectedPassed : false
    if (declaredFailures.length !== acceptance.failures.length || attestationFailures.length > 1
      || acceptance.passed !== declaredPassed || report.passed !== declaredPassed
      || canonical(baseFailures) !== canonical(expectedFailures)) throw new Error('v2 评测报告 acceptance 派生语义不一致')
  }
  if (attestationMatches(report, attestation)) return report
  return untrustedReport(report, attestation === undefined ? 'trusted_attestation_missing' : 'trusted_attestation_invalid')
}

function entriesInclude(value: unknown): value is EvaluationEntry {
  return value === 'advanced-journey' || value === 'journey' || value === 'qwen-local'
    || value === 'real-repository' || value === 'standard'
}
