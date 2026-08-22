import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyArchiveEntries, verifyExtractedBundle, writeIntegrityManifest } from './bundle.js'

const temporaryRoots: string[] = []

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mythos-bundle-test-'))
  temporaryRoots.push(root)
  for (const [path, contents] of [
    ['bin/mythos.js', 'launcher'],
    ['home/profiles/mythos/cordis.patch.yml', 'headless'],
    ['home/profiles/mythos-web/cordis.patch.yml', 'web'],
    ['runtime/dsh/lib/bin.js', 'dsh'],
    ['runtime/dsh/package.json', '{"version":"0.1.0-rc.8"}'],
    ['package.json', `{"version":"0.1.1","mythos":{"dshVersion":"0.1.0-rc.8","dshCommit":"${'b'.repeat(40)}"}}`],
  ]) {
    const output = join(root, path)
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, contents)
  }
  await mkdir(join(root, 'runtime/dsh/node_modules/.pnpm/node_modules'), { recursive: true })
  await symlink('runtime/dsh/node_modules/.pnpm/node_modules', join(root, 'node_modules'))
  return root
}

async function manifest(root: string): Promise<void> {
  await writeIntegrityManifest(root, {
    dependencyLockSha256: 'a'.repeat(64),
    dshCommit: 'b'.repeat(40),
    dshVersion: '0.1.0-rc.8',
    productVersion: '0.1.1',
    sourceCommit: 'c'.repeat(40),
  })
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe('Mythos 发布包完整性', () => {
  it('接受完整仓外运行闭包', async () => {
    const root = await fixture()
    await manifest(root)
    await expect(verifyExtractedBundle(root)).resolves.toMatchObject({ dshVersion: '0.1.0-rc.8' })
  })

  it('拒绝被篡改、缺失或额外的文件', async () => {
    const tampered = await fixture()
    await manifest(tampered)
    await writeFile(join(tampered, 'runtime/dsh/lib/bin.js'), 'changed')
    await expect(verifyExtractedBundle(tampered)).rejects.toThrow('篡改')

    const missing = await fixture()
    await manifest(missing)
    await rm(join(missing, 'bin/mythos.js'))
    await expect(verifyExtractedBundle(missing)).rejects.toThrow('数量')

    const extra = await fixture()
    await manifest(extra)
    await writeFile(join(extra, 'unexpected'), 'extra')
    await expect(verifyExtractedBundle(extra)).rejects.toThrow('数量')
  })

  it('拒绝逃出解包目录的符号链接', async () => {
    const root = await fixture()
    await symlink('../../outside', join(root, 'runtime', 'escape'))
    await expect(manifest(root)).rejects.toThrow('符号链接越界')
  })

  it('拒绝越界与运行数据归档成员', () => {
    expect(() => verifyArchiveEntries(['mythos-agent/', 'mythos-agent/bin/mythos.js'])).not.toThrow()
    expect(() => verifyArchiveEntries(['mythos-agent/../outside'])).toThrow('不安全')
    expect(() => verifyArchiveEntries(['mythos-agent/sessions/private.json'])).toThrow('运行数据')
  })
})
