import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { LaunchPaths, LaunchSpec } from './launch.js'

const SESSION_LINE = /^dsh: session-id=(session-[a-zA-Z0-9._-]+)$/u

export interface InteractiveTurnResult {
  code: number
  sessionId?: string
}

export function interactiveBanner(version: string, cwd: string, permissionMode: string): string {
  return [
    `MYTHOS Agent ${version}`,
    `M3 model: deepseek-v4-flash · cwd: ${cwd} · permission: ${permissionMode}`,
    '输入任务开始；/help 查看帮助，/exit 退出。',
  ].join('\n')
}

export function interactiveTurnArgs(task: string, sessionId?: string): string[] {
  return sessionId === undefined ? ['--emit-session-id', task] : ['--resume', sessionId, task]
}

async function runTurn(spec: LaunchSpec): Promise<InteractiveTurnResult> {
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'inherit', 'pipe'] })
  let sessionId: string | undefined
  let buffered = ''
  const handleLine = (line: string): void => {
    const match = SESSION_LINE.exec(line)
    if (match?.[1] !== undefined) sessionId = match[1]
    else if (line !== '') process.stderr.write(`${line}\n`)
  }
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    buffered += chunk
    const lines = buffered.split(/\r?\n/u)
    buffered = lines.pop() ?? ''
    for (const line of lines) handleLine(line)
  })
  let interrupted = false
  const onInterrupt = (): void => {
    interrupted = true
    child.kill('SIGINT')
  }
  process.once('SIGINT', onInterrupt)
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (exitCode, signal) => resolve(exitCode ?? (signal === 'SIGINT' ? 130 : 1)))
    })
    if (buffered !== '') handleLine(buffered)
    return { code: interrupted && code === 0 ? 130 : code, ...(sessionId === undefined ? {} : { sessionId }) }
  } finally {
    process.off('SIGINT', onInterrupt)
  }
}

export async function runInteractive(
  version: string,
  paths: LaunchPaths,
  createSpec: (args: readonly string[]) => LaunchSpec,
): Promise<number> {
  const permissionMode = process.env.DSH_PERMISSION_MODE?.trim() || 'default'
  process.stdout.write(`${interactiveBanner(version, paths.cwd, permissionMode)}\n`)
  const input = createInterface({ input: process.stdin, output: process.stdout, prompt: 'mythos> ' })
  let closed = false
  input.once('close', () => { closed = true })
  const prompt = (): void => {
    if (!closed) input.prompt()
  }
  let sessionId: string | undefined
  let exitCode = 0
  input.on('SIGINT', () => {
    process.stdout.write('\n')
    input.close()
  })
  prompt()
  for await (const line of input) {
    const task = line.trim()
    if (task === '') {
      prompt()
      continue
    }
    if (task === '/exit') break
    if (task === '/help') {
      process.stdout.write('/help  显示帮助\n/exit  退出 MYTHOS\n')
      prompt()
      continue
    }
    process.stdout.write('正在连接 M3 / 处理中…\n')
    const result = await runTurn(createSpec(interactiveTurnArgs(task, sessionId)))
    if (sessionId === undefined && result.sessionId !== undefined) {
      sessionId = result.sessionId
      process.stdout.write(`session-id=${sessionId}\n`)
    }
    if (result.code !== 0) {
      exitCode = result.code === 130 ? 0 : result.code
      process.stderr.write(result.code === 130 ? 'MYTHOS：已中断当前任务。\n' : `MYTHOS：任务失败，退出码 ${String(result.code)}。\n`)
    }
    prompt()
  }
  input.close()
  return exitCode
}
