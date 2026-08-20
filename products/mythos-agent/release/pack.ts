import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { checkRelease } from './check.js'

const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(productRoot, '..', '..')

function archive(): Buffer {
  const tar = execFileSync('git', [
    'archive', '--format=tar', '--prefix=mythos-agent/', 'HEAD:products/mythos-agent',
  ], { cwd: repositoryRoot, maxBuffer: 64 * 1024 * 1024 })
  return gzipSync(tar, { level: 9 })
}

await checkRelease()
const manifest = JSON.parse(await readFile(join(productRoot, 'package.json'), 'utf8')) as { version: string }
const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()
const first = archive()
const second = archive()
if (!first.equals(second)) throw new Error('Mythos 发布包不是确定性产物')

const outputRoot = join(productRoot, 'dist')
const filename = `mythos-agent-${manifest.version}+${commit}.tar.gz`
const output = join(outputRoot, filename)
const digest = createHash('sha256').update(first).digest('hex')
await mkdir(outputRoot, { recursive: true })
await writeFile(output, first, { mode: 0o644 })
await writeFile(`${output}.sha256`, `${digest}  ${filename}\n`, { mode: 0o644 })

const entries = execFileSync('tar', ['-tzf', output], { encoding: 'utf8' }).trim().split('\n')
const forbidden = entries.filter(entry => /(?:^|\/)(?:\.env(?:\.|$)|runs|sessions|flywheel\/data)(?:\/|$)/u.test(entry))
if (forbidden.length > 0) throw new Error(`发布包包含运行数据：${forbidden.join(', ')}`)
for (const required of [
  'mythos-agent/product/launch.ts',
  'mythos-agent/home/profiles/mythos/cordis.patch.yml',
  'mythos-agent/home/profiles/mythos-web/cordis.patch.yml',
  'mythos-agent/home/.agent-presets/mythos/agent.cordis.yml',
]) {
  if (!entries.includes(required)) throw new Error(`发布包缺少 ${required}`)
}

process.stdout.write(`Mythos release pack: ${output}\nSHA-256: ${digest}\n`)
