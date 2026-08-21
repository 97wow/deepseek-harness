import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildEvaluationReport,
  classifyFailure,
  endpointCommitment,
  evaluationCommitment,
  evaluationEntrypoints,
  extractEvaluationEntrypoints,
  internalEvaluationModules,
  implementationFiles,
  parseEvaluationReport,
  sourceEvidence,
  validateBilling,
  validateTokens,
  type EvaluationEntry,
  type ReportCase,
} from './report-contract.js'

const execFileAsync = promisify(execFile)
const entries: EvaluationEntry[] = ['advanced-journey', 'journey', 'qwen-local', 'real-repository', 'standard']

async function fixture(): Promise<{ productRoot: string; repoRoot: string }> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'mythos-report-'))
  const productRoot = join(repoRoot, 'product')
  const files = [...new Set(entries.flatMap(entry => implementationFiles(entry, entry === 'advanced-journey'
    ? ['eval/overlays/journey-subagent.yml'] : [])))]
  for (const name of files) {
    const path = join(productRoot, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, name === 'package.json' ? JSON.stringify({
      mythos: { dshCommit: 'dsh-commit', dshVersion: '0.1.0-rc.8' }, version: '0.1.1',
    }) : `${name}:initial\n`)
  }
  await execFileAsync('git', ['init', '-q'], { cwd: repoRoot })
  await execFileAsync('git', ['config', 'user.email', 'mythos@test.invalid'], { cwd: repoRoot })
  await execFileAsync('git', ['config', 'user.name', 'Mythos Test'], { cwd: repoRoot })
  await execFileAsync('git', ['add', 'product'], { cwd: repoRoot })
  await execFileAsync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot })
  return { productRoot, repoRoot }
}

function completeCase(overrides: Partial<ReportCase> = {}): ReportCase {
  return {
    agentIdleObserved: true,
    billing: { amount: 1, currency: 'USD', source: 'provider_invoice', verified: true },
    id: 'case',
    metrics: { cacheReadTokens: 3, inputTokens: 10, outputTokens: 2, turnReason: 'completed' },
    metricsSource: 'dsh_session_log',
    passed: true,
    processExitCode: 0,
    sessionFlushObserved: true,
    verification: { passed: true },
    ...overrides,
  }
}

async function reportInput(productRoot: string, repoRoot: string, cases: ReportCase[]): Promise<Record<string, unknown>> {
  return await buildEvaluationReport({
    cases,
    config: { endpoint: 'https://example.invalid/v1?secret=never', timeoutMs: 10 },
    draft: { baseline: { suite: 'release', timeoutMs: 10, variant: 'default' }, runId: 'run-1' },
    entry: 'standard', productRoot, repoRoot, requestedModel: 'requested-model', requestedProvider: 'requested-provider',
  })
}

function registryMatches(scripts: Readonly<Record<string, string>>): boolean {
  try {
    const actual = [...new Set(Object.values(scripts).flatMap(extractEvaluationEntrypoints))].sort()
    return JSON.stringify(actual) === JSON.stringify(Object.keys(evaluationEntrypoints).sort())
  } catch {
    return false
  }
}

describe('M3 + DSH 评测证据报告', () => {
  it('tracked diff digest 稳定且与 untracked 状态分离', async () => {
    const { productRoot, repoRoot } = await fixture()
    await writeFile(join(productRoot, 'eval/run.ts'), 'changed\n')
    await writeFile(join(repoRoot, 'untracked-sensitive-value'), 'content-must-not-be-read')
    const first = await sourceEvidence(repoRoot)
    const second = await sourceEvidence(repoRoot)
    expect(first).toEqual(second)
    expect(first.worktree).toEqual({ trackedDirty: true, untrackedPresent: true })
    expect(first.dirtyDiff.scope).toBe('tracked-head-diff-only')
    const report = await reportInput(productRoot, repoRoot, [completeCase()])
    expect(report.acceptance).toMatchObject({
      failures: expect.arrayContaining(['tracked_source_dirty', 'untracked_source_present']), passed: false,
    })
    expect(JSON.stringify(report)).not.toContain('content-must-not-be-read')
  })

  it('中央清单覆盖 Qwen 入口和 provider/model/endpoint/overlay/timeout/variant 设置逻辑', () => {
    expect(implementationFiles('qwen-local')).toEqual(expect.arrayContaining([
      'eval/run-qwen-local.ts', 'eval/run.ts', 'eval/options.ts', 'eval/overlays/qwen-local.yml',
    ]))
  })

  it.each(entries)('%s 的每个中央关键文件变更都会改变 commitment', async entry => {
    const { productRoot } = await fixture()
    const overlays = entry === 'advanced-journey' ? ['eval/overlays/journey-subagent.yml'] : []
    let previous = await evaluationCommitment({ config: { endpoint: 'https://example.invalid/v1', timeoutMs: 1 }, entry, overlays, productRoot })
    for (const file of implementationFiles(entry, overlays)) {
      await writeFile(join(productRoot, file), `${file}:changed:${previous.sha256}\n`)
      const next = await evaluationCommitment({ config: { endpoint: 'https://example.invalid/v1', timeoutMs: 1 }, entry, overlays, productRoot })
      expect(next.sha256, file).not.toBe(previous.sha256)
      previous = next
    }
  })

  it('package scripts 的公开 eval 入口与中央注册表双向一致', async () => {
    const manifest = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    const files = Object.values(manifest.scripts).flatMap(extractEvaluationEntrypoints).sort()
    expect(Object.keys(evaluationEntrypoints).sort()).toEqual([...new Set(files)])
    expect(new Set(files).size).toBe(10)
    expect(Object.keys(evaluationEntrypoints)).toHaveLength(10)
    expect(evaluationEntrypoints['qwen-local-benchmark.ts']).toBe('qwen-local')
  })

  it.each([
    ['tsx --tsconfig eval/not-entry.ts eval/real.ts --flag', ['real.ts']],
    ['tsx -p eval/not-entry.ts eval/real.ts --flag', ['real.ts']],
    ['echo tsx eval/not-entry.ts && tsx eval/real.ts', ['real.ts']],
    ["printf '%s' 'tsx eval/not-entry.ts' && tsx eval/real.ts", ['real.ts']],
    ['tsx --tsconfig config.json eval/new-entry.ts --case a', ['new-entry.ts']],
    ['tsx ./eval/new-entry.ts --case a', ['new-entry.ts']],
    ["MODE=test tsx 'eval/new-entry.ts' --case a", ['new-entry.ts']],
    ['MODE=test tsx "./eval/new-entry.ts" --case a', ['new-entry.ts']],
    ['MODE=test env EXTRA=value tsx eval/new-entry.ts --case a', ['new-entry.ts']],
    ['env -u OLD MODE=test pnpm exec tsx eval/new-entry.ts --case a', ['new-entry.ts']],
    ['npx --yes tsx ./eval/new-entry.ts --case a', ['new-entry.ts']],
    ['command tsx eval/new-safe.ts', ['new-safe.ts']],
    ['MODE=test command -p time -p tsx ./eval/new-safe.ts --case a', ['new-safe.ts']],
    ['tsx eval/new\\-entry.ts --case a', ['new-entry.ts']],
    ['tsx product/launch.ts && tsx --tsconfig x eval/new-entry.ts --variant v || echo failed; tsx eval/other.ts', ['new-entry.ts', 'other.ts']],
    ['echo ok # tsx eval/not-entry.ts', []],
    ['echo ok # tsx eval/not-entry.ts\ntsx eval/real.ts', ['real.ts']],
    ["printf '%s' '# tsx eval/not-entry.ts' && tsx eval/real.ts", ['real.ts']],
    ['echo ok \\\n# ignored ; tsx eval/run.ts', []],
    ['echo ok \\\n   # ignored ; tsx eval/run.ts', []],
    ['echo ok \\\ntsx eval/run.ts', []],
    ['echo ok && \\\ntsx eval/run.ts', ['run.ts']],
    ['tsx eval/run-\\\ncomprehensive.ts', ['run-comprehensive.ts']],
    ['tsx "eval/run-\\\ncomprehensive.ts"', ['run-comprehensive.ts']],
    ['tsx \\\n\\\neval/run.ts', ['run.ts']],
    ['tsx product/launch.ts eval/not-an-entry.ts', []],
    ['tsc --noEmit eval/not-an-entry.ts', []],
  ])('静态提取公开入口：%s', (command, expected) => {
    expect(extractEvaluationEntrypoints(command)).toEqual(expected)
  })

  it.each([
    'tsx --unknown eval/real.ts',
    "tsx 'eval/real.ts",
    'tsx $(printf eval/real.ts)',
    'tsx `printf eval/real.ts`',
    'tsx "eval/$ENTRY.ts"',
    '$RUNNER eval/real.ts',
    "sh -c 'tsx eval/real.ts'",
    "/bin/sh -c 'tsx eval/real.ts'",
    "./bash -c 'tsx eval/real.ts'",
    "/usr/bin/env sh -c 'tsx eval/real.ts'",
    'pnpm --silent exec tsx eval/real.ts',
    'runner eval/real.ts',
    'command runner eval/real.ts',
    'pnpm test eval/real.ts',
    'tsx .\\eval\\real.ts',
    'tsx ..\\eval\\real.ts',
    'tsx\u00a0eval/real.ts',
    'echo ok\rtsx eval/new-safe.ts',
    'echo ok\r\ntsx eval/new-safe.ts',
    'echo ok \\\r\ntsx eval/new-safe.ts',
    'tsx "eval/run-\r\ncomprehensive.ts"',
    "tsx 'eval/run-\r\ncomprehensive.ts'",
    'echo ok # ignored\r\ntsx eval/new-safe.ts',
    'echo ok\ntsx eval/run.ts\r\necho done',
    "tsx 'eval/run-\\\ncomprehensive.ts'",
    'tsx eval/run.ts\\',
    'tsx eval/real.ts > result.txt',
    'tsx eval/real.ts < input.txt',
    'echo ok | tsx eval/real.ts',
  ])('无法安全静态解析时 fail closed：%s', command => {
    expect(() => extractEvaluationEntrypoints(command)).toThrow()
  })

  it.each([
    'command tsx eval/new-safe.ts',
    'time tsx eval/new-safe.ts',
    'runner eval/new-safe.ts',
    "sh -c 'tsx eval/new-safe.ts'",
    "/usr/bin/env /bin/sh -c 'tsx eval/new-safe.ts'",
    'tsx .\\eval\\new-safe.ts',
    'tsx\u00a0eval/new-safe.ts',
  ])('可疑 script 注入 package scripts 时 registry 不会伪通过：%s', injected => {
    const scripts = Object.fromEntries(Object.keys(evaluationEntrypoints).map(filename => [filename, `tsx eval/${filename}`]))
    expect(registryMatches({ ...scripts, injected })).toBe(false)
  })

  it('package script 的 POSIX 注释不会制造虚假入口', () => {
    const scripts = Object.fromEntries(Object.keys(evaluationEntrypoints).map(filename => [filename, `tsx eval/${filename}`]))
    expect(registryMatches({ ...scripts, comment: 'echo ok # tsx eval/not-an-entry.ts' })).toBe(true)
  })

  it('反斜线续行后的注释替换已注册 script 时 registry 不再伪报 10/10', () => {
    const scripts = Object.fromEntries(Object.keys(evaluationEntrypoints).map(filename => [filename, `tsx eval/${filename}`]))
    scripts['run.ts'] = 'echo ok \\\n# ignored ; tsx eval/run.ts'
    expect(registryMatches(scripts)).toBe(false)
  })

  it('反斜线 CRLF script 动态加入 registry 时 fail closed', () => {
    const scripts = Object.fromEntries(Object.keys(evaluationEntrypoints).map(filename => [filename, `tsx eval/${filename}`]))
    expect(registryMatches({ ...scripts, injected: 'echo ok \\\r\ntsx eval/new-safe.ts' })).toBe(false)
  })

  it('内部非公开 runner 显式声明全部 commitment 归属', () => {
    for (const [filename, owners] of Object.entries(internalEvaluationModules)) {
      for (const owner of owners) expect(implementationFiles(owner)).toContain(`eval/${filename}`)
    }
  })

  it('endpoint commitment 对完整 URL 语义敏感并拒绝 userinfo', () => {
    const values = [
      'https://example.invalid:8443/v1?a=secret#route', 'http://example.invalid:8443/v1?a=secret#route',
      'https://other.invalid:8443/v1?a=secret#route', 'https://example.invalid:9443/v1?a=secret#route',
      'https://example.invalid:8443/v2?a=secret#route', 'https://example.invalid:8443/v1?a=other#route',
      'https://example.invalid:8443/v1?a=secret#other',
    ]
    expect(new Set(values.map(value => endpointCommitment(value).sha256)).size).toBe(values.length)
    expect(() => endpointCommitment('https://user:password@example.invalid/v1')).toThrow('userinfo')
  })

  it('case selection 与运行参数变化改变 runtime commitment', async () => {
    const { productRoot } = await fixture()
    const first = await evaluationCommitment({ config: { caseIds: ['a'], endpoint: 'https://example.invalid/v1', profile: 'mythos', repeat: 1,
      timeoutMs: 1, variant: 'a' }, entry: 'standard', productRoot })
    const second = await evaluationCommitment({ config: { caseIds: ['b'], endpoint: 'https://example.invalid/v1', profile: 'mythos', repeat: 2,
      timeoutMs: 2, variant: 'b' }, entry: 'standard', productRoot })
    expect(second.sha256).not.toBe(first.sha256)
    expect(JSON.stringify(second)).not.toContain('example.invalid')
  })

  it('unknown 服务端身份使正式接受 fail closed', async () => {
    const { productRoot, repoRoot } = await fixture()
    const report = await reportInput(productRoot, repoRoot, [completeCase()])
    expect(report.passed).toBe(false)
    expect(report.modelIdentity).toMatchObject({ server: { status: 'unknown_unverified' } })
    expect(report.acceptance).toMatchObject({ failures: expect.arrayContaining(['server_identity_unverified']), passed: false })
  })

  it('零测试不得伪绿', async () => {
    const { productRoot, repoRoot } = await fixture()
    expect((await reportInput(productRoot, repoRoot, [])).acceptance)
      .toMatchObject({ failures: expect.arrayContaining(['zero_cases']), passed: false })
  })

  it('passed true 不能绕过 observability gap，且三类失败互斥', () => {
    const model = completeCase({ passed: false, verification: { passed: false } })
    const infrastructure = completeCase({ passed: false, timedOut: true })
    const harness = completeCase({ billing: undefined, passed: true })
    const trust = { billing: true, identity: true }
    expect(classifyFailure(model, trust)).toEqual({ category: 'model_failure', reason: 'external_verifier_rejected' })
    expect(classifyFailure(infrastructure, trust)).toEqual({ category: 'infrastructure_failure', reason: 'timeout' })
    expect(classifyFailure(harness, trust)).toEqual({ category: 'harness_failure', reason: 'observability_gap' })
    expect(classifyFailure(completeCase(), trust)).toEqual({ category: null, reason: null })
  })

  it.each([
    [{ inputTokens: 1, outputTokens: 2 }, 'dsh_session_log'],
    [{ cacheReadTokens: -1, inputTokens: 1, outputTokens: 2 }, 'dsh_session_log'],
    [{ cacheReadTokens: 0, inputTokens: Number.NaN, outputTokens: 2 }, 'dsh_session_log'],
    [{ cacheReadTokens: 0, inputTokens: 1.5, outputTokens: 2 }, 'dsh_session_log'],
    [{ cacheReadTokens: 0, inputTokens: 1, outputTokens: 2 }, 'environment_label'],
  ])('非法或不可信 token 证据被独立拒绝', (metrics, source) => {
    expect(validateTokens(metrics, source).verified).toBe(false)
  })

  it.each([
    null,
    { amount: Number.NaN, currency: 'USD', source: 'provider_invoice', verified: true },
    { amount: Number.POSITIVE_INFINITY, currency: 'USD', source: 'provider_invoice', verified: true },
    { amount: -1, currency: 'USD', source: 'provider_invoice', verified: true },
    { amount: 1, currency: 'usd', source: 'provider_invoice', verified: true },
    { amount: 1, currency: 'ZZZ', source: 'provider_invoice', verified: true },
    { amount: 1, currency: 'USD', source: 'environment_label', verified: true },
    { amount: 1, currency: 'USD', source: 'provider_invoice', verified: false },
  ])('非法或不可信费用证据被独立拒绝', billing => {
    expect(validateBilling(billing).verified).toBe(false)
  })

  it('合法费用字段仍需可信采集上下文', () => {
    const billing = { amount: 1, currency: 'USD', source: 'provider_invoice', verified: true }
    expect(validateBilling(billing).verified).toBe(false)
    expect(validateBilling(billing, true).verified).toBe(true)
  })

  it('显式 allowlist 递归阻断 case/draft 敏感字段、正文、headers 与 endpoint query', async () => {
    const { productRoot, repoRoot } = await fixture()
    const leaks = ['credential-never', 'user-body-never', 'system-prompt-never', 'tool-args-never', 'tool-result-never', 'header-never', 'query-never', 'forged-server-model']
    const testCase = completeCase() as ReportCase & Record<string, unknown>
    testCase.secret = { apiKey: leaks[0], nested: [{ body: leaks[1], systemPrompt: leaks[2] }] }
    testCase.tool = { args: leaks[3], result: leaks[4] }
    const report = await buildEvaluationReport({
      cases: [testCase], config: { endpoint: `https://example.invalid?v=${leaks[6]}` },
      draft: { headers: { Authorization: leaks[5] }, arbitrary: { nested: leaks[1] }, endpoint: `https://x.invalid?${leaks[6]}`, serverModel: leaks[7] },
      entry: 'standard', productRoot, repoRoot, requestedModel: 'm', requestedProvider: 'p',
    })
    const serialized = JSON.stringify(report)
    for (const leak of leaks) expect(serialized).not.toContain(leak)
  })

  it('v1 可解析但 v2 schema 必须显式合法', () => {
    expect(parseEvaluationReport({ cases: [], reportVersion: 1 }).reportVersion).toBe(1)
    expect(parseEvaluationReport({
      acceptance: { failures: ['server_identity_unverified', 'billing_unverified', 'completion_evidence_incomplete', 'zero_cases'], passed: false },
      cases: [], implementation: { entry: 'standard', files: [], runtime: { endpoint: { sha256: 'endpoint' }, parametersSha256: 'parameters' }, sha256: 'hash' },
      modelIdentity: { server: { status: 'unknown_unverified' } }, passed: false, reportVersion: 2, runId: 'run-1',
      source: { gitHead: 'head', worktree: { trackedDirty: false, untrackedPresent: false } },
    }).reportVersion).toBe(2)
    expect(() => parseEvaluationReport({ cases: [], reportVersion: 2 })).toThrow('schema')
  })
})
