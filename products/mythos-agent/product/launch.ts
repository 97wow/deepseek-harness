import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export type MythosSurface = 'headless' | 'web'

export interface LaunchSpec {
  args: string[]
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
}

const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(productRoot, '..', '..')
const defaultBaseUrl = 'https://d.llmapi.pro:99'

function validatedBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new Error('DEEPSEEK_BASE_URL 必须是无内嵌凭据的 HTTPS URL')
  }
  return url.toString().replace(/\/$/, '')
}

function hasOption(args: readonly string[], option: string): boolean {
  return args.some(value => value === option || value.startsWith(`${option}=`))
}

export function createLaunchSpec(
  surface: MythosSurface,
  inputArgs: readonly string[],
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
): LaunchSpec {
  const cli = join(repositoryRoot, 'apps', 'cli', 'lib', 'bin.js')
  const environment = {
    ...sourceEnvironment,
    DEEPSEEK_BASE_URL: validatedBaseUrl(sourceEnvironment.DEEPSEEK_BASE_URL ?? defaultBaseUrl),
    DSH_HOME: join(productRoot, 'home'),
    DSH_TELEMETRY_DISABLED: '1',
  }

  if (surface === 'headless') {
    if (inputArgs.length === 0) throw new Error('Headless 模式需要提供任务内容')
    return {
      args: [cli, '--profile', 'mythos', ...inputArgs],
      command: process.execPath,
      cwd: repositoryRoot,
      env: environment,
    }
  }

  const openBrowser = inputArgs[0] === '--open'
  const args = openBrowser ? inputArgs.slice(1) : [...inputArgs]
  const webArgs = [cli, '--profile', 'mythos-web']
  if (!hasOption(args, '--host')) webArgs.push('--host', '127.0.0.1')
  if (!hasOption(args, '--port')) webArgs.push('--port', '33180')
  if (!openBrowser && !hasOption(args, '--no-open')) webArgs.push('--no-open')
  webArgs.push(...args)
  return { args: webArgs, command: process.execPath, cwd: repositoryRoot, env: environment }
}

export async function launch(surface: MythosSurface, args: readonly string[]): Promise<number> {
  const spec = createLaunchSpec(surface, args)
  const cli = spec.args[0]
  if (cli === undefined) throw new Error('Mythos 启动器缺少 DSH CLI 路径')
  await access(cli)
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: 'inherit' })
  const forwardInterrupt = (): void => { child.kill('SIGINT') }
  const forwardTerminate = (): void => { child.kill('SIGTERM') }
  process.once('SIGINT', forwardInterrupt)
  process.once('SIGTERM', forwardTerminate)
  try {
    return await new Promise<number>((resolveExit, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolveExit(code ?? (signal === 'SIGINT' ? 130 : 1)))
    })
  } finally {
    process.off('SIGINT', forwardInterrupt)
    process.off('SIGTERM', forwardTerminate)
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const surface = process.argv[2]
  if (surface !== 'headless' && surface !== 'web') throw new Error('用法：launch.ts <headless|web> [...args]')
  process.exitCode = await launch(surface, process.argv.slice(3))
}
