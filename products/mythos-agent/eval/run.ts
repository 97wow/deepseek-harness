import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluationCases, type EvaluationCase, type VerificationResult } from './cases.js'
import { readCompressedSessionMetrics, type SessionMetrics } from './session-metrics.js'

interface CaseResult {
  durationMs: number
  id: string
  metrics?: SessionMetrics
  passed: boolean
  processExitCode: number
  rawSession?: string
  verification: VerificationResult
}

interface EvaluationReport {
  cases: CaseResult[]
  completedAt: string
  model: string
  passed: boolean
  profile: string
  reportVersion: 1
  startedAt: string
  totals: {
    cacheReadTokens: number
    durationMs: number
    inputTokens: number
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

async function runProcess(testCase: EvaluationCase, cwd: string): Promise<number> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliPath, '--profile', 'mythos', testCase.prompt], {
      cwd,
      env: {
        ...process.env,
        DSH_HOME: dshHome,
      },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', code => resolvePromise(code ?? 1))
  })
}

function failedVerification(reason: string): VerificationResult {
  return { evidence: {}, passed: false, reason }
}

async function runCase(testCase: EvaluationCase): Promise<CaseResult> {
  const workspace = await mkdtemp(join(tmpdir(), `mythos-eval-${testCase.id}-`))
  const beforeSessions = await collectSessionFiles(sessionsRoot)
  const start = performance.now()
  let processExitCode = 1
  let verification = failedVerification('Agent 进程未完成')

  try {
    await testCase.setup(workspace)
    processExitCode = await runProcess(testCase, workspace)
    verification = processExitCode === 0
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
  if (rawSession) {
    try {
      metrics = readCompressedSessionMetrics(rawSession)
    } catch (error) {
      verification = failedVerification(
        `会话指标解析失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  } else {
    verification = failedVerification(
      newSessions.length === 0
        ? '未找到本次运行的 DSH 原始会话'
        : `发现 ${newSessions.length} 个新会话，无法可靠归因`,
    )
  }

  return {
    durationMs: Math.round(performance.now() - start),
    id: testCase.id,
    metrics,
    passed: processExitCode === 0 && verification.passed && metrics !== undefined,
    processExitCode,
    rawSession: rawSession ? relative(productRoot, rawSession) : undefined,
    verification,
  }
}

function buildTotals(cases: CaseResult[]): EvaluationReport['totals'] {
  const totals: EvaluationReport['totals'] = {
    cacheReadTokens: 0,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    steps: 0,
    toolCalls: {},
  }
  for (const result of cases) {
    totals.durationMs += result.durationMs
    if (!result.metrics) continue
    totals.cacheReadTokens += result.metrics.cacheReadTokens
    totals.inputTokens += result.metrics.inputTokens
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
  const selectedIds = new Set(process.argv.slice(2))
  const selectedCases = selectedIds.size === 0
    ? evaluationCases
    : evaluationCases.filter(testCase => selectedIds.has(testCase.id))
  if (selectedCases.length === 0) throw new Error('没有匹配的评测用例')
  if (selectedCases.length !== selectedIds.size) {
    const knownIds = new Set(evaluationCases.map(testCase => testCase.id))
    const unknownIds = [...selectedIds].filter(id => !knownIds.has(id))
    throw new Error(`未知评测用例：${unknownIds.join(', ')}`)
  }

  const results: CaseResult[] = []
  for (const testCase of selectedCases) {
    process.stdout.write(`\n[Mythos Eval] ${testCase.id}\n`)
    results.push(await runCase(testCase))
  }

  const report: EvaluationReport = {
    cases: results,
    completedAt: new Date().toISOString(),
    model: 'deepseek-v4-flash',
    passed: results.every(result => result.passed),
    profile: 'mythos',
    reportVersion: 1,
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
