import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { advancedJourneyCases } from './advanced-journeys.js'
import { advancedJourneyConfigurationSha256 } from './advanced-journey-configuration.js'
import { readCompressedSessionMetrics } from './session-metrics.js'
import { buildEvaluationReport } from './report-contract.js'

const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(productRoot, '..', '..')
const dshHome = join(productRoot, 'home')
const sessionsRoot = join(dshHome, 'sessions')
const cliPath = join(repoRoot, 'apps', 'cli', 'lib', 'bin.js')
const baseOverlay = join(productRoot, 'eval', 'overlays', 'journey.yml')
const timeoutMs = Number(process.env.MYTHOS_JOURNEY_TIMEOUT_MS ?? 900_000)
const selected = process.env.MYTHOS_ADVANCED_JOURNEY_CASE

async function sessionPaths(): Promise<string[]> {
  const result: string[] = []
  async function visit(path: string): Promise<void> {
    let entries
    try { entries = await readdir(path, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) await visit(child)
      else if (entry.name === 'session.jsonl.zstd') result.push(child)
    }
  }
  await visit(sessionsRoot)
  return result.sort()
}

async function runTurn(workspace: string, sessionId: string, prompt: string, action: 'create' | 'resume', overlay: string) {
  const started = performance.now()
  const promptFile = join(tmpdir(), `mythos-advanced-prompt-${randomUUID()}`)
  await writeFile(promptFile, prompt, { mode: 0o600 })
  try {
    return await new Promise<{ durationMs: number; exitCode: number; timedOut: boolean }>((done, reject) => {
      const child = spawn(process.execPath, [cliPath, '--profile', 'mythos', '--patch', baseOverlay, '--patch', overlay, 'journey'], {
        cwd: workspace,
        env: { ...process.env, DSH_HOME: dshHome, MYTHOS_JOURNEY_ACTION: action, MYTHOS_JOURNEY_PROMPT_FILE: promptFile, MYTHOS_JOURNEY_SESSION_ID: sessionId },
        stdio: 'inherit',
      })
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, timeoutMs)
      child.once('error', reject)
      child.once('exit', code => { clearTimeout(timer); done({ durationMs: Math.round(performance.now() - started), exitCode: code ?? 1, timedOut }) })
    })
  } finally { await rm(promptFile, { force: true }) }
}

if (!process.env.DEEPSEEK_API_KEY || !process.env.DEEPSEEK_BASE_URL) throw new Error('缺少 M3 API 环境变量')
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) throw new Error('MYTHOS_JOURNEY_TIMEOUT_MS 无效')
const chosenCases = selected ? advancedJourneyCases.filter(testCase => testCase.id === selected) : advancedJourneyCases
if (chosenCases.length === 0) throw new Error(`未知高级旅程：${selected}`)
const startedAt = new Date().toISOString()
const cases = []
for (const testCase of chosenCases) {
  const before = new Set(await sessionPaths())
  const workspace = await mkdtemp(join(tmpdir(), `mythos-${testCase.id}-`))
  const sessionId = `session-${testCase.id}-${randomUUID()}`
  const started = performance.now()
  const stages = []
  let verification = { evidence: {}, passed: false, reason: '旅程未完成' }
  try {
    await testCase.setup(workspace)
    const overlay = join(productRoot, 'eval', 'overlays', `journey-${testCase.overlay}.yml`)
    for (let index = 0; index < testCase.stages.length; index += 1) {
      process.stdout.write(`\n[Mythos Advanced Journey] ${testCase.id} stage ${index + 1}/${testCase.stages.length}\n`)
      const result = await runTurn(workspace, sessionId, testCase.stages[index]!, index === 0 ? 'create' : 'resume', overlay)
      stages.push(result)
      if (result.exitCode !== 0 || result.timedOut) break
    }
    verification = await testCase.verify(workspace)
  } finally { await rm(workspace, { recursive: true, force: true }) }
  const after = await sessionPaths()
  const created = after.filter(path => !before.has(path))
  const raw = created.find(path => dirname(path).endsWith(`/${sessionId}`))
  const related = created.filter(path => path !== raw)
  const metrics = raw ? readCompressedSessionMetrics(raw) : undefined
  const behaviorPassed = metrics !== undefined
    && metrics.turns >= testCase.stages.length
    && metrics.resumeBoundaries >= testCase.stages.length - 1
    && metrics.compactionSummaries >= testCase.minCompactionSummaries
    && metrics.maxSubagentCallsPerStep >= testCase.minParallelSubagents
    && metrics.evidenceAfterMutation
  const processPassed = stages.length === testCase.stages.length && stages.every(stage => stage.exitCode === 0 && !stage.timedOut)
  cases.push({
    behaviorVerification: {
      evidence: { compactionSummaries: metrics?.compactionSummaries ?? 0, maxSubagentCallsPerStep: metrics?.maxSubagentCallsPerStep ?? 0,
        relatedSessions: related.length, resumeBoundaries: metrics?.resumeBoundaries ?? 0, turns: metrics?.turns ?? 0 },
      passed: behaviorPassed,
      reason: behaviorPassed ? '高级能力轨迹证据通过' : '缺少压缩、并行委派、恢复或修改后验证证据',
    },
    dimensions: testCase.dimensions,
    durationMs: Math.round(performance.now() - started),
    id: testCase.id,
    metrics,
    passed: processPassed && verification.passed && behaviorPassed,
    processExitCode: processPassed ? 0 : 1,
    rawSession: raw ? relative(productRoot, raw) : undefined,
    relatedRawSessions: related.map(path => relative(productRoot, path)),
    stages,
    tier: 'advanced-journey',
    timedOut: stages.some(stage => stage.timedOut),
    verification,
  })
}
const dsh = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as { version: string }
const mythos = JSON.parse(await readFile(join(productRoot, 'package.json'), 'utf8')) as { version: string }
const draft = {
  baseline: { configurationSha256: await advancedJourneyConfigurationSha256(productRoot), dshVersion: dsh.version,
    endpoint: new URL(process.env.DEEPSEEK_BASE_URL).origin, mythosVersion: mythos.version, suite: 'advanced-journey', timeoutMs, variant: 'default' },
  cases, completedAt: new Date().toISOString(), model: process.env.MYTHOS_EVAL_MODEL ?? 'deepseek-v4-flash',
  passed: cases.every(testCase => testCase.passed), profile: 'mythos', reportVersion: 1, runId: randomUUID(), startedAt,
}
const advancedOverlays = [...new Set(chosenCases.map(testCase => `eval/overlays/journey-${testCase.overlay}.yml`))]
const report = await buildEvaluationReport({
  cases,
  commitment: {
    config: { endpoint: new URL(process.env.DEEPSEEK_BASE_URL).origin, selected: selected ?? null, suite: 'advanced-journey', timeoutMs, variant: 'default' },
    files: [
      'package.json',
      'home/profiles/mythos/cordis.yml',
      'home/profiles/mythos/cordis.patch.yml',
      'home/profiles/mythos/package.json',
      'eval/advanced-journey-configuration.ts',
      'eval/advanced-journeys.ts',
      'eval/journey-turn-runner.ts',
      'eval/report-contract.ts',
      'eval/run-advanced-journeys.ts',
      'eval/session-metrics.ts',
      'eval/overlays/journey.yml',
      ...advancedOverlays,
    ],
    productRoot,
  },
  draft,
  repoRoot,
  requestedModel: process.env.MYTHOS_EVAL_MODEL ?? 'deepseek-v4-flash',
  requestedProvider: process.env.MYTHOS_EVAL_PROVIDER ?? 'deepseek',
})
await mkdir(join(productRoot, 'runs'), { recursive: true })
const reportPath = join(productRoot, 'runs', `${startedAt.replaceAll(':', '-')}.json`)
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(`\n[Mythos Advanced Journey] ${report.passed ? 'PASS' : 'FAIL'} ${reportPath}\n`)
if (!report.passed) process.exitCode = 1
