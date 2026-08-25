import { lstat, mkdir, readlink, readdir, realpath, symlink, unlink } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

async function exists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function bridge(source, destination) {
  if (await exists(destination)) return
  await symlink(relative(join(destination, '..'), source), destination)
}

function inside(root, path) {
  const offset = relative(root, path)
  return offset === '' || (!offset.startsWith('..') && !offset.startsWith('/'))
}

/**
 * Rewrites release-root absolute links so the copied app remains self-contained.
 * @param {string} root Extracted Mythos release root.
 * @returns {Promise<void>}
 */
export async function normalizeRuntimeLinks(root) {
  const normalizedRoot = resolve(root)
  const canonicalRoot = await realpath(normalizedRoot)
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
        continue
      }
      if (!entry.isSymbolicLink()) continue
      const target = await readlink(path)
      const resolvedTarget = resolve(dirname(path), target)
      const canonicalTarget = await realpath(resolvedTarget)
      if (!inside(canonicalRoot, canonicalTarget)) {
        throw new Error(`Runtime symlink escapes release root: ${path}`)
      }
      if (!target.startsWith('/')) continue
      const portableTarget = join(normalizedRoot, relative(canonicalRoot, canonicalTarget))
      await unlink(path)
      await symlink(relative(dirname(path), portableTarget), path)
    }
  }
  await visit(normalizedRoot)
}

/**
 * Completes the extracted runtime links required by the Desktop package.
 * @param {string} releaseRoot Extracted Mythos release root.
 * @returns {Promise<void>}
 */
export async function prepareRuntime(releaseRoot) {
  const root = resolve(releaseRoot)
  const modules = join(root, 'runtime', 'dsh', 'node_modules')
  const hoisted = join(modules, '.pnpm', 'node_modules')
  for (const entry of await readdir(hoisted, { withFileTypes: true })) {
    if (!entry.name.startsWith('@')) {
      await bridge(join(hoisted, entry.name), join(modules, entry.name))
      continue
    }
    const scopeSource = join(hoisted, entry.name)
    const scopeDestination = join(modules, entry.name)
    await mkdir(scopeDestination, { recursive: true })
    for (const packageEntry of await readdir(scopeSource, { withFileTypes: true })) {
      await bridge(join(scopeSource, packageEntry.name), join(scopeDestination, packageEntry.name))
    }
  }
  await normalizeRuntimeLinks(root)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const releaseRoot = process.env.MYTHOS_RUNTIME_ROOT
  if (releaseRoot === undefined || releaseRoot === '') throw new Error('MYTHOS_RUNTIME_ROOT is required')
  await prepareRuntime(releaseRoot)
}
