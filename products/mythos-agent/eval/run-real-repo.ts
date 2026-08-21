import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { realRepoCases, installFutureTest } from './real-repo-cases.js'
import { realRepoConfigurationSha256 } from './real-repo-configuration.js'
import { readCompressedSessionMetrics } from './session-metrics.js'
import { buildEvaluationReport } from './report-contract.js'

const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(productRoot, '..', '..')
const dshHome = join(productRoot, 'home')
const sessionsRoot = join(dshHome, 'sessions')
const cliPath = join(repoRoot, 'apps', 'cli', 'lib', 'bin.js')
const vitestPath = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs')
const timeoutMs = Number(process.env.MYTHOS_REAL_REPO_TIMEOUT_MS ?? 900_000)
const evalPatch = process.env.MYTHOS_REAL_REPO_PATCH ? resolve(process.env.MYTHOS_REAL_REPO_PATCH) : undefined

async function run(command: string, args: string[], cwd: string, inherit = false): Promise<number> {
  return await new Promise((done, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, DSH_HOME: dshHome }, stdio: inherit ? 'inherit' : 'ignore' })
    child.once('error', reject)
    child.once('exit', code => done(code ?? 1))
  })
}

async function extractRevision(revision: string, workspace: string): Promise<void> {
  await new Promise<void>((done, reject) => {
    const git = spawn('git', ['archive', revision], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] })
    const tar = spawn('tar', ['-x', '-C', workspace], { stdio: ['pipe', 'ignore', 'inherit'] })
    git.stdout.pipe(tar.stdin)
    let gitCode: number | null = null
    let tarCode: number | null = null
    const settle = (): void => {
      if (gitCode === null || tarCode === null) return
      if (gitCode === 0 && tarCode === 0) done()
      else reject(new Error(`历史快照提取失败：git=${gitCode} tar=${tarCode}`))
    }
    git.once('error', reject); tar.once('error', reject)
    git.once('exit', code => { gitCode = code ?? 1; settle() })
    tar.once('exit', code => { tarCode = code ?? 1; settle() })
  })
  await symlink(join(repoRoot, 'node_modules'), join(workspace, 'node_modules'), 'dir')
}

async function hashes(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  async function visit(path: string, prefix: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const child = join(path, entry.name)
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await visit(child, name)
      else if (entry.isFile()) result.set(name, createHash('sha256').update(await readFile(child)).digest('hex'))
    }
  }
  await visit(root, '')
  return result
}

function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path) !== after.get(path)).sort()
}

async function sessions(): Promise<Set<string>> {
  const result = new Set<string>()
  async function visit(path: string): Promise<void> {
    let entries
    try { entries = await readdir(path, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) await visit(child)
      else if (entry.name === 'session.jsonl.zstd') result.add(child)
    }
  }
  await visit(sessionsRoot)
  return result
}

async function runAgent(workspace: string, prompt: string): Promise<{ exitCode: number; timedOut: boolean }> {
  return await new Promise((done, reject) => {
    const child = spawn(process.execPath, [cliPath, '--profile', 'mythos', ...(evalPatch ? ['--patch', evalPatch] : []), prompt], {
      cwd: workspace, env: { ...process.env, DSH_HOME: dshHome }, stdio: 'inherit',
    })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, timeoutMs)
    child.once('error', reject)
    child.once('exit', code => { clearTimeout(timer); done({ exitCode: code ?? 1, timedOut }) })
  })
}

if (!process.env.DEEPSEEK_API_KEY || !process.env.DEEPSEEK_BASE_URL) throw new Error('缺少 M3 API 环境变量')
const selected = process.env.MYTHOS_REAL_REPO_CASE
const chosen = selected ? realRepoCases.filter(testCase => testCase.id === selected) : realRepoCases
if (chosen.length === 0) throw new Error(`未知真实仓库任务：${selected}`)
const startedAt = new Date().toISOString()
const cases = []
for (const testCase of chosen) {
  process.stdout.write(`\n[Mythos Real Repo] ${testCase.id}\n`)
  const beforeSessions = await sessions()
  const workspace = await mkdtemp(join(tmpdir(), `mythos-real-${testCase.id}-`))
  const started = performance.now()
  let processResult = { exitCode: 1, timedOut: false }
  let verification = { evidence: {}, passed: false, reason: '真实仓库任务未完成' }
  try {
    await extractRevision(testCase.parentRevision, workspace)
    const initial = await hashes(workspace)
    processResult = await runAgent(workspace, testCase.prompt)
    const changes = changedFiles(initial, await hashes(workspace))
    const scopeClean = changes.length > 0 && changes.every(path => testCase.targetPaths.includes(path))
    const protectedTestUnchanged = await installFutureTest(repoRoot, workspace, testCase)
    const testExitCode = await run(process.execPath, [vitestPath, 'run', '--configLoader', 'runner', '--config', 'vitest.config.ts', testCase.testPath], workspace, true)
    const passed = processResult.exitCode === 0 && !processResult.timedOut && scopeClean && protectedTestUnchanged && testExitCode === 0
    verification = { evidence: { changedFiles: changes.join(','), protectedTestUnchanged, scopeClean, testExitCode }, passed,
      reason: passed ? '真实历史回归的未来测试通过且修改范围正确' : '未来测试、受保护测试或修改范围失败' }
  } finally { await rm(workspace, { recursive: true, force: true }) }
  const created = [...await sessions()].filter(path => !beforeSessions.has(path))
  const raw = created.length === 1 ? created[0] : undefined
  const metrics = raw ? readCompressedSessionMetrics(raw) : undefined
  const behaviorPassed = metrics !== undefined && metrics.mutationCalls > 0 && metrics.evidenceAfterMutation
  cases.push({ behaviorVerification: { evidence: { evidenceAfterMutation: metrics?.evidenceAfterMutation ?? false, mutationCalls: metrics?.mutationCalls ?? 0 },
    passed: behaviorPassed, reason: behaviorPassed ? '修改后验证轨迹通过' : '缺少唯一原始会话或修改后验证' },
    dimensions: testCase.dimensions, durationMs: Math.round(performance.now() - started), id: testCase.id, metrics,
    ...(metrics ? { metricsSource: 'dsh_session_log' as const } : {}),
    passed: verification.passed && behaviorPassed, processExitCode: processResult.exitCode,
    rawSession: raw ? relative(productRoot, raw) : undefined, tier: 'real-repository', timedOut: processResult.timedOut, verification })
}
const dsh = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as { version: string }
const mythos = JSON.parse(await readFile(join(productRoot, 'package.json'), 'utf8')) as { version: string }
const draft = { baseline: { configurationSha256: await realRepoConfigurationSha256(productRoot, evalPatch), dshVersion: dsh.version,
  mythosVersion: mythos.version, suite: 'real-repository', timeoutMs,
  variant: process.env.MYTHOS_EVAL_VARIANT ?? 'default' },
  cases, completedAt: new Date().toISOString(), model: process.env.MYTHOS_EVAL_MODEL ?? 'deepseek-v4-flash', passed: cases.every(item => item.passed),
  profile: 'mythos', reportVersion: 1, runId: randomUUID(), startedAt }
const report = await buildEvaluationReport({
  cases,
  config: { caseIds: chosen.map(testCase => testCase.id), endpoint: process.env.DEEPSEEK_BASE_URL,
    profile: 'mythos', suite: 'real-repository', timeoutMs, variant: process.env.MYTHOS_EVAL_VARIANT ?? 'default' },
  draft,
  entry: 'real-repository',
  overlays: evalPatch ? [relative(productRoot, evalPatch)] : [],
  productRoot,
  repoRoot,
  requestedModel: process.env.MYTHOS_EVAL_MODEL ?? 'deepseek-v4-flash',
  requestedProvider: process.env.MYTHOS_EVAL_PROVIDER ?? 'deepseek',
})
await mkdir(join(productRoot, 'runs'), { recursive: true })
const reportPath = join(productRoot, 'runs', `${startedAt.replaceAll(':', '-')}.json`)
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(`\n[Mythos Real Repo] ${report.passed ? 'PASS' : 'FAIL'} ${reportPath}\n`)
if (!report.passed) process.exitCode = 1
