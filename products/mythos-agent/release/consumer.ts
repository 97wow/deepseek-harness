import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyArchiveEntries, verifyExtractedBundle } from './bundle.js'
import { verifyM3CliMock } from './m3-cli.js'

const outputLimit = 1024 * 1024

function cleanEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of ['COMSPEC', 'LANG', 'LC_ALL', 'PATH', 'PATHEXT', 'SYSTEMROOT', 'TEMP', 'TERM', 'TMP', 'TMPDIR']) {
    if (source[key] !== undefined) environment[key] = source[key]
  }
  return environment
}

function appendBounded(current: string, chunk: Buffer): string {
  const next = current + chunk.toString('utf8')
  if (Buffer.byteLength(next) > outputLimit) throw new Error('Mythos consumer 输出超过 1 MiB')
  return next
}

async function fetchRequired(url: URL, expected: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`${url.pathname} 返回 HTTP ${String(response.status)}`)
  const body = await response.text()
  if (!body.includes(expected)) throw new Error(`${url.pathname} 缺少 ${expected}`)
}

async function smokeWeb(releaseRoot: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const entry = join(releaseRoot, 'bin', 'mythos.js')
  const child = spawn(process.execPath, [entry, 'web', '--port', '0'], {
    cwd: releaseRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout = appendBounded(stdout, chunk) })
  child.stderr.on('data', (chunk: Buffer) => { stderr = appendBounded(stderr, chunk) })
  const exited = new Promise<number | null>(resolveExit => { child.once('exit', resolveExit) })

  try {
    const baseUrl = await new Promise<URL>((resolveUrl, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Mythos consumer Web 启动超时\n${stderr}`)), 30_000)
      const inspect = (): void => {
        const match = stdout.match(/dsh web: (http:\/\/[^\s]+)/u)
        if (match?.[1] === undefined) return
        clearTimeout(timeout)
        resolveUrl(new URL(match[1]))
      }
      child.stdout.on('data', inspect)
      child.once('error', error => {
        clearTimeout(timeout)
        reject(error)
      })
      child.once('exit', code => {
        clearTimeout(timeout)
        reject(new Error(`Mythos consumer Web 在就绪前退出：${String(code)}\n${stderr}`))
      })
    })

    if (baseUrl.hostname !== '127.0.0.1') throw new Error(`Mythos consumer Web 未绑定 loopback：${baseUrl.href}`)
    await fetchRequired(baseUrl, 'window.__DSH_BOOT__')
    await fetchRequired(new URL('/plugins/@deepseek-ai/dsh-client-ui-agent-preset/client.js', baseUrl), 'agent-preset')
    await fetchRequired(new URL('/plugins/@deepseek-ai/dsh-client-ui-model-selection/client.js', baseUrl), 'model')
  } finally {
    child.kill('SIGTERM')
  }

  const exit = await new Promise<number | null>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Mythos consumer Web 未在 SIGTERM 后退出'))
    }, 10_000)
    void exited.then(code => {
      clearTimeout(timeout)
      resolveExit(code)
    }, reject)
  })
  if (exit !== 0) throw new Error(`Mythos consumer Web 停服失败：${String(exit)}\n${stderr}`)
}

/**
 * Exercise both release surfaces without inheriting credentials or repo tooling.
 * @param releaseRoot - Verified extracted release directory.
 */
export async function smokeExtractedRelease(releaseRoot: string): Promise<void> {
  const environment = cleanEnvironment(process.env)
  environment.HOME = join(releaseRoot, 'home')
  environment.USERPROFILE = environment.HOME
  const entry = join(releaseRoot, 'bin', 'mythos.js')
  const headless = spawnSync(process.execPath, [entry, 'headless', '--dump-config'], {
    cwd: releaseRoot,
    encoding: 'utf8',
    env: environment,
    maxBuffer: outputLimit,
  })
  if (headless.error !== undefined) throw headless.error
  if (headless.status !== 0) throw new Error(`Mythos consumer Headless 配置启动失败：${String(headless.status)}\n${headless.stderr}`)
  for (const expected of ['name: Mythos M3', 'model: deepseek-v4-flash', 'You are Mythos Agent']) {
    if (!headless.stdout.includes(expected)) throw new Error(`Mythos consumer Headless 配置缺少 ${expected}`)
  }
  await verifyM3CliMock(releaseRoot)
  await smokeWeb(releaseRoot, environment)
}

/**
 * Verify, extract, run, and negatively probe one packed release.
 * @param archive - `.tar.gz` release path.
 * @param digestFile - sibling SHA-256 file.
 */
export async function verifyPackedConsumer(archive: string, digestFile: string): Promise<void> {
  const digestLine = (await readFile(digestFile, 'utf8')).trim()
  const match = digestLine.match(/^([a-f0-9]{64})  ([^/]+\.tar\.gz)$/u)
  if (match?.[1] === undefined || match[2] !== basename(archive)) throw new Error('发布包 SHA-256 文件格式无效')
  const actualDigest = createHash('sha256').update(await readFile(archive)).digest('hex')
  if (actualDigest !== match[1]) throw new Error('发布包 SHA-256 不匹配')

  const entries = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (entries.error !== undefined) throw entries.error
  if (entries.status !== 0) throw new Error(`无法读取发布归档：${entries.stderr}`)
  verifyArchiveEntries(entries.stdout.trim().split('\n').filter(Boolean))

  const extractionRoot = await mkdtemp(join(tmpdir(), 'mythos-consumer-'))
  try {
    const extracted = spawnSync('tar', ['-xzf', archive, '-C', extractionRoot], { encoding: 'utf8' })
    if (extracted.error !== undefined) throw extracted.error
    if (extracted.status !== 0) throw new Error(`无法解压发布归档：${extracted.stderr}`)
    const releaseRoot = join(extractionRoot, 'mythos-agent')
    await verifyExtractedBundle(releaseRoot)
    await smokeExtractedRelease(releaseRoot)

    await appendFile(join(releaseRoot, 'package.json'), ' ')
    try {
      await verifyExtractedBundle(releaseRoot)
    } catch {
      return
    }
    throw new Error('发布包篡改负向探针未被拒绝')
  } finally {
    await rm(extractionRoot, { force: true, recursive: true })
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const archive = process.argv[2]
  const digestFile = process.argv[3]
  if (archive === undefined || digestFile === undefined) throw new Error('用法：consumer.ts <archive.tar.gz> <archive.sha256>')
  await verifyPackedConsumer(resolve(archive), resolve(digestFile))
  process.stdout.write('Mythos release consumer: Headless、Web、静态资源与篡改拒绝通过\n')
}
