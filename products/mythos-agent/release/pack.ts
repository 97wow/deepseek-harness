import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, cp, lstat, lutimes, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { closeWorkspaceSymlinks, verifyArchiveEntries, writeIntegrityManifest } from './bundle.js'
import { checkRelease } from './check.js'

interface ProductManifest {
  engines: Record<string, string>
  mythos: {
    dshCommit: string
    dshRepository: string
    dshVersion: string
    runtimeClosure: string
  }
  name: string
  version: string
}

export interface PackedRelease {
  archive: string
  digest: string
  digestFile: string
}

const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(productRoot, '..', '..')
const fixedTimestamp = new Date('2000-01-01T00:00:00.000Z')

function git(args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: repositoryRoot, encoding: 'utf8' }).trim()
}

function buildEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of ['COMSPEC', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'PATHEXT', 'SYSTEMROOT', 'TEMP', 'TERM', 'TMP', 'TMPDIR']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key]
  }
  return environment
}

/** Rebuild the Web shell from the frozen workspace without inherited release credentials. */
export async function buildWebFrontend(): Promise<void> {
  const webDist = join(repositoryRoot, 'apps', 'web', 'dist')
  // Never let an ignored/pre-existing frontend hide a fresh-clone build gap.
  await rm(webDist, { force: true, recursive: true })
  const environment = buildEnvironment()
  execFileSync('pnpm', ['install', '--offline', '--frozen-lockfile'], {
    cwd: repositoryRoot,
    env: environment,
    stdio: 'inherit',
  })
  execFileSync('pnpm', ['--filter', '@deepseek-ai/dsh-web-frontend', 'run', 'build'], {
    cwd: repositoryRoot,
    env: { ...environment, DSH_CLIENT_TITLE: 'Mythos', NODE_ENV: 'production' },
    stdio: 'inherit',
  })
  const index = await lstat(join(webDist, 'index.html'))
  if (!index.isFile() || index.isSymbolicLink()) throw new Error('Mythos Web frontend build 未生成普通 dist/index.html')
}

async function copyTrackedHome(releaseRoot: string): Promise<void> {
  const prefix = 'products/mythos-agent/'
  const files = execFileSync('git', ['ls-files', '-z', `${prefix}home`], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).split('\0').filter(Boolean)
  if (files.length === 0) throw new Error('Mythos home 没有 Git 已跟踪文件')
  for (const file of files) {
    const relativePath = file.slice(prefix.length)
    const destination = join(releaseRoot, relativePath)
    await mkdir(dirname(destination), { recursive: true })
    await cp(join(repositoryRoot, file), destination)
  }
}

/** Normalize every archive member without following symlinks. */
export async function normalizeReleaseMetadata(path: string): Promise<void> {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink()) {
    await lutimes(path, fixedTimestamp, fixedTimestamp)
    return
  }
  if (metadata.isDirectory()) {
    const children = await readdir(path)
    children.sort((left, right) => left.localeCompare(right, 'en'))
    for (const child of children) await normalizeReleaseMetadata(join(path, child))
  }
  await utimes(path, fixedTimestamp, fixedTimestamp)
}

/** Reject checkout- or staging-root bytes from every regular release file. */
export async function assertNoAbsoluteBuildRoots(root: string, candidates: readonly string[]): Promise<void> {
  const needles = candidates.filter(Boolean).map(candidate => Buffer.from(resolve(candidate)))
  async function visit(path: string): Promise<void> {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return
    if (metadata.isFile()) {
      const contents = await readFile(path)
      const leaked = needles.find(needle => contents.includes(needle))
      if (leaked !== undefined) {
        throw new Error(`Mythos 发布闭包包含绝对构建根：${relative(root, path)} (${leaked.toString('utf8')})`)
      }
      return
    }
    if (!metadata.isDirectory()) return
    const children = await readdir(path)
    children.sort((left, right) => left.localeCompare(right, 'en'))
    for (const child of children) await visit(join(path, child))
  }
  await visit(root)
}

async function removeNonRuntimeDeployMetadata(path: string): Promise<void> {
  const children = await readdir(path, { withFileTypes: true })
  for (const child of children) {
    const childPath = join(path, child.name)
    if (child.name === '.bin' || child.name === '.modules.yaml' || child.name === '.pnpm-workspace-state-v1.json') {
      await rm(childPath, { force: true, recursive: true })
    } else if (child.isDirectory()) {
      await removeNonRuntimeDeployMetadata(childPath)
    }
  }
}

async function sortedArchiveMembers(stagingRoot: string): Promise<string[]> {
  const members: string[] = []
  async function visit(path: string): Promise<void> {
    const relativePath = relative(stagingRoot, path)
    members.push(relativePath)
    const metadata = await lstat(path)
    if (!metadata.isDirectory()) return
    const children = await readdir(path)
    children.sort((left, right) => left.localeCompare(right, 'en'))
    for (const child of children) await visit(join(path, child))
  }
  await visit(join(stagingRoot, 'mythos-agent'))
  return members
}

/** Create a tarball using an explicit, sorted, non-recursive member list. */
export async function archiveReleaseTree(stagingRoot: string): Promise<Buffer> {
  const members = await sortedArchiveMembers(stagingRoot)
  const tar = execFileSync('tar', [
    '-cf', '-', '--format', 'gnutar', '--no-xattrs', '--uid=0', '--gid=0', '--uname=root', '--gname=root',
    '--numeric-owner', '--no-recursion', '--null', '-C', stagingRoot, '-T', '-',
  ], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    input: Buffer.from(`${members.join('\0')}\0`),
    maxBuffer: 1024 * 1024 * 1024,
  })
  return gzipSync(tar, { level: 9 })
}

interface BuiltArchive {
  bytes: Buffer
  members: string[]
}

async function diagnosticMembers(stagingRoot: string): Promise<string[]> {
  const releaseRoot = join(stagingRoot, 'mythos-agent')
  const integrity = JSON.parse(await readFile(join(releaseRoot, 'release-integrity.json'), 'utf8')) as {
    entries: Array<Record<string, unknown> & { path: string }>
  }
  const content = new Map(integrity.entries.map(entry => [entry.path, entry]))
  const members: string[] = []
  async function visit(path: string): Promise<void> {
    const memberPath = relative(releaseRoot, path) || '.'
    const metadata = await lstat(path, { bigint: true })
    const type = metadata.isDirectory() ? 'directory' : metadata.isSymbolicLink() ? 'symlink' : 'file'
    const target = metadata.isSymbolicLink() ? await readlink(path) : undefined
    members.push(JSON.stringify({
      content: content.get(memberPath),
      gid: metadata.gid.toString(),
      mode: (metadata.mode & 0o777n).toString(8),
      mtimeNs: metadata.mtimeNs.toString(),
      path: memberPath,
      size: metadata.size.toString(),
      target,
      type,
      uid: metadata.uid.toString(),
    }))
    if (!metadata.isDirectory()) return
    const children = await readdir(path)
    children.sort((left, right) => left.localeCompare(right, 'en'))
    for (const child of children) await visit(join(path, child))
  }
  await visit(releaseRoot)
  return members
}

async function buildArchive(manifest: ProductManifest, sourceCommit: string): Promise<BuiltArchive> {
  const stagingRoot = await mkdtemp(join(tmpdir(), 'mythos-release-stage-'))
  try {
    await stageRelease(stagingRoot, manifest, sourceCommit)
    return {
      bytes: await archiveReleaseTree(stagingRoot),
      members: await diagnosticMembers(stagingRoot),
    }
  } finally {
    await rm(stagingRoot, { force: true, recursive: true })
  }
}

function describeDifference(first: BuiltArchive, second: BuiltArchive): string {
  const length = Math.max(first.members.length, second.members.length)
  for (let index = 0; index < length; index += 1) {
    if (first.members[index] !== second.members[index]) {
      return `成员 ${String(index + 1)} 不同：${first.members[index] ?? '<缺失>'} != ${second.members[index] ?? '<缺失>'}`
    }
  }
  return `成员内容一致但归档头不同（${String(first.bytes.length)} != ${String(second.bytes.length)} bytes）`
}

async function stageRelease(stagingRoot: string, manifest: ProductManifest, sourceCommit: string): Promise<void> {
  const releaseRoot = join(stagingRoot, 'mythos-agent')
  const runtimeRoot = join(releaseRoot, 'runtime', 'dsh')
  await mkdir(join(releaseRoot, 'bin'), { recursive: true })
  await copyTrackedHome(releaseRoot)

  execFileSync('pnpm', [
    '--offline', '--frozen-lockfile', '--filter', '@deepseek-ai/dsh',
    'deploy', '--prod', '--legacy', runtimeRoot,
  ], { cwd: repositoryRoot, stdio: 'inherit' })
  await closeWorkspaceSymlinks(runtimeRoot, repositoryRoot)
  const bundledWebIndex = join(
    runtimeRoot, 'node_modules', '.pnpm', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html',
  )
  const webIndex = await lstat(bundledWebIndex)
  if (!webIndex.isFile() || webIndex.isSymbolicLink()) throw new Error('Mythos DSH 运行闭包缺少 Web frontend dist/index.html')
  // pnpm deploy shims embed the random staging path in NODE_PATH. Mythos invokes
  // DSH's JavaScript entry directly, so these CLI convenience shims are not part
  // of the production runtime closure and must not enter a reproducible archive.
  await removeNonRuntimeDeployMetadata(join(runtimeRoot, 'node_modules'))
  await symlink('runtime/dsh/node_modules/.pnpm/node_modules', join(releaseRoot, 'node_modules'))

  execFileSync(join(repositoryRoot, 'node_modules', '.bin', 'tsc'), [
    '--ignoreConfig', '--target', 'ES2023', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', '--types', 'node', '--rootDir', join(productRoot, 'product'),
    '--outDir', join(releaseRoot, 'bin'), join(productRoot, 'product', 'launch.ts'),
  ], { cwd: repositoryRoot, stdio: 'inherit' })
  const launcher = join(releaseRoot, 'bin', 'launch.js')
  const publishedLauncher = join(releaseRoot, 'bin', 'mythos.js')
  await cp(launcher, publishedLauncher)
  await rm(launcher)
  await chmod(publishedLauncher, 0o755)

  const packagedManifest = {
    bin: { mythos: 'bin/mythos.js' },
    engines: manifest.engines,
    mythos: manifest.mythos,
    name: manifest.name,
    private: true,
    scripts: {
      agent: 'node bin/mythos.js headless',
      web: 'node bin/mythos.js web',
    },
    type: 'module',
    version: manifest.version,
  }
  await writeFile(join(releaseRoot, 'package.json'), `${JSON.stringify(packagedManifest, undefined, 2)}\n`, { mode: 0o644 })
  await assertNoAbsoluteBuildRoots(releaseRoot, [repositoryRoot, stagingRoot])
  const dependencyLockSha256 = createHash('sha256').update(await readFile(join(repositoryRoot, 'pnpm-lock.yaml'))).digest('hex')
  await writeIntegrityManifest(releaseRoot, {
    dependencyLockSha256,
    dshCommit: manifest.mythos.dshCommit,
    dshVersion: manifest.mythos.dshVersion,
    productVersion: manifest.version,
    sourceCommit,
  })
  await normalizeReleaseMetadata(releaseRoot)
}

/**
 * Build a deterministic self-contained Mythos release archive.
 * @returns archive and checksum paths plus the SHA-256 digest.
 */
export async function packRelease(): Promise<PackedRelease> {
  await checkRelease({ requireClean: false })
  await buildWebFrontend()
  const manifest = JSON.parse(await readFile(join(productRoot, 'package.json'), 'utf8')) as ProductManifest
  const sourceCommit = git(['rev-parse', 'HEAD'])
  const shortCommit = sourceCommit.slice(0, 12)
  const first = await buildArchive(manifest, sourceCommit)
  const second = await buildArchive(manifest, sourceCommit)
  if (!first.bytes.equals(second.bytes)) {
    throw new Error(`Mythos 两次独立 staging 的发布包不同：${describeDifference(first, second)}`)
  }

  const outputRoot = join(productRoot, 'dist')
  const filename = `mythos-agent-${manifest.version}+${shortCommit}.tar.gz`
  const output = join(outputRoot, filename)
  const digest = createHash('sha256').update(first.bytes).digest('hex')
  await mkdir(outputRoot, { recursive: true })
  await writeFile(output, first.bytes, { mode: 0o644 })
  await writeFile(`${output}.sha256`, `${digest}  ${filename}\n`, { mode: 0o644 })

  const entries = execFileSync('tar', ['-tzf', output], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .trim().split('\n').filter(Boolean)
  verifyArchiveEntries(entries)
  return { archive: output, digest, digestFile: `${output}.sha256` }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const packed = await packRelease()
  process.stdout.write(`Mythos release pack: ${packed.archive}\nSHA-256: ${packed.digest}\n`)
}
