import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { validateRuntimeArchiveEntries, rewriteRuntimeIntegrityManifest } from '../src/runtime-store.mjs'
import { pruneRuntimeForMacArm64 } from './prune-runtime.mjs'
import { findRuntimeMachOBinaries } from './sign-macos.mjs'

const execute = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(here, '..')

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function verifySourceArchive(archive) {
  const digest = /^([a-f0-9]{64})(?:\s{2}.+)?$/u.exec((await readFile(`${archive}.sha256`, 'utf8')).trim())?.[1]
  if (digest === undefined || await hashFile(archive) !== digest) throw new Error('MYTHOS Runtime 源归档 SHA-256 不匹配')
  const listed = await execute('/usr/bin/tar', ['-tzf', archive], { maxBuffer: 64 * 1024 * 1024 })
  validateRuntimeArchiveEntries(listed.stdout.trim().split('\n').filter(Boolean))
}

async function prepareSignedRuntime(archive, identity, workRoot) {
  await verifySourceArchive(archive)
  const extracted = join(workRoot, 'extracted')
  const output = join(workRoot, 'mythos-runtime.tar.gz')
  await mkdir(extracted)
  await execute('/usr/bin/tar', ['-xzf', archive, '-C', extracted])
  const release = join(extracted, 'mythos-agent')
  const removedPrebuilds = await pruneRuntimeForMacArm64(release)
  const binaries = await findRuntimeMachOBinaries(release)
  const certificate = identity.startsWith('Developer ID Application:') ? identity : `Developer ID Application: ${identity}`
  for (const binary of binaries) {
    await execute('/usr/bin/codesign', ['--sign', certificate, '--force', '--timestamp', '--options', 'runtime', binary])
    await execute('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', binary])
  }
  await rewriteRuntimeIntegrityManifest(release)
  await execute('/usr/bin/tar', ['-czf', output, '-C', extracted, 'mythos-agent'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  const digest = await hashFile(output)
  await writeFile(`${output}.sha256`, `${digest}  mythos-runtime.tar.gz\n`, { mode: 0o644 })
  process.stdout.write(`[MYTHOS Desktop] pruned ${String(removedPrebuilds.length)} incompatible node-pty prebuilds\n`)
  process.stdout.write(`[MYTHOS Desktop] signed ${String(binaries.length)} Runtime native binaries\n`)
  return output
}

const sourceArchive = process.env.MYTHOS_RUNTIME_ARCHIVE
const identity = process.env.MYTHOS_MAC_SIGN_IDENTITY
if (sourceArchive === undefined || sourceArchive === '') throw new Error('MYTHOS_RUNTIME_ARCHIVE is required')
if (identity === undefined || identity === '') throw new Error('MYTHOS_MAC_SIGN_IDENTITY is required')
const workRoot = await mkdtemp(join(tmpdir(), 'mythos-desktop-runtime-'))
try {
  const signedArchive = await prepareSignedRuntime(resolve(sourceArchive), identity, workRoot)
  const builder = join(desktopRoot, 'node_modules', '.bin', 'electron-builder')
  const result = await execute(builder, ['--mac', 'dir', 'dmg', 'zip', '--arm64', '--config', 'electron-builder.config.mjs'], {
    cwd: desktopRoot,
    env: { ...process.env, MYTHOS_SIGNED_RUNTIME_ARCHIVE: signedArchive },
    maxBuffer: 64 * 1024 * 1024,
  })
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
} finally {
  await rm(workRoot, { force: true, recursive: true })
}
