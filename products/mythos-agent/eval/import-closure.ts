import { builtinModules } from 'node:module'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isStringLiteral,
  preProcessFile,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
} from 'typescript'

export interface ImportClosureOptions {
  allowedFiles?: ReadonlySet<string>
  controlPathPrefix: string
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

const bannedLoaderIdentifiers = new Set(['Function', 'createRequire', 'eval', 'require'])
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
  const value = manifest.exports?.[key]
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

function analyzeSourceImports(source: string, banRuntimeLoaders: boolean): string[] {
  const file = createSourceFile('eval-control.ts', source, ScriptTarget.Latest, true, ScriptKind.TS)
  const diagnostics = (file as typeof file & { parseDiagnostics?: readonly unknown[] }).parseDiagnostics ?? []
  if (diagnostics.length > 0) throw new Error('静态模块图源码无法安全解析')
  const imports = new Set<string>()
  const visit = (node: import('typescript').Node): void => {
    if (banRuntimeLoaders && isIdentifier(node) && bannedLoaderIdentifiers.has(node.text)) {
      throw new Error('eval 控制面出现禁用 loader 标识')
    }
    if (banRuntimeLoaders && isPropertyAccessExpression(node) && bannedLoaderIdentifiers.has(node.name.text)) {
      throw new Error('eval 控制面出现禁用 loader 属性')
    }
    if (banRuntimeLoaders && isElementAccessExpression(node) && isStringLiteral(node.argumentExpression)
      && bannedLoaderIdentifiers.has(node.argumentExpression.text)) {
      throw new Error('eval 控制面出现禁用 loader 属性')
    }
    if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
      if (node.arguments.length !== 1 || !isStringLiteral(node.arguments[0]!)) {
        throw new Error('import(expr) 必须使用单个固定字符串字面量')
      }
      imports.add(node.arguments[0]!.text)
    }
    forEachChild(node, visit)
  }
  visit(file)
  return [...imports]
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
    const imports = new Set(preProcessFile(source, true, true).importedFiles.map(file => file.fileName))
    for (const specifier of analyzeSourceImports(source, currentPath.startsWith(options.controlPathPrefix))) imports.add(specifier)
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
