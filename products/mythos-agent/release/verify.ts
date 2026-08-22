import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyPackedConsumer } from './consumer.js'
import { packRelease } from './pack.js'

const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function run(script: string): void {
  const result = spawnSync('npm', ['--prefix', productRoot, 'run', script], { stdio: 'inherit', env: process.env })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`npm run ${script} 失败，退出码 ${String(result.status)}`)
}

function runReleaseTypecheck(): void {
  const result = spawnSync('tsc', [
    '--ignoreConfig', '--noEmit', '--target', 'ES2023', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', '--types', 'node',
    'product/launch.ts', 'release/bundle.ts', 'release/check.ts', 'release/consumer.ts',
    'release/pack.ts', 'release/security.ts', 'release/verify.ts',
  ], { cwd: productRoot, stdio: 'inherit', env: process.env })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`release typecheck 失败，退出码 ${String(result.status)}`)
}

for (const script of [
  'test',
  'typecheck',
  'typecheck:control',
  'smoke:web',
  'flywheel:build',
  'flywheel:analyze',
  'gate',
  'gate:comprehensive',
  'gate:journey',
  'gate:advanced-journey',
  'gate:real-repo-scope',
  'release:check',
]) run(script)
runReleaseTypecheck()
const packed = await packRelease()
await verifyPackedConsumer(packed.archive, packed.digestFile)
process.stdout.write('Mythos release verify: 全部门禁通过\n')
