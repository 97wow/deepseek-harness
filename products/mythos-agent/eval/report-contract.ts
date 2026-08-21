import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const safeToken = /^[a-zA-Z0-9._@/-]+$/u
const safeSessionPath = /^home\/sessions\/[a-zA-Z0-9._/-]+\.zstd$/u
const knownOverlays = new Set([
  'eval/overlays/journey-compaction.yml', 'eval/overlays/journey-subagent.yml', 'eval/overlays/journey.yml',
  'eval/overlays/qwen-local.yml', 'eval/overlays/reasoning-high.yml', 'eval/overlays/real-repo-scope-guard.yml',
])
const knownTurnReasons = new Set(['aborted', 'blocked', 'completed', 'error', 'interrupted', 'max-tokens'])
const supportedCurrencies = new Set(['USD'])

export type EvaluationEntry = 'advanced-journey' | 'journey' | 'qwen-local' | 'real-repository' | 'standard'
export type FailureCategory = 'model_failure' | 'harness_failure' | 'infrastructure_failure'

const commonFiles = [
  'package.json', 'home/profiles/mythos/cordis.yml', 'home/profiles/mythos/cordis.patch.yml',
  'home/profiles/mythos/package.json', 'eval/report-contract.ts', 'eval/session-metrics.ts',
] as const

const entryFiles: Readonly<Record<EvaluationEntry, readonly string[]>> = {
  'advanced-journey': [
    'eval/advanced-journey-configuration.ts', 'eval/advanced-journeys.ts', 'eval/journey-turn-runner.ts',
    'eval/repeat-advanced-journeys.ts', 'eval/run-advanced-journeys.ts', 'eval/overlays/journey.yml',
  ],
  journey: ['eval/journey-configuration.ts', 'eval/journey-turn-runner.ts', 'eval/journeys.ts', 'eval/repeat-journeys.ts', 'eval/run-journeys.ts', 'eval/overlays/journey.yml'],
  'qwen-local': ['eval/cases.ts', 'eval/options.ts', 'eval/qwen-local-benchmark.ts', 'eval/run.ts', 'eval/run-qwen-local.ts', 'eval/repeat.ts', 'eval/overlays/qwen-local.yml'],
  'real-repository': ['eval/real-repo-cases.ts', 'eval/real-repo-configuration.ts', 'eval/run-real-repo.ts'],
  standard: ['eval/cases.ts', 'eval/options.ts', 'eval/run.ts', 'eval/run-comprehensive.ts', 'eval/repeat.ts'],
}

export const evaluationEntrypoints: Readonly<Record<string, EvaluationEntry>> = {
  'qwen-local-benchmark.ts': 'qwen-local',
  'repeat-advanced-journeys.ts': 'advanced-journey',
  'repeat-journeys.ts': 'journey',
  'repeat.ts': 'standard',
  'run-advanced-journeys.ts': 'advanced-journey',
  'run-comprehensive.ts': 'standard',
  'run-journeys.ts': 'journey',
  'run-qwen-local.ts': 'qwen-local',
  'run-real-repo.ts': 'real-repository',
  'run.ts': 'standard',
}

export const internalEvaluationModules: Readonly<Record<string, readonly EvaluationEntry[]>> = {
  'journey-turn-runner.ts': ['advanced-journey', 'journey'],
}

type ShellToken = { kind: 'boundary' | 'word'; value: string }

function isWindowsEvaluationEscape(prefix: string, suffix: string): boolean {
  return /^eval\\.+\.ts(?:$|[?# ])/iu.test(suffix)
    || (/(?:^|[\\/:.])eval$/iu.test(prefix) && /^.+\.ts(?:$|[?# ])/iu.test(suffix))
}

function escapedNewlineLength(command: string, backslashIndex: number): number {
  if (command[backslashIndex + 1] === '\n') return 1
  return 0
}

function shellTokens(command: string): ShellToken[] {
  if (command.includes('\r')) throw new Error('package script 仅接受 LF 换行')
  const tokens: ShellToken[] = []
  let token = ''
  let quote: "'" | '"' | null = null
  let started = false
  const flush = (): void => {
    if (started) tokens.push({ kind: 'word', value: token })
    token = ''
    started = false
  }
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!
    if (quote === "'") {
      if (character === "'") quote = null
      else token += character
      continue
    }
    if (quote === '"') {
      if (character === '"') {
        quote = null
      } else if (character === '\\') {
        const next = command[index + 1]
        if (next === undefined) throw new Error('package script shell 解析失败')
        const continuationLength = escapedNewlineLength(command, index)
        if (continuationLength > 0) {
          index += continuationLength
        } else if (next === '$' || next === '`' || next === '"' || next === '\\') {
          token += next
          index += 1
        } else {
          token += character
        }
      } else {
        if (character === '`' || (character === '$' && command[index + 1] === '(')) {
          throw new Error('package script 禁止命令替换')
        }
        token += character
      }
      continue
    }
    if (character === '\\') {
      const next = command[index + 1]
      if (next === undefined) throw new Error('package script shell 解析失败')
      const continuationLength = escapedNewlineLength(command, index)
      if (continuationLength > 0) {
        index += continuationLength
        continue
      }
      if (isWindowsEvaluationEscape(token, command.slice(index + 1))) throw new Error('Windows eval 路径语法不受支持')
      started = true
      token += next
      index += 1
      continue
    }
    if (character === "'" || character === '"') {
      started = true
      quote = character
      continue
    }
    if (character === '`' || (character === '$' && command[index + 1] === '(')) {
      throw new Error('package script 禁止命令替换')
    }
    if (character === '#'
      && !started) {
      while (index + 1 < command.length && command[index + 1] !== '\n') index += 1
      continue
    }
    if (character === '\n') {
      flush()
      if (tokens.at(-1)?.kind === 'word') tokens.push({ kind: 'boundary', value: ';' })
      continue
    }
    if (character === ' ' || character === '\t') {
      flush()
      continue
    }
    if (/\p{White_Space}/u.test(character)) throw new Error('package script 包含非 ASCII shell 空白')
    if (character === ';' || ((character === '&' || character === '|') && command[index + 1] === character)) {
      flush()
      const boundary = character === ';' ? character : `${character}${character}`
      tokens.push({ kind: 'boundary', value: boundary })
      if (character !== ';') index += 1
      continue
    }
    if (character === '&' || character === '|' || character === '<' || character === '>'
      || character === '(' || character === ')') throw new Error('package script 包含不支持的 shell 结构')
    started = true
    token += character
  }
  if (quote !== null) throw new Error('package script 引号未闭合')
  flush()
  return tokens
}

function isAssignment(value: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*=/u.test(value)
}

function commandWords(tokens: readonly ShellToken[]): string[][] {
  const commands: string[][] = []
  let words: string[] = []
  for (const token of tokens) {
    if (token.kind === 'word') {
      words.push(token.value)
      continue
    }
    if (words.length === 0) throw new Error('package script simple command 为空')
    commands.push(words)
    words = []
  }
  if (words.length > 0) commands.push(words)
  else if (tokens.at(-1)?.kind === 'boundary' && tokens.at(-1)?.value !== ';') throw new Error('package script 缺少后续 command')
  return commands
}

function consumeEnv(words: readonly string[], start: number): number {
  let index = start
  while (index < words.length) {
    const value = words[index]!
    if (isAssignment(value)) {
      index += 1
      continue
    }
    if (value === '--') return index + 1
    if (value === '-i' || value === '--ignore-environment' || value === '-0' || value === '--null') {
      index += 1
      continue
    }
    if (value === '-u' || value === '--unset') {
      if (words[index + 1] === undefined) throw new Error('env option 缺少参数')
      index += 2
      continue
    }
    if (value.startsWith('--unset=')) {
      index += 1
      continue
    }
    if (value.startsWith('-')) throw new Error('env option 无法静态解析')
    return index
  }
  throw new Error('env wrapper 缺少 executable')
}

function consumeCommandWrapper(words: readonly string[], start: number): number {
  let index = start
  while (words[index] === '-p') index += 1
  if (words[index] === '--') index += 1
  if (words[index] === undefined || words[index]!.startsWith('-')) throw new Error('command wrapper 无法静态解析')
  return index
}

function consumeTimeWrapper(words: readonly string[], start: number): number {
  let index = start
  while (words[index] === '-p') index += 1
  if (words[index] === '--') index += 1
  while (isAssignment(words[index] ?? '')) index += 1
  if (words[index] === undefined || words[index]!.startsWith('-')) throw new Error('time wrapper 无法静态解析')
  return index
}

function executableName(value: string): string {
  return value.replaceAll('\\', '/').split('/').at(-1)!.replace(/\.exe$/iu, '').toLowerCase()
}

function mayReferenceEvaluationPath(value: string): boolean {
  const normalized = value.replaceAll('\\', '/')
  return /(?:^|\/)eval\/[\s\S]+\.ts(?:$|[?#])/iu.test(normalized)
}

function executableIndex(words: readonly string[]): number | null {
  let index = 0
  while (isAssignment(words[index] ?? '')) index += 1
  if (words[index] === undefined) return null
  for (;;) {
    const wrapper = executableName(words[index]!)
    if (wrapper === 'env') index = consumeEnv(words, index + 1)
    else if (wrapper === 'command') index = consumeCommandWrapper(words, index + 1)
    else if (wrapper === 'time') index = consumeTimeWrapper(words, index + 1)
    else break
  }
  if (executableName(words[index]!) === 'pnpm') {
    if (words[index + 1] !== 'exec') {
      if (words[index + 1]?.startsWith('-') || words.slice(index + 1).some(value => value === 'tsx' || value.endsWith('/tsx'))) {
        throw new Error('pnpm wrapper 无法静态解析')
      }
      return index
    }
    index += 2
    if (words[index] === '--') index += 1
    if (words[index] === undefined || words[index]!.startsWith('-')) throw new Error('pnpm exec wrapper 无法静态解析')
  } else if (executableName(words[index]!) === 'npx') {
    index += 1
    while (words[index]?.startsWith('-')) {
      const option = words[index]!
      if (option === '--yes' || option === '-y' || option === '--ignore-existing') index += 1
      else if (option === '--package' || option === '-p') {
        if (words[index + 1] === undefined) throw new Error('npx option 缺少参数')
        index += 2
      } else if (option.startsWith('--package=')) index += 1
      else throw new Error('npx option 无法静态解析')
    }
    if (words[index] === undefined) throw new Error('npx wrapper 缺少 executable')
  }
  return index
}

function tsxEntrypoint(words: readonly string[]): string | null {
  const executable = executableIndex(words)
  if (executable === null) return null
  const value = words[executable]!
  if (value.includes('$')) throw new Error('executable 无法静态解析')
  const name = executableName(value)
  if (name === 'sh' || name === 'bash' || name === 'dash' || name === 'zsh' || name === 'ksh' || name === 'fish' || name === 'eval') {
    throw new Error('package script 禁止动态 shell wrapper')
  }
  if (name !== 'tsx') {
    if (name === 'echo' || name === 'printf' || name === 'tsc') return null
    if (words.some(mayReferenceEvaluationPath)) throw new Error('simple command 的 eval 路径执行语义不明确')
    return null
  }
  let index = executable + 1
  while (words[index]?.startsWith('-')) {
    const option = words[index]!
    if (option === '--') {
      index += 1
      break
    }
    if (option === '--no-cache' || option === '--clear-screen') {
      index += 1
      continue
    }
    if (option === '--tsconfig' || option === '-p') {
      if (words[index + 1] === undefined) throw new Error('tsx option 缺少参数')
      index += 2
      continue
    }
    if (option.startsWith('--tsconfig=') || option.startsWith('-p=')) {
      index += 1
      continue
    }
    throw new Error('tsx option 无法静态解析')
  }
  const script = words[index]
  if (script === undefined) throw new Error('tsx 缺少 script')
  if (script.includes('$') || script.includes('*') || script.includes('?')) throw new Error('tsx script 无法静态解析')
  const match = /^(?:\.\/)?eval\/([a-zA-Z0-9][a-zA-Z0-9._-]*\.ts)$/u.exec(script)
  if (mayReferenceEvaluationPath(script) && !match) throw new Error('eval 入口路径无效')
  return match?.[1] ?? null
}

/**
 * Extracts statically declared TypeScript evaluation entrypoints from a package script without executing a shell.
 * @param command Package script source text.
 * @returns Canonical filenames below the product's eval directory.
 * @throws When shell syntax, wrappers, or pre-script options cannot be parsed unambiguously.
 */
export function extractEvaluationEntrypoints(command: string): string[] {
  return commandWords(shellTokens(command)).map(tsxEntrypoint).filter((value): value is string => value !== null)
}

export interface ReportCase {
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
  sessionFlushObserved?: boolean
  timedOut?: boolean
  tier?: string
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
  const turnReason = safeTurnReason(metrics.turnReason)
  if (turnReason !== null) projected.turnReason = turnReason
  return projected
}

export function implementationFiles(entry: EvaluationEntry, overlays: readonly string[] = []): string[] {
  for (const overlay of overlays) {
    if (!knownOverlays.has(overlay)) throw new Error('评测 overlay 不在中央已知集合')
  }
  const registered = Object.entries(evaluationEntrypoints)
    .filter(([, registeredEntry]) => registeredEntry === entry)
    .map(([filename]) => `eval/${filename}`)
  return [...new Set([...commonFiles, ...entryFiles[entry], ...registered, ...overlays])].sort()
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
  overlays?: readonly string[]
  productRoot: string
}): Promise<{
  algorithm: 'sha256-v2'
  entry: EvaluationEntry
  files: { path: string; sha256: string }[]
  runtime: { endpoint: { algorithm: 'sha256'; sha256: string }; parametersSha256: string }
  sha256: string
}> {
  const root = resolve(input.productRoot)
  const { endpoint, ...parameters } = input.config
  const endpointDigest = endpointCommitment(endpoint)
  const paths = implementationFiles(input.entry, input.overlays).map(path => resolve(root, path))
  const files = await Promise.all(paths.map(async path => {
    if (!path.startsWith(`${root}${sep}`)) throw new Error('评测 commitment 文件越出产品目录')
    return { path: relative(root, path).replaceAll(sep, '/'), sha256: createHash('sha256').update(await readFile(path)).digest('hex') }
  }))
  return {
    algorithm: 'sha256-v2', entry: input.entry, files,
    runtime: { endpoint: endpointDigest, parametersSha256: createHash('sha256').update(canonical(parameters)).digest('hex') },
    sha256: createHash('sha256').update(canonical({ endpoint: endpointDigest, entry: input.entry, files, parameters })).digest('hex'),
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
  return { ...tokens, verified: source === 'dsh_session_log' && Object.values(tokens).every(token => token !== null) }
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
  return testCase.agentIdleObserved === true && testCase.sessionFlushObserved === true
    && typeof testCase.verification?.passed === 'boolean' && safeTurnReason(record(testCase.metrics).turnReason) !== null
}

export function classifyFailure(testCase: ReportCase, trust: { billing: boolean; identity: boolean } = { billing: false, identity: false }): {
  category: FailureCategory | null; reason: string | null
} {
  if (!testCase.metrics || testCase.metricsError || !validateTokens(testCase.metrics, testCase.metricsSource).verified
    || !validateBilling(testCase.billing, trust.billing).verified || !completionComplete(testCase) || !trust.identity) {
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
  const billing = validateBilling(testCase.billing)
  const rawSession = typeof testCase.rawSession === 'string' && safeSessionPath.test(testCase.rawSession) ? testCase.rawSession : undefined
  const relatedRawSessions = testCase.relatedRawSessions?.filter(path => safeSessionPath.test(path))
  const raw = {
    billing: { ...billing, tokens: { cache: tokens.cache, input: tokens.input, output: tokens.output }, tokensVerified: tokens.verified },
    completionEvidence: {
      agentIdle: { status: testCase.agentIdleObserved === true ? 'observed' : 'unknown_unverified', value: testCase.agentIdleObserved === true ? true : null },
      externalVerifier: { status: typeof testCase.verification?.passed === 'boolean' ? 'observed' : 'unknown_unverified', value: testCase.verification?.passed ?? null },
      sessionFlush: { status: testCase.sessionFlushObserved === true ? 'observed' : 'unknown_unverified', value: testCase.sessionFlushObserved === true ? true : null },
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

export function authoritativeCaseSemantics(_testCase: Record<string, unknown>): {
  accepted: false
  capabilityEligible: false
  failure: { category: 'harness_failure'; reason: 'observability_gap' }
} {
  return { accepted: false, capabilityEligible: false, failure: { category: 'harness_failure', reason: 'observability_gap' } }
}

function authoritativeReportFailures(cases: readonly Record<string, unknown>[], source: Record<string, unknown>): string[] {
  const failures = ['server_identity_unverified', 'billing_unverified', 'completion_evidence_incomplete']
  if (cases.length === 0) failures.push('zero_cases')
  if (cases.some(testCase => testCase.passed !== true)) failures.push('case_failure')
  const worktree = record(source.worktree)
  if (worktree.trackedDirty === true) failures.push('tracked_source_dirty')
  if (worktree.untrackedPresent === true) failures.push('untracked_source_present')
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

export async function buildEvaluationReport(input: {
  cases: readonly ReportCase[]
  config: Readonly<Record<string, unknown>>
  draft: object
  entry: EvaluationEntry
  overlays?: readonly string[]
  productRoot: string
  repoRoot: string
  requestedModel: string
  requestedProvider: string
}): Promise<Record<string, unknown>> {
  const manifest = JSON.parse(await readFile(resolve(input.productRoot, 'package.json'), 'utf8')) as ProductManifest
  const [source, implementation] = await Promise.all([
    sourceEvidence(input.repoRoot),
    evaluationCommitment({ config: { ...input.config, requestedModel: input.requestedModel, requestedProvider: input.requestedProvider },
      entry: input.entry, overlays: input.overlays, productRoot: input.productRoot }),
  ])
  const cases = input.cases.map(projectCase)
  const failures = authoritativeReportFailures(cases, source)
  return {
    ...projectDraft(input.draft), acceptance: { failures, passed: false }, cases, implementation,
    modelIdentity: { requested: { model: safeString(input.requestedModel), provider: safeString(input.requestedProvider) },
      server: { deployment: null, model: null, provider: null, status: 'unknown_unverified' } },
    passed: false, reportVersion: 2,
    source: { ...source, dsh: { declaredCommit: safeString(manifest.mythos?.dshCommit), declaredVersion: safeString(manifest.mythos?.dshVersion) },
      productVersion: safeString(manifest.version) },
  }
}

export function parseEvaluationReport(value: unknown): Record<string, unknown> {
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
      const expectedTokensVerified = testCase.observationSource === 'dsh_session_log'
        && [tokenValues.cache, tokenValues.input, tokenValues.output].every(value => nonNegativeInteger(value) !== null)
      if (!hasOnlyKeys(testCase, ['accepted', 'billing', 'capabilityEligible', 'completionEvidence', 'durationMs', 'failure', 'id', 'metrics',
        'observationSource', 'passed', 'processExitCode', 'rawSession', 'relatedRawSessions', 'tier', 'timedOut', 'verification'])
        || typeof testCase.id !== 'string' || typeof testCase.passed !== 'boolean' || typeof testCase.accepted !== 'boolean'
        || !['model_failure', 'harness_failure', 'infrastructure_failure', null].includes(failure.category as never)
        || billing.verified !== false || billing.tokensVerified !== expectedTokensVerified
        || typeof completion.turnReason !== 'object'
        || record(completion.agentIdle).status !== 'unknown_unverified'
        || record(completion.sessionFlush).status !== 'unknown_unverified') {
        throw new Error('v2 评测报告 case schema 无效')
      }
      const expected = authoritativeCaseSemantics(testCase)
      if (testCase.accepted !== expected.accepted || testCase.capabilityEligible !== expected.capabilityEligible
        || canonical(testCase.failure) !== canonical(expected.failure)) throw new Error('v2 评测报告 case 派生语义不一致')
    }
    const expectedFailures = authoritativeReportFailures(report.cases.map(record), source)
    if (record(identity.server).status !== 'unknown_unverified' || acceptance.passed !== false || report.passed !== false
      || canonical(acceptance.failures) !== canonical(expectedFailures)) throw new Error('v2 评测报告 acceptance 派生语义不一致')
  }
  return report
}

function entriesInclude(value: unknown): value is EvaluationEntry {
  return value === 'advanced-journey' || value === 'journey' || value === 'qwen-local'
    || value === 'real-repository' || value === 'standard'
}
