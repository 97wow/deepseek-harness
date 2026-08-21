import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { archiveFlywheel, type ArchiveOptions } from './archive.js'
import { evaluateReleaseGate, readArchivedLabels } from './gate-policy.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

async function fixture(): Promise<ArchiveOptions> {
  const productRoot = await mkdtemp(join(tmpdir(), 'mythos-flywheel-'))
  temporaryRoots.push(productRoot)
  const options = {
    outputRoot: join(productRoot, 'flywheel', 'data'),
    productRoot,
    runsRoot: join(productRoot, 'runs'),
    sessionsRoot: join(productRoot, 'home', 'sessions'),
  }
  await mkdir(options.runsRoot, { recursive: true })
  await mkdir(options.sessionsRoot, { recursive: true })
  return options
}

async function writeReport(
  options: ArchiveOptions,
  cases: Record<string, unknown>[],
  runId = 'run-1',
  filename = 'run.json',
): Promise<void> {
  await writeFile(join(options.runsRoot, filename), JSON.stringify({
    baseline: { dshVersion: 'test' },
    cases,
    completedAt: '2026-01-01T00:00:01Z',
    reportVersion: 1,
    runId,
    startedAt: '2026-01-01T00:00:00Z',
  }))
}

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

describe('archiveFlywheel', () => {
  it('空归档经过读取与正式 gate 后仍 fail closed', async () => {
    const options = await fixture()
    await expect(archiveFlywheel(options)).resolves.toEqual({ rawSessions: 0, samples: 0 })
    const labels = await readArchivedLabels(options.outputRoot)
    expect(labels).toEqual([])
    expect(evaluateReleaseGate(labels, { caseIds: ['case'], cohortPrefix: 'd:m:c:v', maxDurationMsP95: 100, minSamples: 1 }))
      .toMatchObject({ passed: false, failures: [expect.stringContaining('insufficient_evidence')] })
  })

  it('幂等归档完整原件并保留无原件的失败标签', async () => {
    const options = await fixture()
    const source = join(options.sessionsRoot, 'case', 'session.jsonl.zstd')
    await mkdir(join(options.sessionsRoot, 'case'))
    await writeFile(source, Buffer.from([0, 1, 2, 255]))
    await writeReport(options, [
      { id: 'success', passed: true, rawSession: relative(options.productRoot, source) },
      { id: 'timeout', passed: false, timedOut: true },
    ])

    await expect(archiveFlywheel(options)).resolves.toEqual({ rawSessions: 1, samples: 2 })
    await expect(archiveFlywheel(options)).resolves.toEqual({ rawSessions: 1, samples: 2 })
    const copied = join(options.outputRoot, 'runs', 'run-1', 'success', 'session.jsonl.zstd')
    expect(await readFile(copied)).toEqual(await readFile(source))
    const index = (await readFile(join(options.outputRoot, 'index.jsonl'), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(index).toMatchObject([
      { caseId: 'success', label: { path: expect.any(String), sha256: expect.any(String) }, raw: { path: expect.any(String), sha256: expect.any(String) }, report: { path: expect.any(String), sha256: expect.any(String) } },
      { caseId: 'timeout', raw: null },
    ])
    const label = JSON.parse(await readFile(join(options.outputRoot, 'runs', 'run-1', 'success', 'label.json'), 'utf8')) as Record<string, unknown>
    expect(label).toMatchObject({ evidenceStatus: 'legacy_unverified', case: { accepted: false, failure: { category: 'harness_failure' } } })
  })

  it('拒绝被篡改的不可变原始副本', async () => {
    const options = await fixture()
    const source = join(options.sessionsRoot, 'session.jsonl.zstd')
    await writeFile(source, 'original')
    await writeReport(options, [{ id: 'case', passed: true, rawSession: relative(options.productRoot, source) }])
    await archiveFlywheel(options)
    await writeFile(join(options.outputRoot, 'runs', 'run-1', 'case', 'session.jsonl.zstd'), 'tampered')
    await expect(archiveFlywheel(options)).rejects.toThrow('副本与来源不一致')
  })

  it('按字节归档父会话关联的子 Agent 会话', async () => {
    const options = await fixture()
    const parent = join(options.sessionsRoot, 'parent', 'session.jsonl.zstd')
    const child = join(options.sessionsRoot, 'child', 'session.jsonl.zstd')
    await mkdir(join(options.sessionsRoot, 'parent'))
    await mkdir(join(options.sessionsRoot, 'child'))
    await writeFile(parent, 'parent')
    await writeFile(child, 'child')
    await writeReport(options, [{ id: 'case', passed: true, rawSession: relative(options.productRoot, parent), relatedRawSessions: [relative(options.productRoot, child)] }])
    await expect(archiveFlywheel(options)).resolves.toEqual({ rawSessions: 2, samples: 1 })
    expect(await readFile(join(options.outputRoot, 'runs', 'run-1', 'case', 'related', 'session-1.jsonl.zstd'), 'utf8')).toBe('child')
  })

  it('拒绝通过符号链接越出会话根目录', async () => {
    const options = await fixture()
    const outside = join(options.productRoot, 'outside.zstd')
    const link = join(options.sessionsRoot, 'escape.zstd')
    await writeFile(outside, 'outside')
    await symlink(outside, link)
    await writeReport(options, [{ id: 'case', passed: false, rawSession: relative(options.productRoot, link) }])
    await expect(archiveFlywheel(options)).rejects.toThrow('符号链接越出会话根目录')
  })

  it('拒绝缺少 acceptance schema 的 v2 报告', async () => {
    const options = await fixture()
    await writeFile(join(options.runsRoot, 'run.json'), JSON.stringify({ cases: [], reportVersion: 2, runId: 'run-1' }))
    await expect(archiveFlywheel(options)).rejects.toThrow('schema')
  })

  it.each([
    ['runId', '../run', 'case'],
    ['caseId', 'run-1', 'case/escape'],
    ['empty caseId', 'run-1', ''],
    ['case-folding caseId', 'run-1', 'Case'],
  ])('拒绝非规范 %s', async (_name, runId, caseId) => {
    const options = await fixture()
    await writeReport(options, [{ id: caseId, passed: true }], runId)
    await expect(archiveFlywheel(options)).rejects.toThrow('规范标识符')
  })

  it.each(['accepted', 'evidence', 'source-summary'] as const)('篡改 %s 的三个完整 v2 报告无法通过 archive→analysis→gate', async attack => {
    const options = await fixture()
    const source = join(options.sessionsRoot, 'case', 'session.jsonl.zstd')
    await mkdir(join(options.sessionsRoot, 'case'))
    await writeFile(source, 'raw-session-evidence')
    const testCase: Record<string, unknown> = {
      accepted: false,
      billing: { amount: null, currency: null, source: null, tokens: { cache: 0, input: 1, output: 1 }, tokensVerified: true, verified: false },
      capabilityEligible: false,
      completionEvidence: {
        agentIdle: { status: 'unknown_unverified', value: null }, externalVerifier: { status: 'observed', value: true },
        sessionFlush: { status: 'unknown_unverified', value: null }, turnReason: { status: 'observed', value: 'completed' },
      },
      failure: { category: 'harness_failure', reason: 'observability_gap' },
      id: 'case', observationSource: 'dsh_session_log', passed: true, rawSession: relative(options.productRoot, source),
    }
    const report: Record<string, unknown> = {
      acceptance: { failures: ['server_identity_unverified', 'billing_unverified', 'completion_evidence_incomplete', 'tracked_source_dirty'], passed: false },
      baseline: { configurationSha256: 'c', dshVersion: 'd', mythosVersion: 'm', variant: 'v' },
      cases: [testCase], implementation: { entry: 'standard', files: [], runtime: { endpoint: { sha256: 'endpoint' }, parametersSha256: 'parameters' }, sha256: 'hash' },
      modelIdentity: { server: { status: 'unknown_unverified' } }, passed: false, reportVersion: 2, runId: `run-${attack}`,
      source: { gitHead: 'head', worktree: { trackedDirty: true, untrackedPresent: false } },
    }
    if (attack === 'accepted') testCase.accepted = true
    if (attack === 'evidence') {
      testCase.billing = { amount: 0, currency: 'USD', source: 'provider_invoice', tokens: { cache: 0, input: 1, output: 1 }, tokensVerified: true, verified: true }
      testCase.completionEvidence = { agentIdle: { status: 'observed', value: true }, sessionFlush: { status: 'observed', value: true }, turnReason: { status: 'observed', value: 'completed' } }
      report.modelIdentity = { server: { status: 'verified', model: 'forged' } }
    }
    if (attack === 'source-summary') {
      report.source = { gitHead: 'head', worktree: { trackedDirty: false, untrackedPresent: false } }
      report.acceptance = { failures: ['server_identity_unverified', 'billing_unverified', 'completion_evidence_incomplete'], passed: false }
      report.summary = { passRate: 1, samples: 999 }
    }
    await writeFile(join(options.runsRoot, `${attack}.json`), JSON.stringify(report))
    let passed = false
    try {
      await archiveFlywheel(options)
      const labels = await readArchivedLabels(options.outputRoot)
      passed = evaluateReleaseGate(labels, { caseIds: ['case'], cohortPrefix: 'd:m:c:v', maxDurationMsP95: 100, minSamples: 1 }).passed
    } catch {
      passed = false
    }
    expect(passed).toBe(false)
  })

  it.each(['label', 'raw', 'report', 'index'] as const)('读取时拒绝独立篡改的 %s 内容', async target => {
    const options = await fixture()
    const source = join(options.sessionsRoot, 'case', 'session.jsonl.zstd')
    await mkdir(join(options.sessionsRoot, 'case'))
    await writeFile(source, 'raw')
    await writeReport(options, [{ id: 'case', passed: true, rawSession: relative(options.productRoot, source) }])
    await archiveFlywheel(options)
    const indexPath = join(options.outputRoot, 'index.jsonl')
    const rows = (await readFile(indexPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const row = rows[0]!
    if (target === 'label') {
      const reference = row.label as { path: string }
      await writeFile(join(options.outputRoot, reference.path), 'modified-label')
    } else if (target === 'raw') {
      const reference = row.raw as { path: string }
      await writeFile(join(options.outputRoot, reference.path), 'modified-raw')
    } else if (target === 'report') {
      const reference = row.report as { path: string }
      await writeFile(join(options.outputRoot, reference.path), 'modified-report')
    } else {
      row.caseId = 'other-case'
      await writeFile(indexPath, `${JSON.stringify(row)}\n`)
    }
    await expect(readArchivedLabels(options.outputRoot)).rejects.toThrow()
  })

  it.each(['label', 'raw'] as const)('读取时拒绝两个 case 的 %s 路径与 digest 交叉交换', async target => {
    const options = await fixture()
    const firstRaw = join(options.sessionsRoot, 'a', 'session.jsonl.zstd')
    const secondRaw = join(options.sessionsRoot, 'b', 'session.jsonl.zstd')
    await mkdir(join(options.sessionsRoot, 'a'))
    await mkdir(join(options.sessionsRoot, 'b'))
    await writeFile(firstRaw, 'a')
    await writeFile(secondRaw, 'b')
    await writeReport(options, [
      { id: 'case-a', passed: true, rawSession: relative(options.productRoot, firstRaw) },
      { id: 'case-b', passed: true, rawSession: relative(options.productRoot, secondRaw) },
    ])
    await archiveFlywheel(options)
    const indexPath = join(options.outputRoot, 'index.jsonl')
    const rows = (await readFile(indexPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const first = rows[0]!
    const second = rows[1]!
    const reference = first[target]
    first[target] = second[target]
    second[target] = reference
    await writeFile(indexPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`)
    await expect(readArchivedLabels(options.outputRoot)).rejects.toThrow(target === 'label' ? '规范证据路径' : '绑定不一致')
  })

  it('即使 index 与 label 同步改指向另一 case 的 raw 也拒绝', async () => {
    const options = await fixture()
    const firstRaw = join(options.sessionsRoot, 'a.zstd')
    const secondRaw = join(options.sessionsRoot, 'b.zstd')
    await writeFile(firstRaw, 'first')
    await writeFile(secondRaw, 'second')
    await writeReport(options, [
      { id: 'case-a', passed: true, rawSession: relative(options.productRoot, firstRaw) },
      { id: 'case-b', passed: true, rawSession: relative(options.productRoot, secondRaw) },
    ])
    await archiveFlywheel(options)
    const indexPath = join(options.outputRoot, 'index.jsonl')
    const rows = (await readFile(indexPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const first = rows[0]!
    first.raw = rows[1]!.raw
    const labelReference = first.label as { path: string; sha256: string }
    const labelPath = join(options.outputRoot, labelReference.path)
    const label = JSON.parse(await readFile(labelPath, 'utf8')) as Record<string, unknown>
    label.raw = first.raw
    const labelContent = `${JSON.stringify(label, null, 2)}\n`
    await writeFile(labelPath, labelContent)
    labelReference.sha256 = digest(labelContent)
    await writeFile(indexPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`)
    await expect(readArchivedLabels(options.outputRoot)).rejects.toThrow('规范证据路径')
  })

  it('复制 label 到归档根并同步 index 仍拒绝', async () => {
    const options = await fixture()
    await writeReport(options, [{ id: 'case', passed: true }])
    await archiveFlywheel(options)
    const indexPath = join(options.outputRoot, 'index.jsonl')
    const row = JSON.parse((await readFile(indexPath, 'utf8')).trim()) as Record<string, unknown>
    const reference = row.label as { path: string; sha256: string }
    const content = await readFile(join(options.outputRoot, reference.path), 'utf8')
    await writeFile(join(options.outputRoot, 'copied-label.json'), content)
    reference.path = 'copied-label.json'
    reference.sha256 = digest(content)
    await writeFile(indexPath, `${JSON.stringify(row)}\n`)
    await expect(readArchivedLabels(options.outputRoot)).rejects.toThrow('规范证据路径')
  })

  it('拒绝跨 run 交换 case 证据路径', async () => {
    const options = await fixture()
    const firstRaw = join(options.sessionsRoot, 'a.zstd')
    const secondRaw = join(options.sessionsRoot, 'b.zstd')
    await writeFile(firstRaw, 'first-run')
    await writeFile(secondRaw, 'second-run')
    await writeReport(options, [{ id: 'case-a', passed: true, rawSession: relative(options.productRoot, firstRaw) }], 'run-a', 'a.json')
    await writeReport(options, [{ id: 'case-b', passed: true, rawSession: relative(options.productRoot, secondRaw) }], 'run-b', 'b.json')
    await archiveFlywheel(options)
    const indexPath = join(options.outputRoot, 'index.jsonl')
    const rows = (await readFile(indexPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    ;[rows[0]!.label, rows[1]!.label] = [rows[1]!.label, rows[0]!.label]
    ;[rows[0]!.raw, rows[1]!.raw] = [rows[1]!.raw, rows[0]!.raw]
    await writeFile(indexPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`)
    await expect(readArchivedLabels(options.outputRoot)).rejects.toThrow('规范证据路径')
  })

  it('拒绝两个 case 使用同内容 digest 的 raw 副本', async () => {
    const options = await fixture()
    const firstRaw = join(options.sessionsRoot, 'a.zstd')
    const secondRaw = join(options.sessionsRoot, 'b.zstd')
    await writeFile(firstRaw, 'same-evidence')
    await writeFile(secondRaw, 'same-evidence')
    await writeReport(options, [
      { id: 'case-a', passed: true, rawSession: relative(options.productRoot, firstRaw) },
      { id: 'case-b', passed: true, rawSession: relative(options.productRoot, secondRaw) },
    ])
    await expect(archiveFlywheel(options)).rejects.toThrow('raw evidence 必须按 case 唯一')
  })

  it('删除任一合法 index 行会因 report case 集不完整而拒绝', async () => {
    const options = await fixture()
    await writeReport(options, [{ id: 'case-a', passed: true }, { id: 'case-b', passed: true }])
    await archiveFlywheel(options)
    const indexPath = join(options.outputRoot, 'index.jsonl')
    const rows = (await readFile(indexPath, 'utf8')).trim().split('\n')
    await writeFile(indexPath, `${rows[0]}\n`)
    await expect(readArchivedLabels(options.outputRoot)).rejects.toThrow('未完整覆盖 report case 集')
  })

  it('追加未知 index 行会被 report case 集交叉验证拒绝', async () => {
    const options = await fixture()
    await writeReport(options, [{ id: 'case', passed: true }])
    await archiveFlywheel(options)
    const indexPath = join(options.outputRoot, 'index.jsonl')
    const row = JSON.parse((await readFile(indexPath, 'utf8')).trim()) as Record<string, unknown>
    const unknown = { ...row, caseId: 'unknown-case' }
    await writeFile(indexPath, `${JSON.stringify(row)}\n${JSON.stringify(unknown)}\n`)
    await expect(readArchivedLabels(options.outputRoot)).rejects.toThrow()
  })

  it.each(['runId', 'caseId', 'cohort'] as const)('交换 index 的 %s 身份字段会被拒绝', async field => {
    const options = await fixture()
    await writeReport(options, [{ id: 'case-a', passed: true }, { id: 'case-b', passed: true }])
    await archiveFlywheel(options)
    const indexPath = join(options.outputRoot, 'index.jsonl')
    const rows = (await readFile(indexPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    if (field === 'runId') rows[0]!.runId = 'other-run'
    else if (field === 'caseId') rows[0]!.caseId = 'case-b'
    else rows[0]!.cohort = rows[1]!.cohort
    await writeFile(indexPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`)
    await expect(readArchivedLabels(options.outputRoot)).rejects.toThrow()
  })

  it.each(['/absolute/label.json', '../escape.json'])('读取时拒绝不安全归档路径 %s', async unsafe => {
    const options = await fixture()
    await writeReport(options, [{ id: 'case', passed: true }])
    await archiveFlywheel(options)
    const indexPath = join(options.outputRoot, 'index.jsonl')
    const row = JSON.parse((await readFile(indexPath, 'utf8')).trim()) as Record<string, unknown>
    row.label = { ...(row.label as object), path: unsafe }
    await writeFile(indexPath, `${JSON.stringify(row)}\n`)
    await expect(readArchivedLabels(options.outputRoot)).rejects.toThrow('路径')
  })

  it('读取时拒绝 dataRoot 内的符号链接重解析', async () => {
    const options = await fixture()
    await writeReport(options, [{ id: 'case', passed: true }])
    await archiveFlywheel(options)
    const row = JSON.parse((await readFile(join(options.outputRoot, 'index.jsonl'), 'utf8')).trim()) as Record<string, unknown>
    const labelPath = join(options.outputRoot, (row.label as { path: string }).path)
    const realLabel = `${labelPath}.real`
    await rename(labelPath, realLabel)
    await symlink(realLabel, labelPath)
    await expect(readArchivedLabels(options.outputRoot)).rejects.toThrow('符号链接')
  })
})
