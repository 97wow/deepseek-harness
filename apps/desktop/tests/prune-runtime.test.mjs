import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pruneRuntimeForMacArm64 } from '../scripts/prune-runtime.mjs'

test('keeps the macOS arm64 node-pty prebuild and removes incompatible variants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mythos-runtime-prune-'))
  const prebuilds = join(root, 'runtime', 'node_modules', '.pnpm', 'node-pty@1', 'node_modules', 'node-pty', 'prebuilds')
  try {
    for (const platform of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'win32-arm64']) {
      await mkdir(join(prebuilds, platform), { recursive: true })
      await writeFile(join(prebuilds, platform, 'native.node'), platform)
    }

    assert.deepEqual(await pruneRuntimeForMacArm64(root), ['darwin-x64', 'linux-arm64', 'win32-arm64'])
    assert.deepEqual(await readdirNames(prebuilds), ['darwin-arm64'])
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('leaves an unrelated prebuild tree untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mythos-runtime-prune-'))
  const prebuilds = join(root, 'node_modules', 'another-package', 'prebuilds', 'linux-x64')
  try {
    await mkdir(prebuilds, { recursive: true })
    await writeFile(join(prebuilds, 'native.node'), 'fixture')
    assert.deepEqual(await pruneRuntimeForMacArm64(root), [])
    assert.deepEqual(await readdirNames(join(root, 'node_modules', 'another-package', 'prebuilds')), ['linux-x64'])
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

async function readdirNames(path) {
  return (await readdir(path)).sort()
}
