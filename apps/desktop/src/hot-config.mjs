import { createHash, createPublicKey, verify } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const MANIFEST_LIMIT = 64 * 1024
const SIGNATURE_LIMIT = 1024
const FILE_LIMIT = 256 * 1024
const TOTAL_LIMIT = 1024 * 1024

export const CONFIG_FILES = Object.freeze({
  '.agent-presets/mythos/agent.cordis.yml': 'agent-cordis.yml',
  '.agent-presets/mythos/preset.yml': 'preset.yml',
  'desktop/service-routing.json': 'service-routing.json',
  'profiles/mythos/cordis.patch.yml': 'mythos-cordis.patch.yml',
  'profiles/mythos-web/cordis.patch.yml': 'mythos-web-cordis.patch.yml',
})

export const CONFIG_PUBLIC_KEY_DER = 'MCowBQYDK2VwAyEAGh8tcRMdMgcdUcW61wJWeVNJnfv2BAISTzm4VPdKjZQ='

function manifestValue(bytes) {
  const parsed = JSON.parse(bytes.toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('配置清单无效')
  if (parsed.schema !== 1 || !Number.isSafeInteger(parsed.revision) || parsed.revision < 1) throw new Error('配置版本无效')
  if (!Array.isArray(parsed.files) || parsed.files.length !== Object.keys(CONFIG_FILES).length) throw new Error('配置文件集不完整')
  let total = 0
  const seen = new Set()
  for (const file of parsed.files) {
    if (file === null || typeof file !== 'object' || Array.isArray(file)) throw new Error('配置文件记录无效')
    if (typeof file.path !== 'string' || CONFIG_FILES[file.path] !== file.asset || seen.has(file.path)) {
      throw new Error('配置文件不在白名单')
    }
    if (!/^[a-f0-9]{64}$/u.test(file.sha256)) throw new Error('配置文件哈希无效')
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > FILE_LIMIT) throw new Error('配置文件大小无效')
    seen.add(file.path)
    total += file.size
  }
  if (total > TOTAL_LIMIT) throw new Error('配置包过大')
  return parsed
}

async function fetchBytes(url, limit, fetchImplementation) {
  const response = await fetchImplementation(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error('配置源不可用')
  const declared = Number(response.headers?.get?.('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > limit) throw new Error('远程配置超过大小限制')
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0 || bytes.length > limit) throw new Error('远程配置超过大小限制')
  return bytes
}

export function verifyManifest(manifestBytes, signatureBytes, publicKeyDer = CONFIG_PUBLIC_KEY_DER) {
  if (manifestBytes.length > MANIFEST_LIMIT || signatureBytes.length > SIGNATURE_LIMIT) throw new Error('配置签名材料过大')
  const key = typeof publicKeyDer === 'string' ? Buffer.from(publicKeyDer, 'base64') : publicKeyDer
  const publicKey = createPublicKey({ key, format: 'der', type: 'spki' })
  if (!verify(null, manifestBytes, publicKey, signatureBytes)) throw new Error('配置签名无效')
  return manifestValue(manifestBytes)
}

async function activeRevision(cacheRoot) {
  try {
    const value = JSON.parse(await readFile(join(cacheRoot, 'active.json'), 'utf8'))
    return Number.isSafeInteger(value.revision) && value.revision >= 1 ? value.revision : 0
  } catch {
    return 0
  }
}

async function verifyRelease(releaseRoot) {
  const manifest = manifestValue(await readFile(join(releaseRoot, 'manifest.json')))
  for (const file of manifest.files) {
    const bytes = await readFile(join(releaseRoot, file.path))
    if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw new Error('缓存配置校验失败')
    }
  }
  return manifest
}

export async function activeConfigRoot(cacheRoot) {
  const revision = await activeRevision(cacheRoot)
  if (revision === 0) return undefined
  const releaseRoot = join(cacheRoot, 'releases', String(revision))
  try {
    await verifyRelease(releaseRoot)
    return releaseRoot
  } catch {
    return undefined
  }
}

async function stageRelease(cacheRoot, source, manifestBytes, manifest, fetchImplementation) {
  await mkdir(cacheRoot, { recursive: true })
  const staging = await mkdtemp(join(cacheRoot, 'staging-'))
  try {
    for (const file of manifest.files) {
      const bytes = await fetchBytes(new URL(file.asset, source.assetBaseUrl), FILE_LIMIT, fetchImplementation)
      if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
        throw new Error('下载配置校验失败')
      }
      const destination = join(staging, file.path)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, bytes, { mode: 0o644 })
    }
    await writeFile(join(staging, 'manifest.json'), manifestBytes, { mode: 0o644 })
    const releaseRoot = join(cacheRoot, 'releases', String(manifest.revision))
    await mkdir(dirname(releaseRoot), { recursive: true })
    await rename(staging, releaseRoot)
    await verifyRelease(releaseRoot)
    const pointer = join(cacheRoot, `active-${String(process.pid)}.tmp`)
    await writeFile(pointer, `${JSON.stringify({ revision: manifest.revision })}\n`, { mode: 0o600 })
    await rename(pointer, join(cacheRoot, 'active.json'))
    return releaseRoot
  } finally {
    await rm(staging, { force: true, recursive: true })
  }
}

export async function checkHotConfig(cacheRoot, sources, fetchImplementation = fetch, publicKeyDer = CONFIG_PUBLIC_KEY_DER) {
  const current = await activeRevision(cacheRoot)
  for (const source of sources) {
    try {
      const [manifestBytes, signatureBytes] = await Promise.all([
        fetchBytes(source.manifestUrl, MANIFEST_LIMIT, fetchImplementation),
        fetchBytes(source.signatureUrl, SIGNATURE_LIMIT, fetchImplementation),
      ])
      const manifest = verifyManifest(manifestBytes, signatureBytes, publicKeyDer)
      if (manifest.revision <= current) return { revision: current, updated: false }
      const releaseRoot = await stageRelease(cacheRoot, source, manifestBytes, manifest, fetchImplementation)
      return { releaseRoot, revision: manifest.revision, updated: true }
    } catch {
      // A source is an availability fallback, never a relaxation of validation.
    }
  }
  return { revision: current, updated: false }
}
