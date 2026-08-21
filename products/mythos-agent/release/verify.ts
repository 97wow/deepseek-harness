import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function run(script: string): void {
  const result = spawnSync('pnpm', ['--dir', productRoot, script], { stdio: 'inherit', env: process.env })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`pnpm ${script} 失败，退出码 ${String(result.status)}`)
}

for (const script of [
  'test',
  'typecheck',
  'smoke:web',
  'flywheel:build',
  'flywheel:analyze',
  'gate',
  'gate:comprehensive',
  'release:check',
]) run(script)
process.stdout.write('Mythos release verify: 全部门禁通过\n')
