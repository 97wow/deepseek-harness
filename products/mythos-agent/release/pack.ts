import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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

async function normalizeMetadata(path: string): Promise<void> {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink()) return
  if (metadata.isDirectory()) {
    const children = await readdir(path)
    children.sort((left, right) => left.localeCompare(right, 'en'))
    for (const child of children) await normalizeMetadata(join(path, child))
  }
  await utimes(path, fixedTimestamp, fixedTimestamp)
}

function archive(stagingRoot: string): Buffer {
  const tar = execFileSync('tar', ['-cf', '-', '--format', 'pax', '-C', stagingRoot, 'mythos-agent'], {
    maxBuffer: 1024 * 1024 * 1024,
  })
  return gzipSync(tar, { level: 9 })
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
  const dependencyLockSha256 = createHash('sha256').update(await readFile(join(repositoryRoot, 'pnpm-lock.yaml'))).digest('hex')
  await writeIntegrityManifest(releaseRoot, {
    dependencyLockSha256,
    dshCommit: manifest.mythos.dshCommit,
    dshVersion: manifest.mythos.dshVersion,
    productVersion: manifest.version,
    sourceCommit,
  })
  await normalizeMetadata(releaseRoot)
}

/**
 * Build a deterministic self-contained Mythos release archive.
 * @returns archive and checksum paths plus the SHA-256 digest.
 */
export async function packRelease(): Promise<PackedRelease> {
  await checkRelease({ requireClean: false })
  const manifest = JSON.parse(await readFile(join(productRoot, 'package.json'), 'utf8')) as ProductManifest
  const sourceCommit = git(['rev-parse', 'HEAD'])
  const shortCommit = sourceCommit.slice(0, 12)
  const stagingRoot = await mkdtemp(join(tmpdir(), 'mythos-release-stage-'))
  try {
    await stageRelease(stagingRoot, manifest, sourceCommit)
    const first = archive(stagingRoot)
    const second = archive(stagingRoot)
    if (!first.equals(second)) throw new Error('Mythos 发布包不是确定性产物')

    const outputRoot = join(productRoot, 'dist')
    const filename = `mythos-agent-${manifest.version}+${shortCommit}.tar.gz`
    const output = join(outputRoot, filename)
    const digest = createHash('sha256').update(first).digest('hex')
    await mkdir(outputRoot, { recursive: true })
    await writeFile(output, first, { mode: 0o644 })
    await writeFile(`${output}.sha256`, `${digest}  ${filename}\n`, { mode: 0o644 })

    const entries = execFileSync('tar', ['-tzf', output], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .trim().split('\n').filter(Boolean)
    verifyArchiveEntries(entries)
    return { archive: output, digest, digestFile: `${output}.sha256` }
  } finally {
    await rm(stagingRoot, { force: true, recursive: true })
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const packed = await packRelease()
  process.stdout.write(`Mythos release pack: ${packed.archive}\nSHA-256: ${packed.digest}\n`)
}
