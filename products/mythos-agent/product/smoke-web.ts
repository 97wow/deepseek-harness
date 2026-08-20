import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const launchFile = join(productRoot, 'product', 'launch.ts')
const outputLimit = 1024 * 1024

function appendBounded(current: string, chunk: Buffer): string {
  const next = current + chunk.toString('utf8')
  if (Buffer.byteLength(next) > outputLimit) throw new Error('Mythos Web 冒烟输出超过 1 MiB')
  return next
}

async function fetchRequired(url: URL, expected: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`${url.pathname} 返回 HTTP ${String(response.status)}`)
  const body = await response.text()
  if (!body.includes(expected)) throw new Error(`${url.pathname} 缺少 ${expected}`)
}

const child = spawn(process.execPath, ['--import', 'tsx/esm', launchFile, 'web', '--port', '0'], {
  cwd: resolve(productRoot, '..', '..'),
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk: Buffer) => { stdout = appendBounded(stdout, chunk) })
child.stderr.on('data', (chunk: Buffer) => { stderr = appendBounded(stderr, chunk) })
const exited = new Promise<number | null>(resolveExit => { child.once('exit', resolveExit) })

try {
  const baseUrl = await new Promise<URL>((resolveUrl, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Mythos Web 启动超时\n${stderr}`)), 30_000)
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
      reject(new Error(`Mythos Web 在就绪前退出：${String(code)}\n${stderr}`))
    })
  })

  if (baseUrl.hostname !== '127.0.0.1') throw new Error(`Mythos Web 未绑定 loopback：${baseUrl.href}`)
  await fetchRequired(baseUrl, 'window.__DSH_BOOT__')
  await fetchRequired(new URL('/plugins/@deepseek-ai/dsh-client-ui-agent-preset/client.js', baseUrl), 'agent-preset')
  await fetchRequired(new URL('/plugins/@deepseek-ai/dsh-client-ui-model-selection/client.js', baseUrl), 'model')
} finally {
  child.kill('SIGTERM')
}

const exit = await new Promise<number | null>((resolveExit, reject) => {
  const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Mythos Web 未在 SIGTERM 后退出'))
  }, 10_000)
  void exited.then(code => {
    clearTimeout(timeout)
    resolveExit(code)
  }, reject)
})
if (exit !== 0) throw new Error(`Mythos Web 冒烟停服失败：${String(exit)}\n${stderr}`)
process.stdout.write('Mythos Web smoke: 启动、HTTP、插件与停服通过\n')
