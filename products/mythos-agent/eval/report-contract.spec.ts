import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
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
import { materializeExecutionArtifact, writeExecutionArtifactManifest } from './execution-snapshot.js'

const execFileAsync = promisify(execFile)
const entries: EvaluationEntry[] = ['advanced-journey', 'journey', 'qwen-local', 'real-repository', 'standard']
const fixtureEntryImports = [
  ['advanced-journey', './run-advanced-journeys.js'],
  ['advanced-journey-repeat', './repeat-advanced-journeys.js'],
  ['comprehensive', './run.js'],
  ['journey', './run-journeys.js'],
  ['journey-repeat', './repeat-journeys.js'],
  ['m3-smoke', './run.js'],
  ['qwen-local', './run.js'],
  ['qwen-local-benchmark', './qwen-local-benchmark.js'],
  ['real-repository', './run-real-repo.js'],
  ['repeat', './repeat.js'],
  ['standard', './run.js'],
] as const

async function fixture(): Promise<{ productRoot: string; repoRoot: string }> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'mythos-report-'))
  const productRoot = join(repoRoot, 'product')
  const files = [...new Set([
    ...entries.flatMap(entry => implementationFiles(entry, entry === 'advanced-journey'
      ? ['eval/overlays/journey-subagent.yml'] : [])),
    ...fixtureEntryImports.map(([, specifier]) => `eval/${specifier.slice(2, -3)}.ts`),
  ])]
  for (const name of files) {
    const path = join(productRoot, name)
    await mkdir(dirname(path), { recursive: true })
    const contents = name === 'package.json' ? JSON.stringify({
      mythos: { dshCommit: 'dsh-commit', dshVersion: '0.1.0-rc.8' }, version: '0.1.1',
    }) : name === 'eval/launch.ts' ? "import './entry-registry.js'\n"
      : name === 'eval/entry-registry.ts' ? `const evaluationEntryDefinitions = [\n${fixtureEntryImports
        .map(([id, specifier]) => `  ['${id}', { load: async () => await import('${specifier}') }],`).join('\n')}\n]\n`
      : name === 'eval/journey-turn-runner.ts'
        ? ["import '@deepseek-ai/dsh-agent/src/model-selection.ts'", "import '@deepseek-ai/dsh-llm/message'",
          "import '@deepseek-ai/dsh-session/types'"].join('\n') + '\n'
        : name.endsWith('.ts') ? 'export {}\n' : `${name}:initial\n`
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
    name: '@deepseek-ai/dsh',
  }))
  await writeFile(join(repoRoot, 'package.json'), '{}')
  await writeFile(join(repoRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  await writeFile(join(repoRoot, 'pnpm-workspace.yaml'), "packages:\n  - apps/*\n  - packages/*/*\n")
  for (const [name, directory] of packageDefinitions) {
    await mkdir(join(repoRoot, directory, 'src'), { recursive: true })
    const sourceName = name.endsWith('dsh-agent') ? 'model-selection'
      : name.endsWith('dsh-llm') ? 'message' : 'types'
    const exports = name.endsWith('dsh-agent')
      ? { '.': { default: './lib/index.js' }, './src/*': './src/*' }
      : { '.': { default: './lib/index.js' }, [`./${sourceName}`]: { default: `./lib/types/${sourceName}.js` } }
    await writeFile(join(repoRoot, directory, 'package.json'), JSON.stringify({
      exports, main: 'lib/index.js', name,
    }))
    await writeFile(join(repoRoot, directory, 'src/index.ts'), `export const packageName = '${name}'\n`)
    await writeFile(join(repoRoot, directory, `src/${sourceName}.ts`), `export const packageName = '${name}'\n`)
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
    id: 'case',
    metrics: { cacheReadTokens: 3, inputTokens: 10, outputTokens: 2, turnReason: 'completed', usageObserved: true },
    metricsSource: 'dsh_session_log',
    passed: true,
    processExitCode: 0,
    runtimeEvidence: {
      agentIdleObserved: true,
      providerResponses: [{
        billing: { amount: 1, currency: 'USD', source: 'provider_invoice' },
        identity: { deployment: 'm3-production', model: 'deepseek-v4-flash', provider: 'deepseek' },
        source: 'm3_provider_response',
      }],
      sessionFlushObserved: true,
    },
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

  it('commitment 绑定整个 tracked tree、lockfile、manifest、registry 与配置，但忽略未提交工作树正文', async () => {
    const { productRoot, repoRoot } = await fixture()
    const first = await evaluationCommitment({ config: { endpoint: 'https://example.invalid/v1', marker: 'a' },
      entry: 'standard', entryId: 'standard', productRoot })
    expect(first.files.map(file => file.path)).toEqual(expect.arrayContaining([
      'eval/entry-registry.ts', 'eval/execution-snapshot.ts', 'workspace:package.json', 'workspace:pnpm-lock.yaml',
    ]))
    await writeFile(join(productRoot, 'eval/run.ts'), 'secret-uncommitted-body\n')
    expect((await evaluationCommitment({ config: { endpoint: 'https://example.invalid/v1', marker: 'a' },
      entry: 'standard', entryId: 'standard', productRoot })).sha256).toBe(first.sha256)
    expect(JSON.stringify(first)).not.toContain('secret-uncommitted-body')
    await execFileAsync('git', ['add', 'product/eval/run.ts'], { cwd: repoRoot })
    await execFileAsync('git', ['commit', '-qm', 'tracked change'], { cwd: repoRoot })
    expect((await evaluationCommitment({ config: { endpoint: 'https://example.invalid/v1', marker: 'a' },
      entry: 'standard', entryId: 'standard', productRoot })).sha256).not.toBe(first.sha256)
  })

  it.each([...evaluationEntryRegistry.keys()])('%s 的结构化运行参数改变 commitment', async entryId => {
    const definition = evaluationEntryRegistry.get(entryId)!
    const { productRoot } = await fixture()
    const first = await evaluationCommitment({ config: { endpoint: 'https://example.invalid/v1', marker: 'a' },
      entry: definition.commitment, entryId, productRoot })
    const second = await evaluationCommitment({ config: { endpoint: 'https://example.invalid/v1', marker: 'b' },
      entry: definition.commitment, entryId, productRoot })
    expect(second.runtime.parametersSha256).not.toBe(first.runtime.parametersSha256)
    expect(second.sha256).not.toBe(first.sha256)
  })

  it('工作树报告明确拒绝未验证离线执行产物', async () => {
    const { productRoot, repoRoot } = await fixture()
    const report = await reportInput(productRoot, repoRoot, [completeCase()])
    expect(report.acceptance).toMatchObject({
      failures: expect.arrayContaining(['execution_snapshot_unverified']), passed: false,
    })
    const implementation = report.implementation as { runtime: { dependencyState: string } }
    expect(implementation.runtime.dependencyState).toBe('offline_artifact_required')
  })

  it('报告绑定已离线重验的 artifact、cwd、commit、tree、command、entry 与 DSH identity', async () => {
    const { repoRoot } = await fixture()
    const temporary = await mkdtemp(join(tmpdir(), 'mythos-report-artifact-'))
    const artifactRoot = join(temporary, 'artifact')
    const manifestPath = join(temporary, 'manifest.json')
    const artifact = await materializeExecutionArtifact(repoRoot, artifactRoot, undefined, {
      async install(path) { await mkdir(join(path, 'node_modules'), { recursive: true }) },
      async build() {},
    })
    await writeExecutionArtifactManifest(manifestPath, artifact)
    const previous = {
      manifest: process.env.MYTHOS_EVAL_ARTIFACT_MANIFEST,
      root: process.env.MYTHOS_EVAL_ARTIFACT_ROOT,
      invocation: process.env.MYTHOS_EVAL_INVOCATION_JSON,
    }
    process.env.MYTHOS_EVAL_ARTIFACT_MANIFEST = manifestPath
    process.env.MYTHOS_EVAL_ARTIFACT_ROOT = artifactRoot
    process.env.MYTHOS_EVAL_INVOCATION_JSON = JSON.stringify(['standard'])
    try {
      const productRoot = join(artifactRoot, 'product')
      const report = await reportInput(productRoot, artifactRoot, [completeCase()])
      const implementation = report.implementation as Record<string, unknown>
      const runtime = implementation.runtime as Record<string, unknown>
      const snapshot = implementation.snapshot as Record<string, unknown>
      expect(runtime).toMatchObject({ artifactSha256: artifact.sha256, command: 'tsx eval/launch.ts standard',
        cwd: 'product', dependencyState: 'offline_artifact_verified' })
      expect(implementation.entryId).toBe('standard')
      expect(snapshot).toMatchObject({ gitCommit: artifact.source.gitCommit, gitTree: artifact.source.gitTree })
      expect(report.source).toMatchObject({ dsh: { declaredCommit: 'dsh-commit', declaredVersion: '0.1.0-rc.8' },
        gitHead: artifact.source.gitCommit })
    } finally {
      if (previous.manifest === undefined) delete process.env.MYTHOS_EVAL_ARTIFACT_MANIFEST
      else process.env.MYTHOS_EVAL_ARTIFACT_MANIFEST = previous.manifest
      if (previous.root === undefined) delete process.env.MYTHOS_EVAL_ARTIFACT_ROOT
      else process.env.MYTHOS_EVAL_ARTIFACT_ROOT = previous.root
      if (previous.invocation === undefined) delete process.env.MYTHOS_EVAL_INVOCATION_JSON
      else process.env.MYTHOS_EVAL_INVOCATION_JSON = previous.invocation
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

  it('请求标签不能伪造服务端身份，缺失响应证据时 fail closed', async () => {
    const { productRoot, repoRoot } = await fixture()
    const report = await reportInput(productRoot, repoRoot, [completeCase({
      runtimeEvidence: { agentIdleObserved: true, providerResponses: [], sessionFlushObserved: true },
    })])
    expect(report.passed).toBe(false)
    expect(report.modelIdentity).toMatchObject({ server: { status: 'unknown_unverified' } })
    expect(report.acceptance).toMatchObject({ failures: expect.arrayContaining(['server_identity_unverified']), passed: false })
  })

  it('可信运行字段进入报告并解除对应 observability 拒绝', async () => {
    const { productRoot, repoRoot } = await fixture()
    const report = await reportInput(productRoot, repoRoot, [completeCase()])
    expect(report.modelIdentity).toMatchObject({
      requested: { model: 'requested-model', provider: 'requested-provider' },
      server: { deployment: 'm3-production', model: 'deepseek-v4-flash', provider: 'deepseek', status: 'observed' },
    })
    expect(report.cases).toMatchObject([{
      accepted: true,
      billing: { amount: 1, currency: 'USD', source: 'provider_invoice', tokensVerified: true, verified: true },
      completionEvidence: {
        agentIdle: { status: 'observed', value: true },
        externalVerifier: { status: 'observed', value: true },
        sessionFlush: { status: 'observed', value: true },
        turnReason: { status: 'observed', value: 'completed' },
      },
    }])
    expect((report.acceptance as { failures: string[] }).failures).not.toEqual(expect.arrayContaining([
      'server_identity_unverified', 'billing_unverified', 'completion_evidence_incomplete',
    ]))
  })

  it('费用与 idle/flush 缺失不会由旧标签或零值伪造', async () => {
    const { productRoot, repoRoot } = await fixture()
    const testCase = completeCase({ agentIdleObserved: true, billing: { amount: 0 }, sessionFlushObserved: true })
    testCase.runtimeEvidence = {
      agentIdleObserved: false,
      providerResponses: [{ billing: null,
        identity: { deployment: 'm3-production', model: 'deepseek-v4-flash', provider: 'deepseek' },
        source: 'm3_provider_response' }],
      sessionFlushObserved: false,
    }
    const report = await reportInput(productRoot, repoRoot, [testCase])
    expect(report.cases).toMatchObject([{
      accepted: false,
      billing: { amount: null, verified: false },
      completionEvidence: {
        agentIdle: { status: 'unknown_unverified', value: null },
        sessionFlush: { status: 'unknown_unverified', value: null },
      },
    }])
    expect(report.acceptance).toMatchObject({
      failures: expect.arrayContaining(['billing_unverified', 'completion_evidence_incomplete']), passed: false,
    })
  })

  it('没有 DSH usage 事件时零 token 不能伪装成已观测', async () => {
    const { productRoot, repoRoot } = await fixture()
    const report = await reportInput(productRoot, repoRoot, [completeCase({
      metrics: { cacheReadTokens: 0, inputTokens: 0, outputTokens: 0, turnReason: 'completed' },
    })])
    expect(report.cases).toMatchObject([{ accepted: false, billing: { tokensVerified: false } }])
    expect(report.acceptance).toMatchObject({ failures: expect.arrayContaining(['case_failure']), passed: false })
  })

  it('零测试不得伪绿', async () => {
    const { productRoot, repoRoot } = await fixture()
    expect((await reportInput(productRoot, repoRoot, [])).acceptance)
      .toMatchObject({ failures: expect.arrayContaining(['zero_cases']), passed: false })
  })

  it('passed true 不能绕过 observability gap，且三类失败互斥', () => {
    const model = completeCase({ passed: false, verification: { passed: false } })
    const infrastructure = completeCase({ passed: false, timedOut: true })
    const harness = completeCase({ runtimeEvidence: { agentIdleObserved: true, providerResponses: [], sessionFlushObserved: true } })
    expect(classifyFailure(model)).toEqual({ category: 'model_failure', reason: 'external_verifier_rejected' })
    expect(classifyFailure(infrastructure)).toEqual({ category: 'infrastructure_failure', reason: 'timeout' })
    expect(classifyFailure(harness)).toEqual({ category: 'harness_failure', reason: 'observability_gap' })
    expect(classifyFailure(completeCase())).toEqual({ category: null, reason: null })
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
      modelIdentity: { server: { deployment: null, model: null, provider: null, source: null, status: 'unknown_unverified' } },
      passed: false, reportVersion: 2, runId: 'run-1',
      source: { gitHead: 'head', worktree: { trackedDirty: false, untrackedPresent: false } },
    }).reportVersion).toBe(2)
    expect(() => parseEvaluationReport({ cases: [], reportVersion: 2 })).toThrow('schema')
  })
})
