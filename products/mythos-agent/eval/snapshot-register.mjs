import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { resolve } from 'node:path'

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`缺少 parent anchor：${name}`)
  return value
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

const expectedArtifactSha256 = required('MYTHOS_EVAL_EXPECTED_ARTIFACT_SHA256')
const expectedGitCommit = required('MYTHOS_EVAL_EXPECTED_GIT_COMMIT')
const expectedGitTree = required('MYTHOS_EVAL_EXPECTED_GIT_TREE')
const manifest = JSON.parse(await readFile(required('MYTHOS_EVAL_ARTIFACT_MANIFEST'), 'utf8'))
const identity = { build: manifest.build, files: manifest.files, mutableRoots: manifest.mutableRoots, source: manifest.source }
const manifestDigest = createHash('sha256').update(canonical(identity)).digest('hex')
if (manifest.algorithm !== 'execution-artifact-sha256-v1' || manifest.sha256 !== expectedArtifactSha256
  || manifestDigest !== expectedArtifactSha256 || manifest.source?.gitCommit !== expectedGitCommit
  || manifest.source?.gitTree !== expectedGitTree || !Array.isArray(manifest.files)) {
  throw new Error('bootstrap manifest 与 parent anchor 不一致')
}

const loaderUrl = required('MYTHOS_EVAL_LOADER_DATA_URL')
const loaderMatch = /^data:text\/javascript;base64,([A-Za-z0-9+/=]+)$/.exec(loaderUrl)
if (loaderMatch === null) throw new Error('snapshot loader 不是受控 data URL')
const loaderBytes = Buffer.from(loaderMatch[1], 'base64')
if (createHash('sha256').update(loaderBytes).digest('hex') !== required('MYTHOS_EVAL_EXPECTED_LOADER_SHA256')) {
  throw new Error('snapshot loader 与 parent anchor 不一致')
}

const root = await realpath(required('MYTHOS_EVAL_ARTIFACT_ROOT'))
const mutableRoots = await Promise.all(manifest.mutableRoots.map(path => realpath(resolve(root, path))))
const hooks = await import(loaderUrl)
hooks.initialize({ files: manifest.files, mutableRoots, root })
registerHooks({ load: hooks.load, resolve: hooks.resolve })
