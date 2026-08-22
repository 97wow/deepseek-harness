import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verifyProductProfiles } from '../product/config.js'
import { exposedSecretPolicies } from './security.js'

interface ProductManifest {
  mythos: {
    dshCommit: string
    dshRepository: string
    dshVersion: string
    runtimeClosure: string
  }
  version: string
}

const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(productRoot, '..', '..')

function git(args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: repositoryRoot, encoding: 'utf8' }).trim()
}

async function verifyTrackedSecrets(): Promise<void> {
  const relativeProductRoot = 'products/mythos-agent'
  const files = git(['ls-files', '-z', relativeProductRoot]).split('\0').filter(Boolean)
  if (files.length === 0) throw new Error('Mythos 发布范围没有 Git 已跟踪文件')
  for (const file of files) {
    const policies = exposedSecretPolicies(await readFile(join(repositoryRoot, file), 'utf8'))
    if (policies.length > 0) throw new Error(`${file} 命中密钥策略：${policies.join(', ')}`)
  }
  if (files.some(file => /(?:^|\/)\.env(?:\.|$)/u.test(file))) throw new Error('发布范围包含 .env 文件')
}

async function verifyLocalSecretBoundary(): Promise<void> {
  const environmentFile = join(repositoryRoot, '.env')
  if (git(['check-ignore', environmentFile]) === '') throw new Error('根目录 .env 未被 Git 忽略')
  let mode: number
  try {
    mode = (await stat(environmentFile)).mode & 0o777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (mode !== 0o600) throw new Error(`根目录 .env 权限必须为 600，当前为 ${mode.toString(8)}`)
}

function verifyPinnedDsh(manifest: ProductManifest): void {
  const dshManifest = JSON.parse(execFileSync(process.execPath, ['-e', "process.stdout.write(JSON.stringify(require('./apps/cli/package.json')))"] , {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })) as { version: string }
  if (manifest.mythos.dshVersion !== dshManifest.version) throw new Error('Mythos 与当前 DSH 版本不一致')
  const taggedCommit = git(['rev-parse', `dsh-v${manifest.mythos.dshVersion}^{commit}`])
  if (manifest.mythos.dshCommit !== taggedCommit) throw new Error('Mythos 固定的 DSH 提交与版本标签不一致')
  if (manifest.mythos.dshRepository !== 'https://github.com/deepseek-ai/deepseek-harness.git') {
    throw new Error('Mythos 的 DSH 上游地址不正确')
  }
  if (manifest.mythos.runtimeClosure !== 'bundled-from-frozen-lockfile') {
    throw new Error('Mythos 发布包必须携带 frozen lockfile 生成的 DSH 运行闭包')
  }
}

function verifyDumpedConfig(profile: string, expected: readonly string[]): void {
  const output = execFileSync(process.execPath, [
    join(repositoryRoot, 'apps', 'cli', 'lib', 'bin.js'),
    '--profile', profile, '--dump-config',
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: join(productRoot, 'home') },
  })
  const missing = expected.filter(value => !output.includes(value))
  if (missing.length > 0) throw new Error(`${profile} 组合配置缺少：${missing.join(', ')}`)
}

export async function checkRelease(options: { requireClean?: boolean } = {}): Promise<void> {
  const manifest = JSON.parse(await readFile(join(productRoot, 'package.json'), 'utf8')) as ProductManifest
  await access(join(repositoryRoot, 'apps', 'cli', 'lib', 'bin.js'), constants.R_OK)
  await verifyProductProfiles(productRoot)
  await verifyTrackedSecrets()
  await verifyLocalSecretBoundary()
  verifyPinnedDsh(manifest)
  verifyDumpedConfig('mythos', ['name: Mythos M3', 'model: deepseek-v4-flash', 'You are Mythos Agent'])
  verifyDumpedConfig('mythos-web', ['name: Mythos M3', 'default: mythos', 'You are Mythos Agent'])

  git(['diff', '--check'])
  if (options.requireClean !== false) {
    const status = git(['status', '--porcelain=v1', '--untracked-files=all', '--', 'products/mythos-agent'])
    if (status !== '') throw new Error(`Mythos 发布范围不是干净工作树：\n${status}`)
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await checkRelease()
  process.stdout.write('Mythos release check: 通过\n')
}
