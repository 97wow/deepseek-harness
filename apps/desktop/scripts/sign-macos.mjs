import { execFile } from 'node:child_process'
import { open, readdir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const MACH_O_MAGICS = new Set([
  0xfeedface,
  0xfeedfacf,
  0xcefaedfe,
  0xcffaedfe,
  0xcafebabe,
  0xbebafeca,
  0xcafebabf,
  0xbfbafeca,
])

async function isMachO(path) {
  const handle = await open(path, 'r')
  try {
    const magic = Buffer.allocUnsafe(4)
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0)
    return bytesRead === magic.length && MACH_O_MAGICS.has(magic.readUInt32BE(0))
  } finally {
    await handle.close()
  }
}

async function collectCandidates(root, candidates) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      await collectCandidates(path, candidates)
      continue
    }
    if (!entry.isFile()) continue
    const mode = (await stat(path)).mode
    if ((mode & 0o111) !== 0 || ['.dylib', '.node', '.so'].includes(extname(path))) candidates.push(path)
  }
}

async function collectCodeItems(root, items) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      await collectCodeItems(path, items)
      if (['.app', '.framework', '.xpc'].includes(extname(path))) items.push(path)
      continue
    }
    if (!entry.isFile()) continue
    const mode = (await stat(path)).mode
    if (((mode & 0o111) !== 0 || ['.dylib', '.node', '.so'].includes(extname(path))) && await isMachO(path)) {
      items.push(path)
    }
  }
}

/**
 * Finds native code in the bundled runtime without opening every JavaScript and data file.
 * @param {string} root Extracted Mythos runtime root.
 * @returns {Promise<string[]>} Deepest-first Mach-O paths for code signing.
 */
export async function findRuntimeMachOBinaries(root) {
  const candidates = []
  await collectCandidates(root, candidates)
  const binaries = []
  for (const path of candidates) {
    if (await isMachO(path)) binaries.push(path)
  }
  return binaries.sort((left, right) => right.split('/').length - left.split('/').length)
}

async function codesign(path, options) {
  const perFile = await options.optionsForFile?.(path)
  const args = ['--sign', options.identity, '--force', '--timestamp']
  if (options.keychain) args.push('--keychain', options.keychain)
  if (perFile?.hardenedRuntime) args.push('--options', 'runtime')
  if (perFile?.entitlements) args.push('--entitlements', perFile.entitlements)
  args.push(path)
  await execute('/usr/bin/codesign', args)
}

/**
 * Signs native files and nested bundles sequentially, then seals the application.
 * @param {object} options Electron Builder signing options.
 * @returns {Promise<void>}
 */
export async function signMacApplication(options) {
  const codeItems = []
  await collectCodeItems(join(options.app, 'Contents'), codeItems)
  const orderedItems = [...new Set(codeItems)]
    .sort((left, right) => right.split('/').length - left.split('/').length)
  for (const item of orderedItems) await codesign(item, options)
  await codesign(options.app, options)
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', options.app])
}
