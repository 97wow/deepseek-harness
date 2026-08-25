import { createHash, createPrivateKey, sign } from 'node:crypto'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG_FILES } from '../src/hot-config.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(here, '..', '..', '..')
const productHome = join(repositoryRoot, 'products', 'mythos-agent', 'home')
const outputRoot = join(repositoryRoot, 'apps', 'desktop', 'dist', 'config-update')
const revision = Number(process.env.MYTHOS_CONFIG_REVISION)
const keyPath = process.env.MYTHOS_CONFIG_SIGNING_KEY

if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('MYTHOS_CONFIG_REVISION 必须是正整数')
if (keyPath === undefined || keyPath === '') throw new Error('MYTHOS_CONFIG_SIGNING_KEY 必须指向 Ed25519 私钥')

await mkdir(outputRoot, { recursive: true })
const files = []
for (const [path, asset] of Object.entries(CONFIG_FILES)) {
  const source = join(productHome, path)
  const bytes = await readFile(source)
  files.push({ asset, path, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length })
  await cp(source, join(outputRoot, asset))
}

const manifest = Buffer.from(`${JSON.stringify({ schema: 1, revision, files })}\n`)
const privateKey = createPrivateKey(await readFile(keyPath))
const signature = sign(null, manifest, privateKey)
await Promise.all([
  writeFile(join(outputRoot, 'manifest.json'), manifest),
  writeFile(join(outputRoot, 'manifest.json.sig'), signature),
  writeFile(join(outputRoot, 'mythos-config-manifest.json'), manifest),
  writeFile(join(outputRoot, 'mythos-config-manifest.json.sig'), signature),
])
process.stdout.write(`MYTHOS hot config: revision ${String(revision)} -> ${outputRoot}\n`)
