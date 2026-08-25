import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const activations = new Map()

function inside(root, candidate) {
  const child = relative(root, candidate)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** Reject archive paths before extraction can write outside its staging root. */
export function validateRuntimeArchiveEntries(entries) {
  if (entries.length === 0) throw new Error('MYTHOS Runtime 归档为空')
  for (const entry of entries) {
    const normalized = entry.replace(/\/$/u, '')
    if (normalized === 'mythos-agent') continue
    if (!normalized.startsWith('mythos-agent/') || isAbsolute(normalized) || normalized.split('/').includes('..')) {
      throw new Error(`MYTHOS Runtime 归档路径不安全：${entry}`)
    }
  }
}

function parsedManifest(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value.formatVersion !== 1) {
    throw new Error('MYTHOS Runtime 完整性清单无效')
  }
  if (!Array.isArray(value.entries)) throw new Error('MYTHOS Runtime 完整性条目无效')
  const entries = new Map()
  for (const [index, row] of value.entries.entries()) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)
      || typeof row.path !== 'string' || row.path === '' || isAbsolute(row.path) || row.path.split('/').includes('..')
      || entries.has(row.path)) {
      throw new Error(`MYTHOS Runtime 完整性条目 ${String(index)} 无效`)
    }
    if (row.type === 'file' && typeof row.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(row.sha256)
      && Number.isInteger(row.size) && row.size >= 0 && Number.isInteger(row.mode)) {
      entries.set(row.path, { mode: row.mode, path: row.path, sha256: row.sha256, size: row.size, type: 'file' })
      continue
    }
    if (row.type === 'symlink' && typeof row.target === 'string') {
      entries.set(row.path, { path: row.path, target: row.target, type: 'symlink' })
      continue
    }
    throw new Error(`MYTHOS Runtime 完整性条目 ${String(index)} 内容无效`)
  }
  return entries
}

async function collectEntries(root) {
  const entries = []
  async function visit(directory, parts) {
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const child of children) {
      const path = join(directory, child.name)
      const childParts = [...parts, child.name]
      const relativePath = childParts.join('/')
      if (parts.length === 0 && child.name === 'release-integrity.json') continue
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
        if (!inside(root, resolve(dirname(path), target))) throw new Error(`MYTHOS Runtime 符号链接越界：${relativePath}`)
        entries.push({ path: relativePath, target, type: 'symlink' })
      } else {
        throw new Error(`MYTHOS Runtime 包含不支持的文件：${relativePath}`)
      }
    }
  }
  await visit(root, [])
  return entries
}

/** Verify the extracted tree against its release-integrity.json inventory. */
export async function verifyRuntimeTree(root) {
  const canonicalRoot = await realpath(root)
  const manifestPath = join(canonicalRoot, 'release-integrity.json')
  const metadata = await lstat(manifestPath)
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('MYTHOS Runtime 完整性清单不是普通文件')
  const expected = parsedManifest(JSON.parse(await readFile(manifestPath, 'utf8')))
  const actual = await collectEntries(canonicalRoot)
  if (actual.length !== expected.size) throw new Error('MYTHOS Runtime 文件数量与完整性清单不一致')
  for (const entry of actual) {
    if (JSON.stringify(entry) !== JSON.stringify(expected.get(entry.path))) {
      throw new Error(`MYTHOS Runtime 内容被篡改：${entry.path}`)
    }
  }
  for (const required of ['bin/mythos.js', 'home/profiles/mythos-web/cordis.patch.yml', 'runtime/dsh/lib/bin.js']) {
    if (!expected.has(required)) throw new Error(`MYTHOS Runtime 缺少运行文件：${required}`)
  }
}

/** Re-seal a release inventory after Desktop-specific native code signing. */
export async function rewriteRuntimeIntegrityManifest(root) {
  const manifestPath = join(root, 'release-integrity.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  parsedManifest(manifest)
  manifest.entries = await collectEntries(await realpath(root))
  await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`, { mode: 0o644 })
}

async function activate({ archive, digestFile, storeRoot, verifyRelease }) {
  const digestLine = (await readFile(digestFile, 'utf8')).trim()
  const digest = /^([a-f0-9]{64})(?:\s{2}.+)?$/u.exec(digestLine)?.[1]
  if (digest === undefined || await hashFile(archive) !== digest) throw new Error('MYTHOS Runtime 归档 SHA-256 不匹配')
  const target = join(storeRoot, digest)
  const ready = join(target, '.ready')
  const release = join(target, 'mythos-agent')
  try {
    if ((await readFile(ready, 'utf8')).trim() === digest) {
      try {
        await verifyRelease(release)
        return release
      } catch {
        await rm(target, { force: true, recursive: true })
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await rm(target, { force: true, recursive: true })

  const tar = process.platform === 'darwin' ? '/usr/bin/tar' : 'tar'
  const listed = await execute(tar, ['-tzf', archive], { maxBuffer: 64 * 1024 * 1024 })
  validateRuntimeArchiveEntries(listed.stdout.trim().split('\n').filter(Boolean))
  await mkdir(storeRoot, { recursive: true })
  const staging = join(storeRoot, `.${digest}.staging-${String(process.pid)}-${Date.now().toString(36)}`)
  await rm(staging, { force: true, recursive: true })
  await mkdir(staging)
  try {
    await execute(tar, ['-xzf', archive, '-C', staging])
    await verifyRelease(join(staging, 'mythos-agent'))
    await writeFile(join(staging, '.ready'), `${digest}\n`, { mode: 0o600 })
    try {
      await rename(staging, target)
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)
        || (await readFile(ready, 'utf8')).trim() !== digest) throw error
      await rm(staging, { force: true, recursive: true })
    }
    return release
  } catch (error) {
    await rm(staging, { force: true, recursive: true })
    throw error
  }
}

/** Atomically materialize the signed Runtime archive in Application Support. */
export async function activatePackagedRuntime(options) {
  const key = `${resolve(options.storeRoot)}\0${resolve(options.archive)}`
  let task = activations.get(key)
  if (task === undefined) {
    task = activate({ ...options, verifyRelease: options.verifyRelease ?? verifyRuntimeTree })
    activations.set(key, task)
  }
  try {
    return await task
  } finally {
    if (activations.get(key) === task) activations.delete(key)
  }
}
