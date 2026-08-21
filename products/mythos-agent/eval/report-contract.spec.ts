import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildEvaluationReport,
  classifyFailure,
  endpointCommitment,
  evaluationCommitment,
  implementationFiles,
  parseEvaluationReport,
  sourceEvidence,
  validateBilling,
  validateTokens,
  type EvaluationEntry,
  type ReportCase,
} from './report-contract.js'
import { evaluationEntryRegistry } from './entry-registry.js'

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
    const contents = name === 'package.json' ? JSON.stringify({
      mythos: { dshCommit: 'dsh-commit', dshVersion: '0.1.0-rc.8' }, version: '0.1.1',
    }) : name === 'eval/launch.ts' ? 'await import(dynamicEntry)\n'
      : name === 'eval/journey-turn-runner.ts' ? 'require.resolve(dynamicPackage)\n' : `${name}:initial\n`
    await writeFile(path, contents)
  }
  const packageDefinitions = [
    ['@deepseek-ai/dsh-agent', 'packages/core/agent'],
    ['@deepseek-ai/dsh-llm', 'packages/llm/llm'],
    ['@deepseek-ai/dsh-session', 'packages/core/session'],
  ] as const
  await mkdir(join(repoRoot, 'apps/cli'), { recursive: true })
  await writeFile(join(repoRoot, 'apps/cli/package.json'), JSON.stringify({
    devDependencies: Object.fromEntries(packageDefinitions.map(([name]) => [name, 'workspace:^'])),
  }))
  await writeFile(join(repoRoot, 'package.json'), '{}')
  await writeFile(join(repoRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  await writeFile(join(repoRoot, 'pnpm-workspace.yaml'), 'packages: []\n')
  for (const [name, directory] of packageDefinitions) {
    await mkdir(join(repoRoot, directory, 'src'), { recursive: true })
    await writeFile(join(repoRoot, directory, 'package.json'), JSON.stringify({
      exports: { '.': { default: './lib/index.js' } }, main: 'lib/index.js', name,
    }))
    await writeFile(join(repoRoot, directory, 'src/index.ts'), `export const packageName = '${name}'\n`)
  }
  await execFileAsync('git', ['init', '-q'], { cwd: repoRoot })
  await execFileAsync('git', ['config', 'user.email', 'mythos@test.invalid'], { cwd: repoRoot })
  await execFileAsync('git', ['config', 'user.name', 'Mythos Test'], { cwd: repoRoot })
  await execFileAsync('git', ['add', '.'], { cwd: repoRoot })
  await execFileAsync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot })
  return { productRoot, repoRoot }
}

function commitmentFilePath(productRoot: string, repoRoot: string, path: string): string {
  return path.startsWith('workspace:') ? join(repoRoot, path.slice('workspace:'.length)) : join(productRoot, path)
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

  it.each([...evaluationEntryRegistry.keys()])('%s registry entry 的每个关键文件变更都会改变 commitment', async entryId => {
    const definition = evaluationEntryRegistry.get(entryId)!
    const { productRoot, repoRoot } = await fixture()
    const overlays = definition.commitment === 'advanced-journey' ? ['eval/overlays/journey-subagent.yml'] : []
    let previous = await evaluationCommitment({ config: { endpoint: 'https://example.invalid/v1', timeoutMs: 1 },
      entry: definition.commitment, entryId, overlays, productRoot })
    for (const file of previous.files.map(item => item.path)) {
      await appendFile(commitmentFilePath(productRoot, repoRoot, file), '\n')
      const nextCommitment = await evaluationCommitment({ config: { endpoint: 'https://example.invalid/v1', timeoutMs: 1 },
        entry: definition.commitment, entryId, overlays, productRoot })
      expect(nextCommitment.sha256, file).not.toBe(previous.sha256)
      previous = nextCommitment
    }
  })

  it.each([...evaluationEntryRegistry.keys()])('%s 的结构化运行参数改变 commitment', async entryId => {
    const definition = evaluationEntryRegistry.get(entryId)!
    const { productRoot } = await fixture()
    const first = await evaluationCommitment({ config: { caseIds: ['a'], endpoint: 'https://example.invalid/v1', marker: 'a' },
      entry: definition.commitment, entryId, productRoot })
    const second = await evaluationCommitment({ config: { caseIds: ['b'], endpoint: 'https://example.invalid/v1', marker: 'b' },
      entry: definition.commitment, entryId, productRoot })
    expect(second.runtime.parametersSha256).not.toBe(first.runtime.parametersSha256)
    expect(second.sha256).not.toBe(first.sha256)
  })

  it('registry 显式覆盖内部 runner 与 launcher commitment', () => {
    expect(evaluationEntryRegistry.get('journey')!.internalDependencies).toContain('eval/journey-turn-runner.ts')
    expect(evaluationEntryRegistry.get('advanced-journey')!.internalDependencies).toContain('eval/journey-turn-runner.ts')
    expect(evaluationEntryRegistry.get('journey-repeat')!.internalDependencies).toContain('eval/options.ts')
    expect(evaluationEntryRegistry.get('advanced-journey-repeat')!.internalDependencies).toContain('eval/options.ts')
    for (const entry of entries) {
      expect(implementationFiles(entry)).toEqual(expect.arrayContaining([
        'eval/entry-registry.ts', 'eval/import-closure.ts', 'eval/launch.ts', 'package.json',
      ]))
    }
  })

  it.each([...evaluationEntryRegistry.keys()])('%s commitment 完成静态与声明动态依赖闭包验证', async entryId => {
    const definition = evaluationEntryRegistry.get(entryId)!
    const productRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
    const commitment = await evaluationCommitment({ config: { endpoint: 'https://example.invalid/v1' },
      entry: definition.commitment, entryId, productRoot })
    expect(commitment.files.map(file => file.path)).toEqual(expect.arrayContaining([
      'eval/entry-registry.ts', 'eval/import-closure.ts', 'eval/launch.ts', definition.module,
    ]))
    if (definition.commitment === 'journey' || definition.commitment === 'advanced-journey') {
      expect(commitment.files.map(file => file.path)).toEqual(expect.arrayContaining([
        'workspace:apps/cli/package.json', 'workspace:packages/core/agent/package.json',
        'workspace:packages/core/agent/src/index.ts', 'workspace:packages/core/session/package.json',
        'workspace:packages/core/session/src/index.ts', 'workspace:packages/llm/llm/package.json',
        'workspace:packages/llm/llm/src/index.ts',
      ]))
    }
  })

  it('新增相对 import 自动进入 commitment 且被导入文件变异改变 SHA', async () => {
    const { productRoot, repoRoot } = await fixture()
    await writeFile(join(productRoot, 'eval/nested-commitment.ts'), 'export const marker = 1\n')
    await writeFile(join(productRoot, 'eval/run.ts'), "import './nested-commitment.js'\n")
    await execFileAsync('git', ['add', 'product/eval/nested-commitment.ts'], { cwd: repoRoot })
    const first = await evaluationCommitment({ config: { endpoint: 'https://example.invalid/v1' },
      entry: 'standard', entryId: 'standard', productRoot })
    expect(first.files.map(file => file.path)).toContain('eval/nested-commitment.ts')
    await writeFile(join(productRoot, 'eval/nested-commitment.ts'), 'export const marker = 2\n')
    const second = await evaluationCommitment({ config: { endpoint: 'https://example.invalid/v1' },
      entry: 'standard', entryId: 'standard', productRoot })
    expect(second.sha256).not.toBe(first.sha256)
  })

  it('commitment 对 untracked 相对 import fail closed 且不回显正文', async () => {
    const { productRoot } = await fixture()
    await writeFile(join(productRoot, 'eval/untracked-sensitive.ts'), 'secret-user-body-must-not-leak\n')
    await writeFile(join(productRoot, 'eval/run.ts'), "import './untracked-sensitive.js'\n")
    let message = ''
    try {
      await evaluationCommitment({ config: { endpoint: 'https://example.invalid/v1' },
        entry: 'standard', entryId: 'standard', productRoot })
    } catch (error) {
      message = String(error)
    }
    expect(message).toContain('无法解析')
    expect(message).not.toContain('secret-user-body-must-not-leak')
  })

  it('声明的 journey workspace 动态依赖目标变更会改变 digest', async () => {
    const { productRoot, repoRoot } = await fixture()
    const first = await evaluationCommitment({ config: { endpoint: 'https://example.invalid/v1' },
      entry: 'journey', entryId: 'journey', productRoot })
    await appendFile(join(repoRoot, 'packages/core/agent/src/index.ts'), '\nexport const changed = true\n')
    const second = await evaluationCommitment({ config: { endpoint: 'https://example.invalid/v1' },
      entry: 'journey', entryId: 'journey', productRoot })
    expect(second.sha256).not.toBe(first.sha256)
  })

  it('workspace package manifest 改写固定入口时 fail closed', async () => {
    const { productRoot, repoRoot } = await fixture()
    await writeFile(join(repoRoot, 'packages/core/agent/package.json'), JSON.stringify({
      exports: { '.': { default: './lib/other.js' } }, name: '@deepseek-ai/dsh-agent',
    }))
    await expect(evaluationCommitment({ config: { endpoint: 'https://example.invalid/v1' },
      entry: 'journey', entryId: 'journey', productRoot })).rejects.toThrow('固定源码入口不一致')
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
