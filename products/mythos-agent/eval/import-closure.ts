import { builtinModules } from 'node:module'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import {
  createSourceFile,
  forEachChild,
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isNamedExports,
  isNamedImports,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isStringLiteral,
  isVariableDeclaration,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
} from 'typescript'

export interface ImportClosureOptions {
  allowedFiles?: ReadonlySet<string>
  controlPathPrefix: string
  expectedDynamicImports?: ReadonlyMap<string, readonly string[]>
  requiredDirectBareImports?: ReadonlyMap<string, ReadonlySet<string>>
  selectedDynamicImports?: ReadonlyMap<string, ReadonlySet<string>>
}

export interface ImportClosureResult {
  files: string[]
  workspacePackages: string[]
}

interface PackageManifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  exports?: Record<string, unknown>
  main?: string
  name?: string
  peerDependencies?: Record<string, string>
}

interface WorkspacePackage {
  directory: string
  manifest: PackageManifest
  manifestPath: string
}

const bannedLoaderIdentifiers = new Set([
  'Function', 'constructor', 'createRequire', 'eval', 'global', 'globalThis', 'module', 'prototype', 'require',
  'self', 'window',
])
const bannedLoaderProperties = new Set([
  'Function', 'constructor', 'createRequire', 'eval', 'module', 'prototype', 'require',
])
const builtins = new Set([...builtinModules, ...builtinModules.map(name => 'node:' + name)])
const sourceExtensions = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'])

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith('..' + sep) && path !== '..' && !isAbsolute(path))
}

function repositoryPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

function importCandidates(path: string): string[] {
  const extension = extname(path)
  if (extension === '.js') return [path.slice(0, -3) + '.ts', path]
  if (extension === '.mjs') return [path.slice(0, -4) + '.mts', path]
  if (extension === '.cjs') return [path.slice(0, -4) + '.cts', path]
  return extension === '' ? [] : [path]
}

async function trackedOrdinaryFile(
  root: string,
  path: string,
  allowedFiles: ReadonlySet<string> | undefined,
): Promise<string> {
  if (allowedFiles !== undefined && !allowedFiles.has(path)) throw new Error(`静态模块图文件不是 tracked 文件：${path}`)
  const unresolved = resolve(root, path)
  if (!isInside(root, unresolved)) throw new Error('静态模块图文件逃逸 workspace')
  const information = await lstat(unresolved)
  if (!information.isFile()) throw new Error('静态模块图仅接受非符号链接普通文件')
  const canonical = await realpath(unresolved)
  if (!isInside(root, canonical)) throw new Error('静态模块图文件通过符号链接逃逸 workspace')
  return canonical
}

async function resolveRelativeImport(
  root: string,
  importer: string,
  specifier: string,
  allowedFiles?: ReadonlySet<string>,
): Promise<string> {
  const unresolved = resolve(dirname(importer), specifier)
  for (const candidate of importCandidates(unresolved)) {
    if (!isInside(root, candidate)) throw new Error('相对 import 逃逸 workspace')
    const path = repositoryPath(root, candidate)
    if (allowedFiles !== undefined && !allowedFiles.has(path)) continue
    try {
      return await trackedOrdinaryFile(root, path, allowedFiles)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  throw new Error('无法解析本仓库相对 import')
}

function workspacePatternMatches(directory: string, pattern: string): boolean {
  const directoryParts = directory.split('/')
  const patternParts = pattern.replace(/^\.\//u, '').split('/')
  return directoryParts.length === patternParts.length
    && patternParts.every((part, index) => part === '*' || part === directoryParts[index])
}

async function loadWorkspacePackages(
  root: string,
  allowedFiles: ReadonlySet<string> | undefined,
): Promise<{ files: Set<string>; packages: Map<string, WorkspacePackage> }> {
  const workspacePath = 'pnpm-workspace.yaml'
  const workspace = loadYaml((await readFile(await trackedOrdinaryFile(root, workspacePath, allowedFiles), 'utf8'))) as {
    packages?: unknown
  }
  const patterns = workspace.packages
  if (!Array.isArray(patterns) || !patterns.every(pattern => typeof pattern === 'string')) {
    throw new Error('pnpm workspace packages 配置无效')
  }
  if (allowedFiles === undefined) throw new Error('workspace package 解析必须提供 tracked manifest')
  const manifestPaths = [...allowedFiles]
    .filter(path => path.endsWith('/package.json')
      && patterns.some(pattern => workspacePatternMatches(dirname(path).split(sep).join('/'), pattern)))
    .sort()
  const packages = new Map<string, WorkspacePackage>()
  const files = new Set(['apps/cli/package.json', 'package.json', 'pnpm-lock.yaml', workspacePath, ...manifestPaths])
  for (const manifestPath of manifestPaths) {
    const manifest = JSON.parse(await readFile(await trackedOrdinaryFile(root, manifestPath, allowedFiles), 'utf8')) as PackageManifest
    if (typeof manifest.name !== 'string' || manifest.name === '') throw new Error('workspace package manifest 缺少名称')
    if (packages.has(manifest.name)) throw new Error('workspace package 名称重复')
    packages.set(manifest.name, { directory: dirname(manifestPath).split(sep).join('/'), manifest, manifestPath })
  }
  for (const path of files) await trackedOrdinaryFile(root, path, allowedFiles)
  return { files, packages }
}

function packageName(specifier: string): { name: string; subpath: string } {
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) {
    if (parts.length < 2) throw new Error('bare package specifier 无效')
    return { name: parts.slice(0, 2).join('/'), subpath: parts.slice(2).join('/') }
  }
  return { name: parts[0]!, subpath: parts.slice(1).join('/') }
}

function exportTarget(manifest: PackageManifest, subpath: string): string | null {
  const key = subpath === '' ? '.' : './' + subpath
  let value = manifest.exports?.[key]
  if (value === undefined) {
    for (const [pattern, target] of Object.entries(manifest.exports ?? {})) {
      if (!pattern.endsWith('*') || typeof target !== 'string' || !target.includes('*')) continue
      const prefix = pattern.slice(0, -1)
      if (key.startsWith(prefix)) value = target.replace('*', key.slice(prefix.length))
    }
  }
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    const conditions = value as { default?: unknown; import?: unknown }
    if (typeof conditions.import === 'string') return conditions.import
    if (typeof conditions.default === 'string') return conditions.default
  }
  return subpath === '' && typeof manifest.main === 'string' ? manifest.main : null
}

function sourceEntryForPackage(pkg: WorkspacePackage, subpath: string): string {
  const target = exportTarget(pkg.manifest, subpath)
  if (target === null) throw new Error('workspace bare import 缺少固定 exports 入口')
  const normalized = target.startsWith('./') ? target.slice(2) : target
  if (normalized.startsWith('src/') && sourceExtensions.has(extname(normalized))) {
    return pkg.directory + '/' + normalized
  }
  const builtExtension = extname(normalized)
  if (!normalized.startsWith('lib/') || !['.cjs', '.js', '.mjs'].includes(builtExtension)) {
    throw new Error(`workspace exports 无法映射到固定源码入口：${pkg.manifest.name ?? 'unknown'}`)
  }
  const sourceRelative = normalized.startsWith('lib/types/')
    ? normalized.slice('lib/types/'.length, -builtExtension.length)
    : normalized.slice('lib/'.length, -builtExtension.length)
  return pkg.directory + '/src/' + sourceRelative + '.ts'
}

function manifestDeclares(manifest: PackageManifest, dependency: string): boolean {
  return Object.hasOwn(manifest.dependencies ?? {}, dependency)
    || Object.hasOwn(manifest.devDependencies ?? {}, dependency)
    || Object.hasOwn(manifest.peerDependencies ?? {}, dependency)
}

interface SourceImports {
  directBareImports: Set<string>
  dynamicImports: string[]
  staticImports: Set<string>
}

function isRuntimeImport(node: import('typescript').ImportDeclaration): boolean {
  const clause = node.importClause
  if (clause === undefined) return true
  if (clause.isTypeOnly) return false
  if (clause.name !== undefined) return true
  if (clause.namedBindings === undefined || !isNamedImports(clause.namedBindings)) return true
  return clause.namedBindings.elements.some(element => !element.isTypeOnly)
}

function isRuntimeExport(node: import('typescript').ExportDeclaration): boolean {
  if (node.isTypeOnly) return false
  if (node.exportClause === undefined || !isNamedExports(node.exportClause)) return true
  return node.exportClause.elements.some(element => !element.isTypeOnly)
}

function foldedString(node: import('typescript').Expression): string | null {
  if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) return node.text
  if (isParenthesizedExpression(node)) return foldedString(node.expression)
  if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.PlusToken) {
    const left = foldedString(node.left)
    const right = foldedString(node.right)
    return left === null || right === null ? null : left + right
  }
  return null
}

function analyzeSourceImports(source: string, sourcePath: string): SourceImports {
  const file = createSourceFile('eval-control.ts', source, ScriptTarget.Latest, true, ScriptKind.TS)
  const diagnostics = (file as typeof file & { parseDiagnostics?: readonly unknown[] }).parseDiagnostics ?? []
  if (diagnostics.length > 0) throw new Error('静态模块图源码无法安全解析')
  const directBareImports = new Set<string>()
  const dynamicImports: string[] = []
  const staticImports = new Set<string>()
  const visit = (node: import('typescript').Node): void => {
    if (isIdentifier(node) && bannedLoaderIdentifiers.has(node.text)) {
      throw new Error(`committed closure 出现禁用 loader 标识：${sourcePath}:${node.text}`)
    }
    if (node.kind === SyntaxKind.ThisKeyword) {
      throw new Error(`committed closure 出现禁用动态全局入口：${sourcePath}:this`)
    }
    if (isPropertyAccessExpression(node) && bannedLoaderProperties.has(node.name.text)) {
      throw new Error(`committed closure 出现禁用 loader 属性：${sourcePath}:${node.name.text}`)
    }
    if (isElementAccessExpression(node)) {
      const property = foldedString(node.argumentExpression)
      if (property !== null && bannedLoaderProperties.has(property)) {
        throw new Error(`committed closure 出现禁用 loader 属性：${sourcePath}:${property}`)
      }
    }
    if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken) {
      const assigned = isPropertyAccessExpression(node.left) ? node.left.name.text
        : isElementAccessExpression(node.left) ? foldedString(node.left.argumentExpression) : null
      if (assigned === 'load') throw new Error(`committed closure 禁止初始化后改写 loader：${sourcePath}`)
    }
    const runtimeEdge = isImportDeclaration(node) ? isRuntimeImport(node)
      : isExportDeclaration(node) ? isRuntimeExport(node) : false
    if (runtimeEdge && (isImportDeclaration(node) || isExportDeclaration(node)) && node.moduleSpecifier !== undefined
      && isStringLiteral(node.moduleSpecifier)) {
      staticImports.add(node.moduleSpecifier.text)
      if (!node.moduleSpecifier.text.startsWith('.')
        && !builtins.has(node.moduleSpecifier.text)) {
        directBareImports.add(node.moduleSpecifier.text)
      }
    }
    if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
      if (node.arguments.length !== 1 || !isStringLiteral(node.arguments[0]!)) {
        throw new Error('import(expr) 必须使用单个固定字符串字面量')
      }
      dynamicImports.push(node.arguments[0]!.text)
    }
    forEachChild(node, visit)
  }
  visit(file)
  return { directBareImports, dynamicImports, staticImports }
}

function propertyName(node: import('typescript').ObjectLiteralElementLike): string | null {
  return 'name' in node && node.name !== undefined && (isIdentifier(node.name) || isStringLiteral(node.name))
    ? node.name.text : null
}

/** Extract the sole entry-id to literal-import mapping from the registry initializer. */
export function extractEvaluationEntryImports(source: string): Map<string, string> {
  const file = createSourceFile('entry-registry.ts', source, ScriptTarget.Latest, true, ScriptKind.TS)
  let definitions: import('typescript').ArrayLiteralExpression | undefined
  const find = (node: import('typescript').Node): void => {
    if (isVariableDeclaration(node) && isIdentifier(node.name) && node.name.text === 'evaluationEntryDefinitions'
      && node.initializer !== undefined && isArrayLiteralExpression(node.initializer)) definitions = node.initializer
    forEachChild(node, find)
  }
  find(file)
  if (definitions === undefined) throw new Error('evaluation entry definitions 必须是静态 array initializer')
  const result = new Map<string, string>()
  for (const row of definitions.elements) {
    if (!isArrayLiteralExpression(row) || row.elements.length !== 2 || !isStringLiteral(row.elements[0]!)
      || !isObjectLiteralExpression(row.elements[1]!)) throw new Error('evaluation entry 必须是静态二元组')
    const entryId = row.elements[0]!.text
    const loadProperties = row.elements[1]!.properties.filter(property => propertyName(property) === 'load')
    if (loadProperties.length !== 1 || !isPropertyAssignment(loadProperties[0]!)
      || !isArrowFunction(loadProperties[0]!.initializer)) throw new Error('evaluation entry 必须有唯一固定 loader')
    const imports: string[] = []
    const collect = (node: import('typescript').Node): void => {
      if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
        if (node.arguments.length !== 1 || !isStringLiteral(node.arguments[0]!)) {
          throw new Error('entry loader import 必须是单个字符串字面量')
        }
        imports.push(node.arguments[0]!.text)
      }
      forEachChild(node, collect)
    }
    collect(loadProperties[0]!.initializer)
    if (imports.length !== 1 || !imports[0]!.startsWith('./') || !imports[0]!.endsWith('.js')) {
      throw new Error('evaluation entry loader 必须包含唯一相对字面量 import')
    }
    if (result.has(entryId)) throw new Error('evaluation entry ID 重复')
    result.set(entryId, imports[0]!)
  }
  return result
}

function nearestManifest(
  importerPath: string,
  productPrefix: string,
  productManifest: PackageManifest,
  packages: ReadonlyMap<string, WorkspacePackage>,
): PackageManifest {
  if (importerPath.startsWith(productPrefix + '/')) return productManifest
  const candidates = [...packages.values()]
    .filter(pkg => importerPath.startsWith(pkg.directory + '/'))
    .sort((left, right) => right.directory.length - left.directory.length)
  return candidates[0]?.manifest ?? {}
}

/** 从固定 import 字面量构建 tracked 静态模块图，不加载或执行任何模块。 */
export async function collectRelativeImportClosure(
  workspaceRoot: string,
  roots: readonly string[],
  options: ImportClosureOptions,
): Promise<ImportClosureResult> {
  const canonicalRoot = await realpath(workspaceRoot)
  const productPrefix = options.controlPathPrefix.slice(0, -'eval/'.length).replace(/\/$/u, '')
  if (productPrefix === '' || !options.controlPathPrefix.endsWith('/eval/')) throw new Error('eval 控制面路径前缀无效')
  const workspace = await loadWorkspacePackages(canonicalRoot, options.allowedFiles)
  const productManifestPath = productPrefix + '/package.json'
  const productManifest = JSON.parse(await readFile(
    await trackedOrdinaryFile(canonicalRoot, productManifestPath, options.allowedFiles), 'utf8')) as PackageManifest
  workspace.files.add(productManifestPath)
  const pending = await Promise.all(roots.map(async path => {
    if (isAbsolute(path)) throw new Error('静态模块图根必须是 workspace 相对路径')
    return await trackedOrdinaryFile(canonicalRoot, path, options.allowedFiles)
  }))
  const visited = new Set<string>()
  const usedWorkspacePackages = new Set<string>()
  while (pending.length > 0) {
    const current = pending.pop()!
    if (visited.has(current)) continue
    visited.add(current)
    const currentPath = repositoryPath(canonicalRoot, current)
    if (!sourceExtensions.has(extname(currentPath))) continue
    const source = await readFile(current, 'utf8')
    const analysis = analyzeSourceImports(source, currentPath)
    const requiredDirect = options.requiredDirectBareImports?.get(currentPath)
    if (requiredDirect !== undefined) {
      const actual = [...analysis.directBareImports].sort()
      const expected = [...requiredDirect].sort()
      if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
        throw new Error('源码直接 workspace import 集合不一致')
      }
      for (const packageSpecifier of requiredDirect) {
        if (!workspace.packages.has(packageName(packageSpecifier).name)) {
          throw new Error('要求的直接 import 不是 tracked workspace package')
        }
      }
    }
    const expectedDynamic = options.expectedDynamicImports?.get(currentPath)
    if (expectedDynamic === undefined && analysis.dynamicImports.length > 0) {
      throw new Error(`registry 以外禁止 dynamic import：${currentPath}`)
    }
    if (expectedDynamic !== undefined) {
      const actual = [...analysis.dynamicImports].sort()
      const expected = [...expectedDynamic].sort()
      if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
        throw new Error('registry 出现 loader 定义外 dynamic import')
      }
    }
    const selectedDynamic = options.selectedDynamicImports?.get(currentPath)
    if (selectedDynamic !== undefined) {
      for (const specifier of selectedDynamic) {
        if (!analysis.dynamicImports.includes(specifier)) throw new Error('选定 entry loader 与源码不一致')
      }
    }
    const imports = new Set([
      ...analysis.staticImports,
      ...selectedDynamic === undefined ? analysis.dynamicImports : selectedDynamic,
    ])
    for (const specifier of imports) {
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        pending.push(await resolveRelativeImport(canonicalRoot, current, specifier, options.allowedFiles))
        continue
      }
      if (builtins.has(specifier)) continue
      const parsed = packageName(specifier)
      const workspacePackage = workspace.packages.get(parsed.name)
      if (workspacePackage !== undefined) {
        usedWorkspacePackages.add(parsed.name)
        workspace.files.add(workspacePackage.manifestPath)
        pending.push(await trackedOrdinaryFile(
          canonicalRoot, sourceEntryForPackage(workspacePackage, parsed.subpath), options.allowedFiles))
        continue
      }
      const importerManifest = nearestManifest(currentPath, productPrefix, productManifest, workspace.packages)
      const rootManifest = JSON.parse(await readFile(
        await trackedOrdinaryFile(canonicalRoot, 'package.json', options.allowedFiles), 'utf8')) as PackageManifest
      if (!manifestDeclares(importerManifest, parsed.name) && !manifestDeclares(rootManifest, parsed.name)) {
        throw new Error('未知 bare package import')
      }
    }
  }
  return {
    files: [...new Set([...visited].map(path => repositoryPath(canonicalRoot, path)).concat([...workspace.files]))].sort(),
    workspacePackages: [...usedWorkspacePackages].sort(),
  }
}
