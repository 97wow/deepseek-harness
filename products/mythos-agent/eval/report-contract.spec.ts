import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  buildEvaluationReport,
  classifyFailure,
  evaluationCommitment,
  parseEvaluationReport,
  sourceEvidence,
  type ReportCase,
} from './report-contract.js'

const execFileAsync = promisify(execFile)

async function fixture(): Promise<{ productRoot: string; repoRoot: string }> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'mythos-report-'))
  const productRoot = join(repoRoot, 'product')
  await mkdir(productRoot)
  await writeFile(join(productRoot, 'package.json'), JSON.stringify({
    mythos: { dshCommit: 'dsh-commit', dshVersion: '0.1.0-rc.8' },
    version: '0.1.1',
  }))
  for (const name of ['profile.yml', 'overlay.yml', 'cases.ts', 'runner.ts', 'verifier.ts']) {
    await writeFile(join(productRoot, name), `${name}:initial\n`)
  }
  await execFileAsync('git', ['init', '-q'], { cwd: repoRoot })
  await execFileAsync('git', ['config', 'user.email', 'mythos@test.invalid'], { cwd: repoRoot })
  await execFileAsync('git', ['config', 'user.name', 'Mythos Test'], { cwd: repoRoot })
  await execFileAsync('git', ['add', 'product'], { cwd: repoRoot })
  await execFileAsync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot })
  return { productRoot, repoRoot }
}

const commitmentFiles = ['profile.yml', 'overlay.yml', 'cases.ts', 'runner.ts', 'verifier.ts']

describe('M3 + DSH 评测证据报告', () => {
  it('对相同 dirty diff 产生稳定 digest，并对变化敏感', async () => {
    const { productRoot, repoRoot } = await fixture()
    await writeFile(join(productRoot, 'runner.ts'), 'runner:changed\n')
    const first = await sourceEvidence(repoRoot)
    const second = await sourceEvidence(repoRoot)
    expect(first.dirtyDiff).toEqual(second.dirtyDiff)
    expect(first.worktree.clean).toBe(false)
    await writeFile(join(productRoot, 'runner.ts'), 'runner:changed-again\n')
    expect((await sourceEvidence(repoRoot)).dirtyDiff.sha256).not.toBe(first.dirtyDiff.sha256)
  })

  it.each(['cases.ts', 'runner.ts', 'verifier.ts'])('完整 commitment 对 %s 变化敏感', async changed => {
    const { productRoot } = await fixture()
    const before = await evaluationCommitment({ config: { timeoutMs: 1 }, files: commitmentFiles, productRoot })
    await writeFile(join(productRoot, changed), `${changed}:changed\n`)
    const after = await evaluationCommitment({ config: { timeoutMs: 1 }, files: commitmentFiles, productRoot })
    expect(after.sha256).not.toBe(before.sha256)
    expect(after.files.map(file => file.path)).toEqual(commitmentFiles.slice().sort())
  })

  it('身份未知与费用缺失使正式接受 fail closed', async () => {
    const { productRoot, repoRoot } = await fixture()
    const report = await buildEvaluationReport({
      cases: [{
        id: 'case', metrics: { cacheReadTokens: 3, inputTokens: 10, outputTokens: 2, turnReason: 'completed' },
        passed: true, verification: { passed: true },
      }],
      commitment: { config: {}, files: commitmentFiles, productRoot },
      draft: { cases: [], passed: true, reportVersion: 1 },
      repoRoot,
      requestedModel: 'requested-model',
      requestedProvider: 'requested-provider',
    })
    expect(report.passed).toBe(false)
    expect(report.modelIdentity).toMatchObject({
      requested: { model: 'requested-model', provider: 'requested-provider' },
      server: { status: 'unknown_unverified' },
    })
    expect((report.cases as Record<string, unknown>[])[0]).toMatchObject({
      billing: {
        amount: null,
        currency: null,
        source: 'unavailable',
        tokens: { cache: 3, input: 10, output: 2 },
        tokensVerified: true,
        verified: false,
      },
    })
    expect(report.acceptance).toMatchObject({
      failures: expect.arrayContaining(['server_identity_unverified', 'billing_unverified']),
      passed: false,
    })
  })

  it('零测试不得伪绿', async () => {
    const { productRoot, repoRoot } = await fixture()
    const report = await buildEvaluationReport({
      cases: [], commitment: { config: {}, files: commitmentFiles, productRoot }, draft: {}, repoRoot,
      requestedModel: 'm', requestedProvider: 'p',
    })
    expect(report.acceptance).toMatchObject({ failures: expect.arrayContaining(['zero_cases']), passed: false })
  })

  it('失败分类互斥且 observability gap 归入 harness failure', () => {
    const inputs: ReportCase[] = [
      { id: 'model', metrics: {}, passed: false, processExitCode: 0, verification: { passed: false } },
      { id: 'harness', passed: false },
      { id: 'infra', metrics: {}, passed: false, timedOut: true },
      { id: 'pass', metrics: {}, passed: true },
    ]
    expect(inputs.map(classifyFailure)).toEqual([
      { category: 'model_failure', reason: 'external_verifier_rejected' },
      { category: 'harness_failure', reason: 'observability_gap' },
      { category: 'infrastructure_failure', reason: 'timeout' },
      { category: null, reason: null },
    ])
  })

  it('报告只含文件路径与摘要，不含 secret、用户正文或文件正文', async () => {
    const { productRoot, repoRoot } = await fixture()
    const secret = 'credential-value-never-serialize'
    const userBody = 'private-user-body-never-serialize'
    await writeFile(join(productRoot, 'cases.ts'), `${secret}\n${userBody}\n`)
    const report = await buildEvaluationReport({
      cases: [{ id: 'case', passed: false }],
      commitment: { config: {}, files: commitmentFiles, productRoot }, draft: {}, repoRoot,
      requestedModel: 'm', requestedProvider: 'p',
    })
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain(userBody)
    expect(serialized).not.toContain('cases.ts:initial')
  })

  it('显式兼容读取历史 v1 与当前 v2', () => {
    expect(parseEvaluationReport({ cases: [], reportVersion: 1 }).reportVersion).toBe(1)
    expect(parseEvaluationReport({ cases: [], reportVersion: 2 }).reportVersion).toBe(2)
    expect(() => parseEvaluationReport({ cases: [], reportVersion: 3 })).toThrow('版本')
  })
})
