import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { journeyCases } from './journeys.js'
import { journeyConfigurationSha256 } from './journey-configuration.js'
import { readCompressedSessionMetrics } from './session-metrics.js'
import { buildEvaluationReport } from './report-contract.js'
import { readObservedProviderEvidence } from './runtime-evidence.js'

const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(productRoot, '..', '..')
const dshHome = join(productRoot, 'home')
const cliPath = join(repoRoot, 'apps', 'cli', 'lib', 'bin.js')
const overlay = join(productRoot, 'eval', 'overlays', 'journey.yml')
const runtimeEvidenceOverlay = join(productRoot, 'eval', 'overlays', 'runtime-evidence.yml')
const timeoutMs = Number(process.env.MYTHOS_JOURNEY_TIMEOUT_MS ?? 600_000)

async function findSession(id: string): Promise<string | undefined> {
  const root = join(dshHome, 'sessions')
  async function visit(path: string): Promise<string | undefined> {
    let entries
    try { entries = await readdir(path, { withFileTypes: true }) } catch { return undefined }
    for (const entry of entries) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) {
        const found = await visit(child)
        if (found) return found
      } else if (entry.name === 'session.jsonl.zstd' && dirname(child).endsWith(`/${id}`)) return child
    }
    return undefined
  }
  return await visit(root)
}

async function runTurn(workspace: string, sessionId: string, prompt: string, action: 'create' | 'resume') {
  const started = performance.now()
  const promptFile = join(tmpdir(), `mythos-journey-prompt-${randomUUID()}`)
  const evidencePath = join(tmpdir(), `mythos-runtime-evidence-${randomUUID()}.ndjson`)
  await writeFile(promptFile, prompt, { mode: 0o600 })
  try {
    const result = await new Promise<{ durationMs: number; exitCode: number; timedOut: boolean }>((resolvePromise, reject) => {
      const child = spawn(process.execPath, [cliPath, '--profile', 'mythos', '--patch', runtimeEvidenceOverlay,
        '--patch', overlay, 'journey'], {
        cwd: workspace,
        env: { ...process.env, DSH_HOME: dshHome, MYTHOS_JOURNEY_ACTION: action,
          MYTHOS_JOURNEY_PROMPT_FILE: promptFile, MYTHOS_JOURNEY_SESSION_ID: sessionId,
          MYTHOS_RUNTIME_EVIDENCE_PATH: evidencePath },
        stdio: 'inherit',
      })
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, timeoutMs)
      child.once('error', reject)
      child.once('exit', code => {
        clearTimeout(timer)
        resolvePromise({ durationMs: Math.round(performance.now() - started), exitCode: code ?? 1, timedOut })
      })
    })
    return { ...result, providerResponses: await readObservedProviderEvidence(evidencePath) }
  } finally {
    await rm(promptFile, { force: true })
  }
}

if (!process.env.DEEPSEEK_API_KEY || !process.env.DEEPSEEK_BASE_URL) throw new Error('缺少 M3 API 环境变量')
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) throw new Error('MYTHOS_JOURNEY_TIMEOUT_MS 无效')
const startedAt = new Date().toISOString()
const cases = []
for (const testCase of journeyCases) {
  const workspace = await mkdtemp(join(tmpdir(), `mythos-${testCase.id}-`))
  const sessionId = `session-${testCase.id}-${randomUUID()}`
  const started = performance.now()
  const stages = []
  let verification = { evidence: {}, passed: false, reason: '旅程未完成' }
  try {
    await testCase.setup(workspace)
    for (let index = 0; index < testCase.stages.length; index += 1) {
      process.stdout.write(`\n[Mythos Journey] ${testCase.id} stage ${index + 1}/${testCase.stages.length}\n`)
      const result = await runTurn(workspace, sessionId, testCase.stages[index]!, index === 0 ? 'create' : 'resume')
      stages.push(result)
      if (result.exitCode !== 0 || result.timedOut) break
    }
    verification = await testCase.verify(workspace)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
  const raw = await findSession(sessionId)
  const metrics = raw ? readCompressedSessionMetrics(raw) : undefined
  const behaviorPassed = metrics !== undefined && metrics.turns >= testCase.stages.length
    && metrics.resumeBoundaries >= testCase.stages.length - 1
    && metrics.compactionSummaries >= testCase.minCompactionSummaries
    && metrics.evidenceAfterMutation
  const processPassed = stages.length === testCase.stages.length && stages.every(stage => stage.exitCode === 0 && !stage.timedOut)
  cases.push({
    behaviorVerification: {
      evidence: { compactionSummaries: metrics?.compactionSummaries ?? 0, resumeBoundaries: metrics?.resumeBoundaries ?? 0, turns: metrics?.turns ?? 0 },
      passed: behaviorPassed,
      reason: behaviorPassed ? '多轮冷恢复与修改后验证轨迹通过' : '缺少冷恢复、压缩或修改后验证证据',
    },
    dimensions: ['multi-turn', 'cold-resume', 'repository-change', 'scope-control'],
    durationMs: Math.round(performance.now() - started),
    id: testCase.id,
    metrics,
    ...(metrics ? { metricsSource: 'dsh_session_log' as const } : {}),
    passed: processPassed && verification.passed && behaviorPassed,
    processExitCode: processPassed ? 0 : 1,
    rawSession: raw ? relative(productRoot, raw) : undefined,
    runtimeEvidence: { agentIdleObserved: metrics?.agentIdleObserved === true,
      providerResponses: stages.flatMap(stage => stage.providerResponses),
      sessionFlushObserved: metrics?.sessionFlushObserved === true },
    stages,
    tier: 'journey',
    timedOut: stages.some(stage => stage.timedOut),
    verification,
  })
}
const dsh = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as { version: string }
const mythos = JSON.parse(await readFile(join(productRoot, 'package.json'), 'utf8')) as { version: string }
const draft = {
  baseline: { configurationSha256: await journeyConfigurationSha256(productRoot), dshVersion: dsh.version, mythosVersion: mythos.version, suite: 'journey', timeoutMs, variant: 'default' },
  cases,
  completedAt: new Date().toISOString(),
  model: process.env.MYTHOS_EVAL_MODEL ?? 'deepseek-v4-flash',
  passed: cases.every(testCase => testCase.passed),
  profile: 'mythos',
  reportVersion: 1,
  runId: randomUUID(),
  startedAt,
}
const report = await buildEvaluationReport({
  cases,
  config: { caseIds: journeyCases.map(testCase => testCase.id), endpoint: process.env.DEEPSEEK_BASE_URL,
    profile: 'mythos', repetition: process.env.MYTHOS_EVAL_REPLAY_ITERATION ?? null,
    repetitions: process.env.MYTHOS_EVAL_REPLAY_TOTAL ?? null, suite: 'journey', timeoutMs, variant: 'default' },
  draft,
  entry: 'journey',
  entryId: process.env.MYTHOS_EVAL_ENTRY_ID as never,
  overlays: [relative(productRoot, runtimeEvidenceOverlay), 'eval/overlays/journey.yml'],
  productRoot,
  repoRoot,
  requestedModel: process.env.MYTHOS_EVAL_MODEL ?? 'deepseek-v4-flash',
  requestedProvider: process.env.MYTHOS_EVAL_PROVIDER ?? 'deepseek',
})
await mkdir(join(productRoot, 'runs'), { recursive: true })
const reportPath = join(productRoot, 'runs', `${startedAt.replaceAll(':', '-')}.json`)
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(`\n[Mythos Journey] ${report.passed ? 'PASS' : 'FAIL'} ${reportPath}\n`)
if (!report.passed) process.exitCode = 1
