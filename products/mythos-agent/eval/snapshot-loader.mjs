import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path'

let root
let mutableRoots = []
let files = new Map()

export function initialize(data) {
  root = realpathSync(data.root)
  mutableRoots = data.mutableRoots.map(path => realpathSync(path))
  files = new Map(data.files.map(entry => [entry.path, entry]))
  if (files.size !== data.files.length) throw new Error('执行产物 manifest 包含重复路径')
}

function inside(parent, candidate) {
  const path = relative(parent, candidate)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

function verifiedEntry(url) {
  if (!url.startsWith('file:')) throw new Error('执行快照禁止非 file/node 模块协议')
  const path = realpathSync(fileURLToPath(url))
  if (!inside(root, path) || mutableRoots.some(mutable => inside(mutable, path))) {
    throw new Error('运行期模块位于已验证执行快照之外或可写输出目录')
  }
  const manifestPath = relative(root, path).split(sep).join('/')
  const entry = files.get(manifestPath)
  if (entry?.type !== 'file' || entry.sha256 === null) throw new Error('运行期模块未被 parent anchor 文件表承诺')
  return entry
}

function sourceBytes(source) {
  if (typeof source === 'string') return Buffer.from(source)
  if (Buffer.isBuffer(source)) return source
  if (ArrayBuffer.isView(source)) return Buffer.from(source.buffer, source.byteOffset, source.byteLength)
  if (source instanceof ArrayBuffer) return Buffer.from(source)
  throw new Error('模块 loader 未返回可绑定的 source bytes')
}

export function resolve(specifier, context, nextResolve) {
  let resolved
  try {
    resolved = nextResolve(specifier, context)
  } catch (error) {
    const missingPackage = error?.code === 'ERR_MODULE_NOT_FOUND'
      && !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('#')
      && !specifier.includes(':')
    if (!missingPackage) throw error
    const profile = pathToFileURL(resolvePath(
      root,
      'products/mythos-agent/home/profiles/mythos/cordis.yml',
    )).href
    resolved = nextResolve(specifier, { ...context, parentURL: profile })
  }
  if (!resolved.url.startsWith('node:')) verifiedEntry(resolved.url)
  return resolved
}

export function load(url, context, nextLoad) {
  if (url.startsWith('node:')) return nextLoad(url, context)
  const entry = verifiedEntry(url)
  const loaded = nextLoad(url, context)
  const bytes = sourceBytes(loaded.source)
  if (bytes.length !== entry.size || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
    throw new Error(`模块 ${entry.path} 的执行字节与 parent anchor 不一致`)
  }
  return loaded
}
