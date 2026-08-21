import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isStringLiteralLike,
  isVariableDeclaration,
  preProcessFile,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  type CallExpression,
} from 'typescript'

export interface ImportClosureOptions {
  allowedDynamicLoaders?: ReadonlySet<string>
  allowedFiles?: ReadonlySet<string>
}

export interface ImportClosureResult {
  dynamicLoaders: string[]
  files: string[]
}

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
  return []
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

function moduleLoadArgument(call: CallExpression, loaderNames: ReadonlySet<string>): { argument: string | null; moduleLoad: boolean } {
  const expression = call.expression
  const moduleLoad = expression.kind === SyntaxKind.ImportKeyword
    || (isIdentifier(expression) && loaderNames.has(expression.text))
    || (isPropertyAccessExpression(expression)
      && ((isIdentifier(expression.expression) && loaderNames.has(expression.expression.text) && expression.name.text === 'resolve')
        || expression.name.text === 'require'))
    || (isElementAccessExpression(expression) && isIdentifier(expression.expression)
      && loaderNames.has(expression.expression.text) && isStringLiteralLike(expression.argumentExpression)
      && expression.argumentExpression.text === 'resolve')
  if (!moduleLoad) return { argument: null, moduleLoad: false }
  const argument = call.arguments.length === 1 && isStringLiteralLike(call.arguments[0]!) ? call.arguments[0]!.text : null
  return { argument, moduleLoad: true }
}

function analyzeModuleLoads(source: string): { dynamic: boolean; relativeSpecifiers: string[] } {
  const file = createSourceFile('commitment.ts', source, ScriptTarget.Latest, true, ScriptKind.TS)
  const loaderNames = new Set(['require'])
  let discoveredAlias = true
  while (discoveredAlias) {
    discoveredAlias = false
    const discover = (node: import('typescript').Node): void => {
      if (isVariableDeclaration(node) && isIdentifier(node.name) && node.initializer !== undefined) {
        const initializer = node.initializer
        const aliasesLoader = (isIdentifier(initializer) && loaderNames.has(initializer.text))
          || (isPropertyAccessExpression(initializer) && isIdentifier(initializer.expression)
            && loaderNames.has(initializer.expression.text) && initializer.name.text === 'resolve')
          || (isCallExpression(initializer) && isIdentifier(initializer.expression) && initializer.expression.text === 'createRequire')
        if (aliasesLoader && !loaderNames.has(node.name.text)) {
          loaderNames.add(node.name.text)
          discoveredAlias = true
        }
      }
      forEachChild(node, discover)
    }
    discover(file)
  }
  const relativeSpecifiers = new Set<string>()
  let dynamic = false
  const visit = (node: import('typescript').Node): void => {
    if (isCallExpression(node)) {
      const load = moduleLoadArgument(node, loaderNames)
      if (load.moduleLoad) {
        if (load.argument === null) dynamic = true
        else if (load.argument.startsWith('./') || load.argument.startsWith('../')) relativeSpecifiers.add(load.argument)
        else dynamic = true
      }
    }
    forEachChild(node, visit)
  }
  visit(file)
  return { dynamic, relativeSpecifiers: [...relativeSpecifiers] }
}

/** 静态收集入口文件及其本仓库相对 import 闭包，不加载或执行模块。 */
export async function collectRelativeImportClosure(
  workspaceRoot: string,
  roots: readonly string[],
  options: ImportClosureOptions = {},
): Promise<ImportClosureResult> {
  const canonicalRoot = await realpath(workspaceRoot)
  const pending: string[] = []
  for (const root of roots) {
    if (isAbsolute(root)) throw new Error('import 闭包根必须是产品内相对路径')
    if (options.allowedFiles !== undefined && !options.allowedFiles.has(root)) throw new Error('import 闭包根不是 tracked 文件')
    const unresolved = resolve(canonicalRoot, root)
    const information = await lstat(unresolved)
    if (!information.isFile()) throw new Error('import 闭包根必须是非符号链接普通文件')
    const candidate = await realpath(unresolved)
    if (!isInside(canonicalRoot, candidate)) throw new Error('import 闭包根逃逸产品目录')
    pending.push(candidate)
  }
  const visited = new Set<string>()
  const dynamicLoaders = new Set<string>()
  while (pending.length > 0) {
    const current = pending.pop()!
    if (visited.has(current)) continue
    visited.add(current)
    const source = await readFile(current, 'utf8')
    const analysis = analyzeModuleLoads(source)
    const currentPath = repositoryPath(canonicalRoot, current)
    if (analysis.dynamic) {
      if (!options.allowedDynamicLoaders?.has(currentPath)) throw new Error('检测到未声明的动态模块加载')
      dynamicLoaders.add(currentPath)
    }
    const imports = new Set([
      ...preProcessFile(source, true, true).importedFiles.map(file => file.fileName),
      ...analysis.relativeSpecifiers,
    ])
    for (const specifier of imports) {
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue
      pending.push(await resolveRelativeImport(canonicalRoot, current, specifier, options.allowedFiles))
    }
  }
  for (const loader of options.allowedDynamicLoaders ?? []) {
    if (!dynamicLoaders.has(loader)) throw new Error('声明的动态模块加载器没有真实动态加载点')
  }
  return {
    dynamicLoaders: [...dynamicLoaders].sort(),
    files: [...visited].map(path => repositoryPath(canonicalRoot, path)).sort(),
  }
}
