import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { archiveFlywheel, type ArchiveOptions } from './archive.js'

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
): Promise<void> {
  await writeFile(join(options.runsRoot, 'run.json'), JSON.stringify({
    baseline: { dshVersion: 'test' },
    cases,
    completedAt: '2026-01-01T00:00:01Z',
    reportVersion: 1,
    runId: 'run-1',
    startedAt: '2026-01-01T00:00:00Z',
  }))
}

describe('archiveFlywheel', () => {
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
      { caseId: 'success', hasRaw: true, passed: false },
      { caseId: 'timeout', hasRaw: false, passed: false },
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
})
