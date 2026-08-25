import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import {
  activatePackagedRuntime,
  rewriteRuntimeIntegrityManifest,
  validateRuntimeArchiveEntries,
  verifyRuntimeTree,
} from '../src/runtime-store.mjs'

const execute = promisify(execFile)

test('rejects archive members outside the single mythos-agent root', () => {
  assert.doesNotThrow(() => validateRuntimeArchiveEntries(['mythos-agent/', 'mythos-agent/bin/mythos.js']))
  assert.throws(() => validateRuntimeArchiveEntries(['../escape']), /路径不安全/u)
  assert.throws(() => validateRuntimeArchiveEntries(['mythos-agent/../../escape']), /路径不安全/u)
  assert.throws(() => validateRuntimeArchiveEntries(['another-root/file']), /路径不安全/u)
})

test('verifies, coalesces, and atomically reuses one archived runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mythos-runtime-store-'))
  try {
    const source = join(root, 'source')
    const release = join(source, 'mythos-agent')
    await mkdir(join(release, 'bin'), { recursive: true })
    await writeFile(join(release, 'bin', 'mythos.js'), 'export {}\n')
    const archive = join(root, 'runtime.tar.gz')
    await execute('tar', ['-czf', archive, '-C', source, 'mythos-agent'])
    const bytes = await readFile(archive)
    const digest = createHash('sha256').update(bytes).digest('hex')
    const digestFile = `${archive}.sha256`
    await writeFile(digestFile, `${digest}  runtime.tar.gz\n`)
    let verifies = 0
    const options = {
      archive,
      digestFile,
      storeRoot: join(root, 'store'),
      verifyRelease: async path => {
        verifies += 1
        assert.equal(await readFile(join(path, 'bin', 'mythos.js'), 'utf8'), 'export {}\n')
      },
    }
    const [first, second] = await Promise.all([
      activatePackagedRuntime(options),
      activatePackagedRuntime(options),
    ])
    assert.equal(first, second)
    assert.equal(verifies, 1)
    assert.equal(await activatePackagedRuntime(options), first)
    assert.equal(verifies, 2)
    await writeFile(join(first, 'bin', 'mythos.js'), 'tampered\n')
    assert.equal(await activatePackagedRuntime(options), first)
    assert.equal(verifies, 4)
    assert.equal(await readFile(join(first, 'bin', 'mythos.js'), 'utf8'), 'export {}\n')
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('rejects an archive whose signed digest does not match', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mythos-runtime-digest-'))
  try {
    const archive = join(root, 'runtime.tar.gz')
    await writeFile(archive, 'altered')
    await writeFile(`${archive}.sha256`, `${'0'.repeat(64)}  runtime.tar.gz\n`)
    await assert.rejects(() => activatePackagedRuntime({
      archive,
      digestFile: `${archive}.sha256`,
      storeRoot: join(root, 'store'),
    }), /SHA-256/u)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('re-seals the integrity inventory after native signing changes release bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mythos-runtime-reseal-'))
  try {
    await mkdir(join(root, 'bin'), { recursive: true })
    await mkdir(join(root, 'home', 'profiles', 'mythos-web'), { recursive: true })
    await mkdir(join(root, 'runtime', 'dsh', 'lib'), { recursive: true })
    await writeFile(join(root, 'bin', 'mythos.js'), 'signed bytes\n')
    await writeFile(join(root, 'home', 'profiles', 'mythos-web', 'cordis.patch.yml'), 'name: test\n')
    await writeFile(join(root, 'runtime', 'dsh', 'lib', 'bin.js'), 'export {}\n')
    await writeFile(join(root, 'release-integrity.json'), '{"formatVersion":1,"entries":[]}\n')
    await rewriteRuntimeIntegrityManifest(root)
    await assert.doesNotReject(() => verifyRuntimeTree(root))
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})
