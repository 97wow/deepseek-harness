import { lstat, mkdir, readdir, symlink } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const releaseRoot = process.env.MYTHOS_RUNTIME_ROOT
if (releaseRoot === undefined || releaseRoot === '') throw new Error('MYTHOS_RUNTIME_ROOT is required')

const modules = join(resolve(releaseRoot), 'runtime', 'dsh', 'node_modules')
const hoisted = join(modules, '.pnpm', 'node_modules')

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
