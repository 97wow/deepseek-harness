import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { activeConfigRoot, checkHotConfig, CONFIG_FILES, verifyManifest } from '../src/hot-config.mjs'

function response(bytes) {
  return {
    ok: true,
    headers: { get: () => String(bytes.length) },
    arrayBuffer: async () => bytes,
  }
}

test('accepts a signed, complete config release and activates it atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mythos-hot-config-'))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicDer = publicKey.export({ format: 'der', type: 'spki' })
  const assets = new Map()
  const files = Object.entries(CONFIG_FILES).map(([path, asset]) => {
    const bytes = Buffer.from(`fixture:${path}\n`)
    assets.set(`https://updates.test/files/${asset}`, bytes)
    return { asset, path, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
  })
  const manifestBytes = Buffer.from(JSON.stringify({ schema: 1, revision: 7, files }))
  const signatureBytes = sign(null, manifestBytes, privateKey)
  const remote = new Map([
    ['https://updates.test/manifest.json', manifestBytes],
    ['https://updates.test/manifest.json.sig', signatureBytes],
    ...assets,
  ])
  const fetchImplementation = async url => {
    const bytes = remote.get(String(url))
    if (bytes === undefined) return { ok: false }
    return response(bytes)
  }
  try {
    const result = await checkHotConfig(root, [{
      assetBaseUrl: 'https://updates.test/files/',
      manifestUrl: 'https://updates.test/manifest.json',
      signatureUrl: 'https://updates.test/manifest.json.sig',
    }], fetchImplementation, publicDer)
    assert.equal(result.updated, true)
    assert.equal(result.revision, 7)
    const active = await activeConfigRoot(root)
    assert.equal(active, result.releaseRoot)
    assert.equal(await readFile(join(active, 'desktop/service-routing.json'), 'utf8'), 'fixture:desktop/service-routing.json\n')
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('rejects an altered manifest before parsing remote file paths', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const manifest = Buffer.from('{"schema":1,"revision":1,"files":[]}')
  const signature = sign(null, manifest, privateKey)
  const altered = Buffer.from('{"schema":1,"revision":2,"files":[]}')
  const publicDer = publicKey.export({ format: 'der', type: 'spki' })
  assert.throws(() => verifyManifest(altered, signature, publicDer), /签名/u)
})
