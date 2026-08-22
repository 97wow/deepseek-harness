import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const integrityManifestName = 'release-integrity.json'

interface FileEntry {
  mode: number
  path: string
  sha256: string
  size: number
  type: 'file'
}

interface SymlinkEntry {
  path: string
  target: string
  type: 'symlink'
}

export type IntegrityEntry = FileEntry | SymlinkEntry

export interface IntegrityManifest {
  dependencyLockSha256: string
  dshCommit: string
  dshVersion: string
  entries: IntegrityEntry[]
  formatVersion: 1
  productVersion: string
  sourceCommit: string
}

function inside(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

function portable(parts: readonly string[]): string {
  return parts.join('/')
}

async function hashFile(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function collectEntries(root: string): Promise<IntegrityEntry[]> {
  const entries: IntegrityEntry[] = []
  async function visit(directory: string, parts: string[]): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const child of children) {
      const childParts = [...parts, child.name]
      const path = join(directory, child.name)
      const relativePath = portable(childParts)
      if (parts.length === 0 && child.name === integrityManifestName) continue
      const metadata = await lstat(path)
      if (metadata.isDirectory()) {
        await visit(path, childParts)
      } else if (metadata.isFile()) {
        entries.push({
          mode: metadata.mode & 0o777,
          path: relativePath,
          sha256: await hashFile(path),
          size: metadata.size,
          type: 'file',
        })
      } else if (metadata.isSymbolicLink()) {
        const target = await readlink(path)
        if (!inside(root, resolve(dirname(path), target))) {
          throw new Error(`发布包符号链接越界：${relativePath}`)
        }
        entries.push({ path: relativePath, target, type: 'symlink' })
      } else {
        throw new Error(`发布包包含不支持的文件类型：${relativePath}`)
      }
    }
  }
  await visit(root, [])
  return entries
}

/**
 * Write the complete file and symlink inventory for one staged release.
 * @param root - Staged `mythos-agent` directory.
 * @param metadata - Immutable product and DSH source identity.
 * @returns the written manifest.
 */
export async function writeIntegrityManifest(
  root: string,
  metadata: Omit<IntegrityManifest, 'entries' | 'formatVersion'>,
): Promise<IntegrityManifest> {
  const manifest: IntegrityManifest = { ...metadata, entries: await collectEntries(root), formatVersion: 1 }
  await writeFile(join(root, integrityManifestName), `${JSON.stringify(manifest, undefined, 2)}\n`, { mode: 0o644 })
  return manifest
}

function parsedManifest(value: unknown): IntegrityManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('完整性清单必须是对象')
  const manifest = value as Record<string, unknown>
  if (manifest.formatVersion !== 1) throw new Error('完整性清单版本不受支持')
  for (const field of ['dependencyLockSha256', 'dshCommit', 'dshVersion', 'productVersion', 'sourceCommit']) {
    if (typeof manifest[field] !== 'string' || manifest[field] === '') throw new Error(`完整性清单缺少 ${field}`)
  }
  if (!/^[a-f0-9]{64}$/u.test(manifest.dependencyLockSha256 as string)) throw new Error('完整性清单 lockfile SHA-256 无效')
  if (!/^[a-f0-9]{40}$/u.test(manifest.dshCommit as string) || !/^[a-f0-9]{40}$/u.test(manifest.sourceCommit as string)) {
    throw new Error('完整性清单 source commit 无效')
  }
  if (!Array.isArray(manifest.entries)) throw new Error('完整性清单 entries 必须是数组')
  const entries = manifest.entries.map((entry, index): IntegrityEntry => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`完整性清单 entries[${String(index)}] 必须是对象`)
    }
    const row = entry as Record<string, unknown>
    if (typeof row.path !== 'string' || row.path === '' || isAbsolute(row.path) || row.path.split('/').includes('..')) {
      throw new Error(`完整性清单 entries[${String(index)}] 路径不安全`)
    }
    if (row.type === 'symlink' && typeof row.target === 'string') {
      return { path: row.path, target: row.target, type: 'symlink' }
    }
    if (row.type === 'file' && typeof row.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(row.sha256)
      && typeof row.mode === 'number' && Number.isInteger(row.mode)
      && typeof row.size === 'number' && Number.isInteger(row.size) && row.size >= 0) {
      return { mode: row.mode, path: row.path, sha256: row.sha256, size: row.size, type: 'file' }
    }
    throw new Error(`完整性清单 entries[${String(index)}] 内容无效`)
  })
  return {
    dependencyLockSha256: manifest.dependencyLockSha256 as string,
    dshCommit: manifest.dshCommit as string,
    dshVersion: manifest.dshVersion as string,
    entries,
    formatVersion: 1,
    productVersion: manifest.productVersion as string,
    sourceCommit: manifest.sourceCommit as string,
  }
}

/**
 * Verify that an extracted release exactly matches its internal inventory.
 * @param root - Extracted `mythos-agent` directory.
 * @returns the verified release identity.
 */
export async function verifyExtractedBundle(root: string): Promise<IntegrityManifest> {
  const canonicalRoot = await realpath(root)
  const manifestPath = join(canonicalRoot, integrityManifestName)
  const metadata = await lstat(manifestPath)
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('完整性清单不是普通文件')
  const manifest = parsedManifest(JSON.parse(await readFile(manifestPath, 'utf8')) as unknown)
  const expected = new Map<string, IntegrityEntry>()
  for (const entry of manifest.entries) {
    if (expected.has(entry.path)) throw new Error(`完整性清单路径重复：${entry.path}`)
    expected.set(entry.path, entry)
  }
  const actual = await collectEntries(canonicalRoot)
  if (actual.length !== expected.size) throw new Error('发布包文件数量与完整性清单不一致')
  for (const entry of actual) {
    const wanted = expected.get(entry.path)
    if (wanted === undefined || JSON.stringify(entry) !== JSON.stringify(wanted)) {
      throw new Error(`发布包内容被篡改：${entry.path}`)
    }
  }
  for (const required of [
    'bin/mythos.js',
    'home/profiles/mythos/cordis.patch.yml',
    'home/profiles/mythos-web/cordis.patch.yml',
    'node_modules',
    'runtime/dsh/lib/bin.js',
    'runtime/dsh/node_modules/.pnpm/node_modules/@deepseek-ai/dsh-web-frontend',
    'runtime/dsh/package.json',
  ]) {
    if (!expected.has(required)) throw new Error(`发布包缺少运行文件：${required}`)
  }
  const productManifest = JSON.parse(await readFile(join(canonicalRoot, 'package.json'), 'utf8')) as {
    mythos?: { dshCommit?: unknown, dshVersion?: unknown }
    version?: unknown
  }
  const runtimeManifest = JSON.parse(await readFile(join(canonicalRoot, 'runtime', 'dsh', 'package.json'), 'utf8')) as {
    version?: unknown
  }
  const frontendIndex = await realpath(join(canonicalRoot, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'))
  if (!inside(canonicalRoot, frontendIndex) || !(await lstat(frontendIndex)).isFile()) {
    throw new Error('发布包 Web frontend 不在运行闭包内')
  }
  if (productManifest.version !== manifest.productVersion
    || productManifest.mythos?.dshVersion !== manifest.dshVersion
    || productManifest.mythos?.dshCommit !== manifest.dshCommit
    || runtimeManifest.version !== manifest.dshVersion) {
    throw new Error('发布包产品、DSH 与完整性清单版本不一致')
  }
  return manifest
}

async function copyExternalPackage(source: string, destination: string): Promise<void> {
  await cp(source, destination, {
    filter: path => basename(path) !== '.git' && basename(path) !== 'node_modules',
    recursive: true,
  })
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function packageRoots(root: string): Promise<string[]> {
  const roots: string[] = []
  async function visit(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true })
    if (children.some(child => child.isFile() && child.name === 'package.json')) roots.push(directory)
    for (const child of children) {
      if (child.isDirectory()) await visit(join(directory, child.name))
    }
  }
  await visit(root)
  return roots
}

function workspacePackageSources(repositoryRoot: string): Map<string, string> {
  const manifests = execFileSync('git', ['ls-files', '-z', ':(glob)**/package.json'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).split('\0').filter(Boolean)
  const sources = new Map<string, string>()
  for (const manifestPath of manifests) {
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, manifestPath), 'utf8')) as { name?: unknown }
    if (typeof manifest.name === 'string') sources.set(manifest.name, dirname(join(repositoryRoot, manifestPath)))
  }
  return sources
}

async function hasDependency(packageRoot: string, runtimeRoot: string, name: string): Promise<boolean> {
  let current = packageRoot
  while (inside(runtimeRoot, current)) {
    if (await exists(join(current, 'node_modules', ...name.split('/')))) return true
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return false
}

async function closeRequiredWorkspaceDependencies(runtimeRoot: string, repositoryRoot: string): Promise<void> {
  const sources = workspacePackageSources(repositoryRoot)
  const externalRoot = join(runtimeRoot, '.mythos-external')
  const queue = await packageRoots(runtimeRoot)
  const visited = new Set<string>()
  for (let index = 0; index < queue.length; index += 1) {
    const packageRoot = queue[index]
    if (packageRoot === undefined || visited.has(packageRoot)) continue
    visited.add(packageRoot)
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      name?: string
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
    }
    const required = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}).filter(name => manifest.peerDependenciesMeta?.[name]?.optional !== true),
    ])
    for (const name of required) {
      if (name === manifest.name || await hasDependency(packageRoot, runtimeRoot, name)) continue
      const source = sources.get(name)
      if (source === undefined) continue
      const packagedTarget = join(externalRoot, name.replaceAll('@', '').replaceAll('/', '__'))
      if (!await exists(packagedTarget)) await copyExternalPackage(source, packagedTarget)
      const dependencyPath = join(packageRoot, 'node_modules', ...name.split('/'))
      await rm(dependencyPath, { force: true, recursive: true })
      await mkdir(dirname(dependencyPath), { recursive: true })
      await symlink(relative(dirname(dependencyPath), packagedTarget), dependencyPath)
      queue.push(packagedTarget)
    }
  }
}

/**
 * Replace deploy-time workspace links with links to one packaged internal copy.
 * @param runtimeRoot - pnpm deployment root.
 * @param repositoryRoot - DSH source checkout used for the deployment.
 */
export async function closeWorkspaceSymlinks(runtimeRoot: string, repositoryRoot: string): Promise<void> {
  const canonicalRuntime = resolve(runtimeRoot)
  const canonicalRepository = resolve(repositoryRoot)
  const dshSource = join(canonicalRepository, 'apps', 'cli')
  const externalRoot = join(canonicalRuntime, '.mythos-external')
  const copies = new Map<string, string>()
  const links: Array<{ path: string, source: string }> = []

  async function inspect(directory: string): Promise<void> {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, child.name)
      if (child.isSymbolicLink()) {
        const source = resolve(dirname(path), await readlink(path))
        if (!inside(canonicalRuntime, source)) links.push({ path, source })
      } else if (child.isDirectory()) {
        await inspect(path)
      }
    }
  }
  await inspect(canonicalRuntime)

  for (const { path, source } of links) {
    if (!inside(canonicalRepository, source)) throw new Error(`DSH deploy 链接指向未知位置：${path}`)
    let packagedTarget: string
    if (source === dshSource) {
      packagedTarget = canonicalRuntime
    } else {
      const sourceManifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as { name?: unknown }
      if (typeof sourceManifest.name !== 'string' || sourceManifest.name === '') {
        throw new Error(`DSH deploy 外部包缺少名称：${source}`)
      }
      const packageName = sourceManifest.name.replaceAll('@', '').replaceAll('/', '__')
      packagedTarget = join(externalRoot, packageName)
      if (!copies.has(source)) {
        await copyExternalPackage(source, packagedTarget)
        copies.set(source, packagedTarget)
      }
    }
    await rm(path)
    await symlink(relative(dirname(path), packagedTarget), path)
  }

  await closeRequiredWorkspaceDependencies(canonicalRuntime, canonicalRepository)
  await collectEntries(canonicalRuntime)
}

/**
 * Reject archive members that could extract outside the expected root.
 * @param entries - Paths reported by `tar -tzf`.
 */
export function verifyArchiveEntries(entries: readonly string[]): void {
  if (entries.length === 0) throw new Error('发布归档为空')
  for (const entry of entries) {
    const normalized = entry.replace(/\/$/u, '')
    if (normalized === 'mythos-agent') continue
    if (!normalized.startsWith('mythos-agent/') || isAbsolute(normalized) || normalized.split('/').includes('..')) {
      throw new Error(`发布归档路径不安全：${entry}`)
    }
    const secretPath = /(?:^|\/)\.env(?:\.|$)/u.test(normalized)
    const productRuntimeData = /^mythos-agent\/(?:runs|sessions|flywheel\/data|home\/(?:runs|sessions))(?:\/|$)/u.test(normalized)
    if (secretPath || productRuntimeData) {
      throw new Error(`发布归档包含密钥或运行数据路径：${entry}`)
    }
  }
}
