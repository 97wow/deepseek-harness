import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { evaluationRuntimeSourceFiles } from './entry-registry.js'

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
  sha256: string | null
  size: number
  symlinkTarget: string | null
  type: 'directory' | 'file' | 'symlink'
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

export interface ExecutionArtifactParentAnchor {
  artifactSha256: string
  gitCommit: string
  gitTree: string
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

async function gitBytes(repoRoot: string, args: readonly string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync('git', args, { cwd: repoRoot, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

async function run(root: string, file: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(file, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

function decodeUtf8(bytes: Buffer, subject: string): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new Error(`${subject} 不是有效 UTF-8，无法无损承诺`) }
}

function parseTree(output: Buffer): SnapshotFileIdentity[] {
  const records: Buffer[] = []
  let start = 0
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue
    if (index > start) records.push(output.subarray(start, index))
    start = index + 1
  }
  if (start !== output.length) throw new Error('Git tree 输出缺少 NUL 终止符')
  return records.map(record => {
    const separator = record.indexOf(0x09)
    if (separator < 0) throw new Error('Git tree metadata 缺少路径分隔符')
    const metadata = decodeUtf8(record.subarray(0, separator), 'Git tree metadata').split(' ')
    const path = decodeUtf8(record.subarray(separator + 1), 'Git 路径')
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
  const files = parseTree(await gitBytes(root, ['ls-tree', '-r', '-z', '--full-tree', gitCommit]))
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

function pathOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

async function artifactInventory(root: string, directory = root): Promise<ArtifactFileIdentity[]> {
  const result: ArtifactFileIdentity[] = []
  const directoryPath = relative(root, directory).split(sep).join('/') || '.'
  if (!mutableRoots.some(mutable => directoryPath === mutable || directoryPath.startsWith(`${mutable}/`))) {
    const directoryInformation = await lstat(directory)
    if (!directoryInformation.isDirectory() || directoryInformation.isSymbolicLink()) {
      throw new Error('执行产物目录类型无效')
    }
    result.push({ mode: directoryInformation.mode & 0o777, path: directoryPath, sha256: null, size: 0,
      symlinkTarget: null, type: 'directory' })
  }
  for (const name of await readdir(directory)) {
    const absolute = resolve(directory, name)
    const information = await lstat(absolute)
    const path = relative(root, absolute).split(sep).join('/')
    if (mutableRoots.some(mutable => path === mutable || path.startsWith(`${mutable}/`))) continue
    if (information.isDirectory()) result.push(...await artifactInventory(root, absolute))
    else if (information.isFile()) {
      const contents = await readFile(absolute)
      result.push({ mode: information.mode & 0o777, path, sha256: createHash('sha256').update(contents).digest('hex'),
        size: contents.length, symlinkTarget: null, type: 'file' })
    } else if (information.isSymbolicLink()) {
      const targetBytes = await readlink(absolute, { encoding: 'buffer' })
      const target = decodeUtf8(targetBytes, '符号链接目标')
      const resolvedTarget = resolve(dirname(absolute), target)
      if (isAbsolute(target) || !inside(root, resolvedTarget)) throw new Error('执行产物包含快照外符号链接')
      result.push({ mode: information.mode & 0o777, path, sha256: createHash('sha256').update(targetBytes).digest('hex'),
        size: targetBytes.length, symlinkTarget: target, type: 'symlink' })
    } else throw new Error('执行产物包含非普通文件')
  }
  return result.sort((left, right) => pathOrder(left.path, right.path))
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

const evaluationRuntimeCompilerArguments = ['exec', 'tsc', '--ignoreConfig', '--target', 'ES2023', '--module', 'NodeNext',
  '--moduleResolution', 'NodeNext', '--types', 'node', '--outDir', '.mythos-eval-runtime', '--rootDir', '.',
  ...evaluationRuntimeSourceFiles] as const

async function defaultHooks(): Promise<ExecutionArtifactHooks> {
  return {
    async install(root) { await run(root, 'pnpm', ['install', '--offline', '--frozen-lockfile', '--ignore-scripts']) },
    async build(root) {
      await run(root, 'pnpm', ['build'])
      await run(join(root, 'products/mythos-agent'), 'pnpm', evaluationRuntimeCompilerArguments)
    },
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

async function ensureMutableOutputRoots(root: string): Promise<void> {
  const canonicalRoot = await realpath(root)
  for (const configured of mutableRoots) {
    const absolute = resolve(canonicalRoot, configured)
    if (!inside(canonicalRoot, absolute)) throw new Error('可写输出目录逃逸执行产物')
    await mkdir(absolute, { recursive: true })
    const canonical = await realpath(absolute)
    const information = await lstat(absolute)
    if (canonical !== absolute || !information.isDirectory() || information.isSymbolicLink()) {
      throw new Error('可写输出目录覆盖或遮蔽执行路径')
    }
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
  await ensureMutableOutputRoots(destination)
  const pnpmVersion = (await run(destination, 'pnpm', ['--version'])).trim()
  await lockExecutionArtifact(destination)
  const files = await artifactInventory(destination)
  const build = { commands: ['pnpm install --offline --frozen-lockfile --ignore-scripts', 'pnpm build',
    `pnpm --dir products/mythos-agent ${evaluationRuntimeCompilerArguments.join(' ')}`],
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
  if (canonical(files) !== canonical(commitment.files)) throw new Error('离线执行产物文件清单与 commitment 不一致')
  const identity = { build: commitment.build, files, mutableRoots: commitment.mutableRoots, source: commitment.source }
  if (createHash('sha256').update(canonical(identity)).digest('hex') !== commitment.sha256) {
    throw new Error('离线执行产物内容与 commitment 不一致')
  }
  return Object.freeze({ commitmentSha256: commitment.sha256, gitCommit: commitment.source.gitCommit,
    gitTree: commitment.source.gitTree, root: canonicalRoot })
}

/** Captures the supervisor-owned values that a child cannot derive from a replacement manifest. */
export function executionArtifactParentAnchor(commitment: ExecutionArtifactCommitment): ExecutionArtifactParentAnchor {
  return Object.freeze({ artifactSha256: commitment.sha256, gitCommit: commitment.source.gitCommit,
    gitTree: commitment.source.gitTree })
}

/** Rejects a manifest whose public hashes or source identity diverge from the supervisor's in-memory values. */
export function assertExecutionArtifactParentAnchor(
  commitment: ExecutionArtifactCommitment,
  expected: ExecutionArtifactParentAnchor,
): void {
  if (commitment.sha256 !== expected.artifactSha256 || commitment.source.gitCommit !== expected.gitCommit
    || commitment.source.gitTree !== expected.gitTree) {
    throw new Error('执行产物 manifest 与 parent anchor 不一致')
  }
}

/** Returns bytes only after the same buffer matches its parent-anchored artifact entry. */
export async function readAnchoredArtifactFile(
  root: string,
  commitment: ExecutionArtifactCommitment,
  path: string,
): Promise<Buffer> {
  const canonicalRoot = await realpath(root)
  const absolute = resolve(canonicalRoot, path)
  if (!inside(canonicalRoot, absolute)) throw new Error('父锚定文件路径逃逸')
  const entry = commitment.files.find(candidate => candidate.path === path)
  if (entry?.type !== 'file' || entry.sha256 === null) throw new Error('父锚定文件不在产物清单中')
  const canonicalPath = await realpath(absolute)
  const information = await lstat(absolute)
  if (canonicalPath !== absolute || !information.isFile() || information.isSymbolicLink()
    || (information.mode & 0o777) !== entry.mode) {
    throw new Error('父锚定文件类型或 mode 不一致')
  }
  const contents = await readFile(absolute)
  if (contents.length !== entry.size || createHash('sha256').update(contents).digest('hex') !== entry.sha256) {
    throw new Error('父锚定文件内容不一致')
  }
  return contents
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
  await chmod(canonicalRoot, 0o555)
  for (const path of mutableRoots) await chmod(resolve(canonicalRoot, path), 0o700)
}
