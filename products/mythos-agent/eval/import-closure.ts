import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { preProcessFile } from 'typescript'

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function importCandidates(path: string): string[] {
  const extension = extname(path)
  if (extension === '.js') return [`${path.slice(0, -3)}.ts`, path]
  if (extension === '.mjs') return [`${path.slice(0, -4)}.mts`, path]
  if (extension === '.cjs') return [`${path.slice(0, -4)}.cts`, path]
  if (extension !== '') return [path]
  return [`${path}.ts`, `${path}.tsx`, `${path}.mts`, `${path}.cts`, resolve(path, 'index.ts'), resolve(path, 'index.tsx')]
}

function repositoryPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

async function resolveRelativeImport(
  root: string,
  importer: string,
  specifier: string,
  allowedFiles?: ReadonlySet<string>,
): Promise<string> {
  const unresolved = resolve(dirname(importer), specifier)
  for (const candidate of importCandidates(unresolved)) {
    if (!isInside(root, candidate)) throw new Error('相对 import 逃逸产品目录')
    if (allowedFiles !== undefined && !allowedFiles.has(repositoryPath(root, candidate))) continue
    try {
      const information = await lstat(candidate)
      if (!information.isFile()) continue
      const canonical = await realpath(candidate)
      if (!isInside(root, canonical)) throw new Error('相对 import 通过符号链接逃逸产品目录')
      return canonical
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  throw new Error('无法解析本仓库相对 import')
}

/** 静态收集入口文件及其本仓库相对 import 闭包，不加载或执行模块。 */
export async function collectRelativeImportClosure(
  productRoot: string,
  roots: readonly string[],
  allowedFiles?: ReadonlySet<string>,
): Promise<string[]> {
  const canonicalRoot = await realpath(productRoot)
  const pending: string[] = []
  for (const root of roots) {
    if (isAbsolute(root)) throw new Error('import 闭包根必须是产品内相对路径')
    if (allowedFiles !== undefined && !allowedFiles.has(root)) throw new Error('import 闭包根不是 tracked 文件')
    const candidate = await realpath(resolve(canonicalRoot, root))
    if (!isInside(canonicalRoot, candidate)) throw new Error('import 闭包根逃逸产品目录')
    pending.push(candidate)
  }
  const visited = new Set<string>()
  while (pending.length > 0) {
    const current = pending.pop()!
    if (visited.has(current)) continue
    visited.add(current)
    const source = await readFile(current, 'utf8')
    const imports = preProcessFile(source, true, true).importedFiles.map(file => file.fileName)
    for (const specifier of imports) {
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue
      pending.push(await resolveRelativeImport(canonicalRoot, current, specifier, allowedFiles))
    }
  }
  return [...visited]
    .map(path => relative(canonicalRoot, path).split(sep).join('/'))
    .sort()
}
