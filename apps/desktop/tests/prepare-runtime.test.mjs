import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'
import { normalizeRuntimeLinks } from '../scripts/prepare-runtime.mjs'

test('rewrites internal absolute runtime links and rejects links that escape the release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mythos-runtime-links-'))
  const modules = join(root, 'node_modules')
  const packageRoot = join(root, 'runtime', 'package')
  const internalLink = join(modules, 'package')
  try {
    await mkdir(modules, { recursive: true })
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'index.js'), 'export {}\n')
    await symlink(packageRoot, internalLink)
    await normalizeRuntimeLinks(root)
    assert.equal(await readlink(internalLink), relative(modules, packageRoot))

    await symlink('/tmp', join(modules, 'escape'))
    await assert.rejects(normalizeRuntimeLinks(root), /escapes release root/u)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})
