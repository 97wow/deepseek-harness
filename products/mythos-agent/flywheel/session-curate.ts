import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLatestServerDataset } from './server-dataset.js'
import {
  buildProductSessionRegistry,
  curateProductSessions,
  evaluateCurationGate,
  registrySha256,
  summarizeCuration,
} from './session-curation.js'

const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = join(productRoot, 'flywheel', 'data')
const registry = await buildProductSessionRegistry({
  productRoot,
  runsRoot: join(productRoot, 'runs'),
  sessionsRoot: join(productRoot, 'home', 'sessions'),
})
const server = await loadLatestServerDataset(dataRoot)
const curated = curateProductSessions(server.rows, registry)
const summary = summarizeCuration(curated, registry.length)
const gate = evaluateCurationGate(summary)
const registryHash = registrySha256(registry)
const serverHash = server.health.artifact.sha256
const outputRoot = join(dataRoot, 'curated', serverHash, registryHash)
await mkdir(outputRoot, { recursive: true, mode: 0o700 })

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, content, { mode: 0o600 })
  await rename(temporary, path)
}

await atomicWrite(join(outputRoot, 'registry.json'), `${JSON.stringify(registry, null, 2)}\n`)
await atomicWrite(
  join(outputRoot, 'candidates.jsonl'),
  curated.map(candidate => JSON.stringify(candidate)).join('\n') + (curated.length ? '\n' : ''),
)
const manifest = {
  generatedAt: new Date().toISOString(),
  gate,
  registrySha256: registryHash,
  serverDatasetSha256: serverHash,
  summary,
}
await atomicWrite(join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
await mkdir(join(dataRoot, 'curated'), { recursive: true, mode: 0o700 })
await atomicWrite(join(dataRoot, 'curated', 'latest.json'), `${JSON.stringify({
  candidates: join(serverHash, registryHash, 'candidates.jsonl'),
  manifest: join(serverHash, registryHash, 'manifest.json'),
  registry: join(serverHash, registryHash, 'registry.json'),
}, null, 2)}\n`)

process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
if (!gate.passed) process.exitCode = 1
