import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { collectRelativeImportClosure, extractEvaluationEntryImports } from './import-closure.js'

async function workspace(files: Readonly<Record<string, string>>): Promise<{ allowed: Set<string>; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'mythos-import-closure-'))
  const allFiles = {
    'apps/cli/package.json': JSON.stringify({ name: '@deepseek-ai/dsh' }),
    'package.json': JSON.stringify({ devDependencies: { typescript: '^6.0.0' } }),
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'pnpm-workspace.yaml': 'packages: []\n',
    'product/package.json': JSON.stringify({ dependencies: { 'js-yaml': '^4.0.0' } }),
    ...files,
  }
  for (const [path, contents] of Object.entries(allFiles)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), contents)
  }
  return { allowed: new Set(Object.keys(allFiles)), root }
}

async function collect(source: string): Promise<Awaited<ReturnType<typeof collectRelativeImportClosure>>> {
  const fixture = await workspace({ 'product/eval/entry.ts': source })
  return await collectRelativeImportClosure(fixture.root, ['product/eval/entry.ts'], {
    allowedFiles: fixture.allowed, controlPathPrefix: 'product/eval/',
  })
}

describe('eval 静态模块图', () => {
  it.each([
    'require(target)', '(require)(target)', 'module.require(target)', "module['require'](target)",
    'const { require } = module', 'createRequire(import.meta.url)', '(0, eval)(source)', 'eval.call(null, source)',
    'new Function(source)', "globalThis['Function'](source)", 'require.bind(null)(target)', 'require.call(null, target)',
    'module[key](target)', 'globalThis[key](target)', "module['anything'](target)", "globalThis['anything'](target)",
  ])('任何 loader 标识或属性出现都 fail closed：%s', async source => {
    await expect(collect(source)).rejects.toThrow('禁用 loader')
  })

  it('禁用 loader 规则覆盖 eval 外的递归 committed closure', async () => {
    const fixture = await workspace({
      'product/eval/entry.ts': "import '../../internal/loader.js'",
      'internal/loader.ts': 'module[key](target)',
    })
    await expect(collectRelativeImportClosure(fixture.root, ['product/eval/entry.ts'], {
      allowedFiles: fixture.allowed, controlPathPrefix: 'product/eval/',
    })).rejects.toThrow('禁用 loader')
  })

  it('entry registry AST 是唯一 entry→字面量 import 映射', async () => {
    const source = await readFile(new URL('./entry-registry.ts', import.meta.url), 'utf8')
    const expected = new Map([
      ['advanced-journey', './run-advanced-journeys.js'],
      ['advanced-journey-repeat', './repeat-advanced-journeys.js'],
      ['comprehensive', './run-comprehensive.js'],
      ['journey', './run-journeys.js'],
      ['journey-repeat', './repeat-journeys.js'],
      ['qwen-local', './run-qwen-local.js'],
      ['qwen-local-benchmark', './qwen-local-benchmark.js'],
      ['real-repository', './run-real-repo.js'],
      ['repeat', './repeat.js'],
      ['standard', './run.js'],
    ])
    expect(extractEvaluationEntryImports(source)).toEqual(expected)
    const changed = source.replace("load: async () => await import('./run.js')",
      "load: async () => await import('./repeat.js')")
    expect(extractEvaluationEntryImports(changed)).not.toEqual(expected)
  })

  it.each([
    'void import(target)', 'void import("./" + target)', 'void import(flag ? "./a.js" : "./b.js")',
    'void import(' + String.fromCharCode(96) + './' + '$' + '{target}.js' + String.fromCharCode(96) + ')',
    'void import()', 'void import("./a.js", options)',
  ])('import(expr) 非单一字符串字面量 fail closed：%s', async source => {
    await expect(collect(source)).rejects.toThrow('固定字符串字面量')
  })

  it('固定字面量 import 进入递归 tracked 闭包', async () => {
    const fixture = await workspace({
      'product/eval/entry.ts': "void import('./dep.js')",
      'product/eval/dep.ts': "import './nested.js'",
      'product/eval/nested.ts': 'export {}',
    })
    const result = await collectRelativeImportClosure(fixture.root, ['product/eval/entry.ts'], {
      allowedFiles: fixture.allowed, controlPathPrefix: 'product/eval/',
    })
    expect(result.files).toEqual(expect.arrayContaining([
      'product/eval/dep.ts', 'product/eval/entry.ts', 'product/eval/nested.ts',
    ]))
  })

  it('未知 bare package 与额外非字面量动态 import 均不会漏算', async () => {
    await expect(collect("import 'not-declared-anywhere'")).rejects.toThrow('未知 bare package')
    const fixture = await workspace({
      'product/eval/entry.ts': "import './dep.js'",
      'product/eval/dep.ts': 'void import(target)',
    })
    await expect(collectRelativeImportClosure(fixture.root, ['product/eval/entry.ts'], {
      allowedFiles: fixture.allowed, controlPathPrefix: 'product/eval/',
    })).rejects.toThrow('固定字符串字面量')
  })

  it("extensionless 目录 import './dep' 不得隐式解析 index.ts", async () => {
    const fixture = await workspace({
      'product/eval/entry.ts': "import './dep'", 'product/eval/dep/index.ts': 'export {}',
    })
    await expect(collectRelativeImportClosure(fixture.root, ['product/eval/entry.ts'], {
      allowedFiles: fixture.allowed, controlPathPrefix: 'product/eval/',
    })).rejects.toThrow('无法解析')
  })

  it('tracked symlink root 在 realpath 前被拒绝', async () => {
    const fixture = await workspace({ 'product/eval/target.ts': 'export {}' })
    await symlink('target.ts', join(fixture.root, 'product/eval/entry.ts'))
    fixture.allowed.add('product/eval/entry.ts')
    await expect(collectRelativeImportClosure(fixture.root, ['product/eval/entry.ts'], {
      allowedFiles: fixture.allowed, controlPathPrefix: 'product/eval/',
    })).rejects.toThrow('非符号链接普通文件')
  })

  it('untracked static target 在读取正文前 fail closed', async () => {
    const fixture = await workspace({
      'product/eval/entry.ts': "import './untracked.js'",
      'product/eval/untracked.ts': 'sensitive-body-must-not-be-read',
    })
    fixture.allowed.delete('product/eval/untracked.ts')
    let message = ''
    try {
      await collectRelativeImportClosure(fixture.root, ['product/eval/entry.ts'], {
        allowedFiles: fixture.allowed, controlPathPrefix: 'product/eval/',
      })
    } catch (error) {
      message = String(error)
    }
    expect(message).toContain('无法解析')
    expect(message).not.toContain('sensitive-body-must-not-be-read')
  })
})
