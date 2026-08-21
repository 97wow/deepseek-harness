import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { selectEvaluationSuite, type EvaluationCase, type VerificationResult } from './cases.js'
import { parseEvaluationModel, parseEvaluationTimeoutMs, parseReplayMetadata } from './options.js'
import { readCompressedSessionMetrics, type SessionMetrics } from './session-metrics.js'

interface CaseResult {
  behaviorVerification: VerificationResult
  dimensions: readonly string[]
  durationMs: number
  id: string
  metricsError?: string
  metrics?: SessionMetrics
  passed: boolean
  processExitCode: number
  rawSession?: string
  timedOut: boolean
  tier: EvaluationCase['tier']
  verification: VerificationResult
}

interface EvaluationReport {
  baseline: {
    configurationSha256: string
    dshVersion: string
    endpoint: string
    mythosVersion: string
    overlaySha256?: string
    suite: string
    timeoutMs: number
    variant: string
  }
  cases: CaseResult[]
  completedAt: string
  model: string
  passed: boolean
  profile: string
  reportVersion: 1
  replay?: {
    iteration: number
    total: number
  }
  runId: string
  startedAt: string
  totals: {
    cacheReadTokens: number
    durationMs: number
    failedToolResults: number
    inputTokens: number
    mutationCalls: number
    outputTokens: number
    steps: number
    toolCalls: Record<string, number>
  }
}

const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(productRoot, '..', '..')
const dshHome = join(productRoot, 'home')
const sessionsRoot = join(dshHome, 'sessions')
const cliPath = join(repoRoot, 'apps', 'cli', 'lib', 'bin.js')
const evalPatch = process.env.MYTHOS_EVAL_PATCH
  ? resolve(process.env.MYTHOS_EVAL_PATCH)
  : undefined
const evaluationTimeoutMs = parseEvaluationTimeoutMs(process.env.MYTHOS_EVAL_TIMEOUT_MS)
const evaluationModel = parseEvaluationModel(process.env.MYTHOS_EVAL_MODEL)
const evaluationSuite = process.env.MYTHOS_EVAL_SUITE?.trim() || 'release'

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

async function configurationSha256(overlay?: string): Promise<string> {
  const hash = createHash('sha256')
  for (const filename of ['cordis.yml', 'cordis.patch.yml', 'package.json']) {
    hash.update(filename)
    hash.update(await readFile(join(dshHome, 'profiles', 'mythos', filename)))
  }
  if (overlay) {
    hash.update('evaluation-overlay')
    hash.update(await readFile(overlay))
  }
  return hash.digest('hex')
}

async function fileSha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

function safeEndpoint(raw: string): string {
  const url = new URL(raw)
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

async function collectSessionFiles(root: string): Promise<Set<string>> {
  const result = new Set<string>()

  async function visit(path: string): Promise<void> {
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const entryPath = join(path, entry.name)
      if (entry.isDirectory()) await visit(entryPath)
      else if (entry.name === 'session.jsonl.zstd') result.add(entryPath)
    }
  }

  await visit(root)
  return result
}

async function runProcess(
  testCase: EvaluationCase,
  cwd: string,
): Promise<{ exitCode: number, timedOut: boolean }> {
  return await new Promise((resolvePromise, reject) => {
    const args = [
      cliPath,
      '--profile',
      'mythos',
      ...(evalPatch ? ['--patch', evalPatch] : []),
      testCase.prompt,
    ]
    const child = spawn(process.execPath, args, {
      cwd,
      env: {
        ...process.env,
        DSH_HOME: dshHome,
      },
      stdio: 'inherit',
    })
    let timedOut = false
    let forceKillTimer: NodeJS.Timeout | undefined
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5_000)
      forceKillTimer.unref()
    }, evaluationTimeoutMs)
    timeout.unref()

    child.once('error', (error) => {
      clearTimeout(timeout)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      resolvePromise({ exitCode: code ?? 1, timedOut })
    })
  })
}

function failedVerification(reason: string): VerificationResult {
  return { evidence: {}, passed: false, reason }
}

function verifyBehavior(testCase: EvaluationCase, metrics: SessionMetrics | undefined): VerificationResult {
  if (!metrics) return failedVerification('缺少原始会话，无法验证 Agent 行为')
  const requiresEvidence = testCase.behavior?.requireEvidenceAfterMutation === true
  const requiresFailure = testCase.behavior?.requireFailedToolResult === true
  const passed = (!requiresEvidence || metrics.evidenceAfterMutation)
    && (!requiresFailure || metrics.failedToolResults > 0)
  return {
    evidence: {
      evidenceAfterMutation: metrics.evidenceAfterMutation,
      failedToolResults: metrics.failedToolResults,
      mutationCalls: metrics.mutationCalls,
    },
    passed,
    reason: passed ? '工具轨迹行为约束通过' : '缺少要求的失败复现或修改后验证证据',
  }
}

async function runCase(testCase: EvaluationCase): Promise<CaseResult> {
  const workspace = await mkdtemp(join(tmpdir(), `mythos-eval-${testCase.id}-`))
  const beforeSessions = await collectSessionFiles(sessionsRoot)
  const start = performance.now()
  let processExitCode = 1
  let timedOut = false
  let verification = failedVerification('Agent 进程未完成')

  try {
    await testCase.setup(workspace)
    const processResult = await runProcess(testCase, workspace)
    processExitCode = processResult.exitCode
    timedOut = processResult.timedOut
    verification = timedOut
      ? failedVerification(`Agent 执行超过 ${evaluationTimeoutMs}ms`)
      : processExitCode === 0
      ? await testCase.verify(workspace)
      : failedVerification(`Agent 进程退出码为 ${processExitCode}`)
  } catch (error) {
    verification = failedVerification(error instanceof Error ? error.message : String(error))
  } finally {
    await rm(workspace, { force: true, recursive: true })
  }

  const afterSessions = await collectSessionFiles(sessionsRoot)
  const newSessions = [...afterSessions].filter(path => !beforeSessions.has(path))
  const rawSession = newSessions.length === 1 ? newSessions[0] : undefined
  let metrics: SessionMetrics | undefined
  let metricsError: string | undefined
  if (rawSession) {
    try {
      metrics = readCompressedSessionMetrics(rawSession)
    } catch (error) {
      metricsError = `会话指标解析失败：${error instanceof Error ? error.message : String(error)}`
    }
  } else {
    metricsError = newSessions.length === 0
      ? '未找到本次运行的 DSH 原始会话'
      : `发现 ${newSessions.length} 个新会话，无法可靠归因`
  }
  const behaviorVerification = verifyBehavior(testCase, metrics)

  return {
    behaviorVerification,
    dimensions: testCase.dimensions,
    durationMs: Math.round(performance.now() - start),
    id: testCase.id,
    ...(metricsError ? { metricsError } : {}),
    metrics,
    passed: processExitCode === 0 && verification.passed && behaviorVerification.passed,
    processExitCode,
    rawSession: rawSession ? relative(productRoot, rawSession) : undefined,
    timedOut,
    tier: testCase.tier,
    verification,
  }
}

function buildTotals(cases: CaseResult[]): EvaluationReport['totals'] {
  const totals: EvaluationReport['totals'] = {
    cacheReadTokens: 0,
    durationMs: 0,
    failedToolResults: 0,
    inputTokens: 0,
    mutationCalls: 0,
    outputTokens: 0,
    steps: 0,
    toolCalls: {},
  }
  for (const result of cases) {
    totals.durationMs += result.durationMs
    if (!result.metrics) continue
    totals.cacheReadTokens += result.metrics.cacheReadTokens
    totals.failedToolResults += result.metrics.failedToolResults
    totals.inputTokens += result.metrics.inputTokens
    totals.mutationCalls += result.metrics.mutationCalls
    totals.outputTokens += result.metrics.outputTokens
    totals.steps += result.metrics.steps
    for (const [name, count] of Object.entries(result.metrics.toolCalls)) {
      totals.toolCalls[name] = (totals.toolCalls[name] ?? 0) + count
    }
  }
  return totals
}

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY')
  if (!process.env.DEEPSEEK_BASE_URL) throw new Error('缺少 DEEPSEEK_BASE_URL')

  const startedAt = new Date().toISOString()
  const replay = parseReplayMetadata(
    process.env.MYTHOS_EVAL_REPLAY_ITERATION,
    process.env.MYTHOS_EVAL_REPLAY_TOTAL,
  )
  const [dshManifest, mythosManifest, configHash] = await Promise.all([
    readJson(join(repoRoot, 'package.json')),
    readJson(join(productRoot, 'package.json')),
    configurationSha256(evalPatch),
  ])
  const selectedCases = selectEvaluationSuite(evaluationSuite, process.argv.slice(2))

  const results: CaseResult[] = []
  for (const testCase of selectedCases) {
    process.stdout.write(`\n[Mythos Eval] ${testCase.id}\n`)
    results.push(await runCase(testCase))
  }

  const report: EvaluationReport = {
    baseline: {
      configurationSha256: configHash,
      dshVersion: String(dshManifest.version),
      endpoint: safeEndpoint(process.env.DEEPSEEK_BASE_URL),
      mythosVersion: String(mythosManifest.version),
      ...(evalPatch ? { overlaySha256: await fileSha256(evalPatch) } : {}),
      suite: evaluationSuite,
      timeoutMs: evaluationTimeoutMs,
      variant: process.env.MYTHOS_EVAL_VARIANT ?? 'default',
    },
    cases: results,
    completedAt: new Date().toISOString(),
    model: evaluationModel,
    passed: results.every(result => result.passed),
    profile: 'mythos',
    reportVersion: 1,
    ...(replay ? { replay } : {}),
    runId: randomUUID(),
    startedAt,
    totals: buildTotals(results),
  }
  const reportPath = join(productRoot, 'runs', `${startedAt.replaceAll(':', '-')}.json`)
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })

  process.stdout.write(`\n[Mythos Eval] ${report.passed ? 'PASS' : 'FAIL'} ${reportPath}\n`)
  process.stdout.write(`${JSON.stringify(report.totals)}\n`)
  if (!report.passed) process.exitCode = 1
}

await main()
