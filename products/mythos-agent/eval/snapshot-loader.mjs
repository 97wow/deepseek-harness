import { realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isAbsolute, relative, sep } from 'node:path'

let root
let mutableRoots = []

export function initialize(data) {
  root = data.root
  mutableRoots = data.mutableRoots
}

function inside(parent, candidate) {
  const path = relative(parent, candidate)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context)
  if (resolved.url.startsWith('node:')) return resolved
  if (!resolved.url.startsWith('file:')) throw new Error('执行快照禁止非 file/node 模块协议')
  const path = await realpath(fileURLToPath(resolved.url))
  if (!inside(root, path) || mutableRoots.some(mutable => inside(mutable, path))) {
    throw new Error('运行期模块位于已验证执行快照之外或可写输出目录')
  }
  return resolved
}
