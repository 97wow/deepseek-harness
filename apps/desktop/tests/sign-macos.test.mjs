import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { findRuntimeMachOBinaries } from '../scripts/sign-macos.mjs'

test('finds Mach-O runtime code without treating executable scripts as native binaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mythos-signing-test-'))
  const nested = join(root, 'node_modules', 'native')
  const addon = join(nested, 'addon.node')
  const script = join(root, 'mythos.js')
  try {
    await mkdir(nested, { recursive: true })
    await writeFile(addon, Buffer.from([0xfe, 0xed, 0xfa, 0xcf, 0x00]))
    await writeFile(script, '#!/usr/bin/env node\n')
    await chmod(script, 0o755)
    assert.deepEqual(await findRuntimeMachOBinaries(root), [addon])
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})
