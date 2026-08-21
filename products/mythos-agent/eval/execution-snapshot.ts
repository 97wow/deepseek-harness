import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface SnapshotFileIdentity {
  mode: string
  objectId: string
  path: string
  type: 'blob' | 'commit'
}

export interface ExecutionSnapshotCommitment {
  algorithm: 'git-tree-sha256-v1'
  files: SnapshotFileIdentity[]
  gitCommit: string
  gitObjectFormat: 'sha1' | 'sha256'
  gitTree: string
  sha256: string
}

export interface VerifiedExecutionSnapshot {
  commitmentSha256: string
  gitCommit: string
  gitTree: string
  root: string
}

export interface ArtifactFileIdentity {
  mode: number
  path: string
  sha256: string
  size: number
  type: 'file' | 'symlink'
}

export interface ExecutionArtifactCommitment {
  algorithm: 'execution-artifact-sha256-v1'
  build: { commands: readonly string[]; nodeVersion: string; pnpmVersion: string }
  files: ArtifactFileIdentity[]
  mutableRoots: readonly ['products/mythos-agent/home/sessions', 'products/mythos-agent/runs']
  sha256: string
  source: ExecutionSnapshotCommitment
}

export interface ExecutionArtifactHooks {
  build(root: string): Promise<void>
  install(root: string): Promise<void>
}

const mutableRoots = ['products/mythos-agent/home/sessions', 'products/mythos-agent/runs'] as const

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

async function git(repoRoot: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  return stdout
}

async function run(root: string, file: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(file, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

function parseTree(output: string): SnapshotFileIdentity[] {
  return output.split('\0').filter(Boolean).map(record => {
    const separator = record.indexOf('\t')
    const metadata = record.slice(0, separator).split(' ')
    const path = record.slice(separator + 1)
    const [mode, type, objectId] = metadata
    if (separator < 0 || mode === undefined || objectId === undefined || (type !== 'blob' && type !== 'commit')
      || path === '' || path.startsWith('/') || path.split('/').includes('..')) {
      throw new Error('Git tree 包含无法承诺的条目')
    }
    return { mode, objectId, path, type: type as 'blob' | 'commit' }
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

/** Builds a content-addressed inventory from a committed Git tree without reading the worktree. */
export async function commitExecutionSnapshot(repoRoot: string, revision = 'HEAD'): Promise<ExecutionSnapshotCommitment> {
  const root = (await git(repoRoot, ['rev-parse', '--show-toplevel'])).trim()
  const gitCommit = (await git(root, ['rev-parse', `${revision}^{commit}`])).trim()
  const gitTree = (await git(root, ['rev-parse', `${gitCommit}^{tree}`])).trim()
  const configuredFormat = (await git(root, ['rev-parse', '--show-object-format'])).trim()
  const gitObjectFormat: 'sha1' | 'sha256' = configuredFormat === 'sha256' ? 'sha256' : 'sha1'
  const files = parseTree(await git(root, ['ls-tree', '-r', '-z', '--full-tree', gitCommit]))
  const identity = { files, gitCommit, gitObjectFormat, gitTree }
  return { algorithm: 'git-tree-sha256-v1', ...identity,
    sha256: createHash('sha256').update(canonical(identity)).digest('hex') }
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

function gitBlobId(contents: Buffer, algorithm: 'sha1' | 'sha256'): string {
  return createHash(algorithm).update(`blob ${contents.length}\0`).update(contents).digest('hex')
}

async function inventory(root: string, directory = root, allowGitMetadata = false): Promise<string[]> {
  const result: string[] = []
  for (const name of await readdir(directory)) {
    const absolute = resolve(directory, name)
    const information = await lstat(absolute)
    const path = relative(root, absolute).split(sep).join('/')
    if (allowGitMetadata && path === '.git') continue
    if (information.isDirectory()) result.push(...await inventory(root, absolute, allowGitMetadata))
    else if (information.isFile() || information.isSymbolicLink()) result.push(path)
    else throw new Error('执行快照包含非普通文件')
  }
  return result.sort()
}

async function artifactInventory(root: string, directory = root): Promise<ArtifactFileIdentity[]> {
  const result: ArtifactFileIdentity[] = []
  for (const name of await readdir(directory)) {
    const absolute = resolve(directory, name)
    const information = await lstat(absolute)
    const path = relative(root, absolute).split(sep).join('/')
    if (mutableRoots.some(mutable => path === mutable || path.startsWith(`${mutable}/`))) continue
    if (information.isDirectory()) result.push(...await artifactInventory(root, absolute))
    else if (information.isFile()) {
      const contents = await readFile(absolute)
      result.push({ mode: information.mode & 0o111, path, sha256: createHash('sha256').update(contents).digest('hex'),
        size: contents.length, type: 'file' })
    } else if (information.isSymbolicLink()) {
      const target = await readlink(absolute)
      const resolvedTarget = resolve(dirname(absolute), target)
      if (isAbsolute(target) || !inside(root, resolvedTarget)) throw new Error('执行产物包含快照外符号链接')
      const contents = Buffer.from(target)
      result.push({ mode: information.mode & 0o111, path, sha256: createHash('sha256').update(contents).digest('hex'),
        size: contents.length, type: 'symlink' })
    } else throw new Error('执行产物包含非普通文件')
  }
  return result.sort((left, right) => left.path.localeCompare(right.path))
}

/** Verifies an extracted snapshot byte-for-byte against its committed Git inventory. */
export async function verifyExecutionSnapshot(
  snapshotRoot: string,
  commitment: ExecutionSnapshotCommitment,
  allowGitMetadata = false,
): Promise<VerifiedExecutionSnapshot> {
  const root = await realpath(snapshotRoot)
  const expectedPaths = commitment.files.map(file => file.path)
  const actualPaths = await inventory(root, root, allowGitMetadata)
  if (canonical(actualPaths) !== canonical(expectedPaths)) throw new Error('执行快照文件集合与 commitment 不一致')
  for (const file of commitment.files) {
    if (file.type !== 'blob') throw new Error('执行快照不支持未物化的 Git 子模块')
    const absolute = resolve(root, file.path)
    if (!inside(root, absolute)) throw new Error('执行快照路径逃逸')
    const information = await lstat(absolute)
    let contents: Buffer
    if (file.mode === '120000') {
      if (!information.isSymbolicLink()) throw new Error('执行快照符号链接类型不一致')
      contents = Buffer.from(await readlink(absolute))
      const target = await realpath(absolute)
      if (!inside(root, target)) throw new Error('执行快照符号链接逃逸')
    } else {
      if (!information.isFile() || information.isSymbolicLink()) throw new Error('执行快照文件类型不一致')
      contents = await readFile(absolute)
    }
    if (gitBlobId(contents, commitment.gitObjectFormat) !== file.objectId) {
      throw new Error('执行快照内容与 commitment 不一致')
    }
  }
  return Object.freeze({ commitmentSha256: commitment.sha256, gitCommit: commitment.gitCommit,
    gitTree: commitment.gitTree, root })
}

/** Rejects any runtime-resolved path outside the verified source snapshot. */
export async function assertSnapshotRuntimePath(snapshot: VerifiedExecutionSnapshot, candidate: string): Promise<string> {
  const canonical = await realpath(candidate)
  if (!inside(snapshot.root, canonical)) throw new Error('运行期模块位于已验证执行快照之外')
  return canonical
}

async function defaultHooks(): Promise<ExecutionArtifactHooks> {
  return {
    async install(root) { await run(root, 'pnpm', ['install', '--offline', '--frozen-lockfile', '--ignore-scripts']) },
    async build(root) { await run(root, 'pnpm', ['build']) },
  }
}

async function buildCommittedTree(
  repoRoot: string,
  destination: string,
  sourceCommitment: ExecutionSnapshotCommitment,
  hooks: ExecutionArtifactHooks,
): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), 'mythos-locked-source-'))
  const source = join(temporary, 'source')
  await run(repoRoot, 'git', ['worktree', 'add', '--detach', source, sourceCommitment.gitCommit])
  try {
    // Build in the detached committed tree so repository identity used by build tooling is
    // the locked identity. Only the post-build tree is copied into the standalone artifact.
    await verifyExecutionSnapshot(source, sourceCommitment, true)
    await hooks.install(source)
    await hooks.build(source)
    await cp(source, destination, {
      recursive: true, verbatimSymlinks: true, filter: path => path !== join(source, '.git'),
    })
  } finally {
    await run(repoRoot, 'git', ['worktree', 'remove', '--force', source])
    await rm(temporary, { force: true, recursive: true })
  }
}

/** Materializes, offline-installs, builds, and hashes a self-contained evaluation artifact. */
export async function materializeExecutionArtifact(
  repoRoot: string,
  destination: string,
  suppliedSource?: ExecutionSnapshotCommitment,
  hooks?: ExecutionArtifactHooks,
): Promise<ExecutionArtifactCommitment> {
  const source = suppliedSource ?? await commitExecutionSnapshot(repoRoot)
  await mkdir(destination, { recursive: true })
  if ((await readdir(destination)).length !== 0) throw new Error('执行产物目录必须为空')
  const operations = hooks ?? await defaultHooks()
  await buildCommittedTree(repoRoot, destination, source, operations)
  for (const path of mutableRoots) await mkdir(resolve(destination, path), { recursive: true })
  const pnpmVersion = (await run(destination, 'pnpm', ['--version'])).trim()
  const files = await artifactInventory(destination)
  const build = { commands: ['pnpm install --offline --frozen-lockfile --ignore-scripts', 'pnpm build'],
    nodeVersion: process.version, pnpmVersion }
  const identity = { build, files, mutableRoots, source }
  return { algorithm: 'execution-artifact-sha256-v1', ...identity,
    sha256: createHash('sha256').update(canonical(identity)).digest('hex') }
}

/** Revalidates a materialized dependency/build artifact without Git or network access. */
export async function verifyExecutionArtifact(
  root: string,
  commitment: ExecutionArtifactCommitment,
): Promise<VerifiedExecutionSnapshot> {
  const canonicalRoot = await realpath(root)
  const files = await artifactInventory(canonicalRoot)
  const identity = { build: commitment.build, files, mutableRoots: commitment.mutableRoots, source: commitment.source }
  if (createHash('sha256').update(canonical(identity)).digest('hex') !== commitment.sha256) {
    throw new Error('离线执行产物内容与 commitment 不一致')
  }
  return Object.freeze({ commitmentSha256: commitment.sha256, gitCommit: commitment.source.gitCommit,
    gitTree: commitment.source.gitTree, root: canonicalRoot })
}

/** Writes only hashes and paths; no file contents are serialized into the manifest. */
export async function writeExecutionArtifactManifest(path: string, commitment: ExecutionArtifactCommitment): Promise<void> {
  await writeFile(path, `${JSON.stringify(commitment)}\n`, { mode: 0o600 })
}

/** Reads the machine manifest; content verification remains mandatory before use. */
export async function readExecutionArtifactManifest(path: string): Promise<ExecutionArtifactCommitment> {
  const value = JSON.parse(await readFile(path, 'utf8')) as Partial<ExecutionArtifactCommitment>
  if (value.algorithm !== 'execution-artifact-sha256-v1' || typeof value.sha256 !== 'string'
    || !Array.isArray(value.files) || value.source?.algorithm !== 'git-tree-sha256-v1') {
    throw new Error('执行产物 manifest schema 无效')
  }
  return value as ExecutionArtifactCommitment
}

/** Makes committed code and installed dependencies read-only while preserving dedicated output roots. */
export async function lockExecutionArtifact(root: string): Promise<void> {
  const canonicalRoot = await realpath(root)
  async function visit(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const absolute = resolve(directory, name)
      const path = relative(canonicalRoot, absolute).split(sep).join('/')
      if (mutableRoots.some(mutable => path === mutable || path.startsWith(`${mutable}/`))) continue
      const information = await lstat(absolute)
      if (information.isDirectory()) { await visit(absolute); await chmod(absolute, 0o555) }
      else if (information.isFile()) await chmod(absolute, information.mode & 0o111 ? 0o555 : 0o444)
    }
  }
  await visit(canonicalRoot)
  for (const path of mutableRoots) await chmod(resolve(canonicalRoot, path), 0o700)
}
