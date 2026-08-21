import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { collectRelativeImportClosure } from './import-closure.js'

async function workspace(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mythos-import-closure-'))
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), contents)
  }
  return root
}

describe('静态 import commitment 闭包', () => {
  it.each([
    "const target = './dep.js'; void import(target)",
    "const target = './dep.js'; require(target)",
    "const target = '@scope/package'; require.resolve(target)",
    "void import('@scope/package')",
    "require('@scope/package')",
    "const target = './dep.js'; const req = require; req(target)",
    "const target = './dep.js'; const resolver = require.resolve; resolver(target)",
    "const target = './dep.js'; const req = createRequire(import.meta.url); req(target)",
  ])('未声明动态模块加载 fail closed：%s', async source => {
    const root = await workspace({ 'entry.ts': source, 'dep.ts': 'export {}' })
    await expect(collectRelativeImportClosure(root, ['entry.ts'], {
      allowedFiles: new Set(['entry.ts', 'dep.ts']),
    })).rejects.toThrow('未声明的动态模块加载')
  })

  it('声明的动态 loader 必须有真实加载点且可绑定固定 tracked root', async () => {
    const root = await workspace({ 'entry.ts': "const target = './dep.js'; void import(target)", 'dep.ts': 'export {}' })
    const result = await collectRelativeImportClosure(root, ['entry.ts', 'dep.ts'], {
      allowedDynamicLoaders: new Set(['entry.ts']), allowedFiles: new Set(['entry.ts', 'dep.ts']),
    })
    expect(result.dynamicLoaders).toEqual(['entry.ts'])
    expect(result.files).toEqual(['dep.ts', 'entry.ts'])
    await expect(collectRelativeImportClosure(root, ['entry.ts', 'dep.ts'], {
      allowedDynamicLoaders: new Set(['dep.ts']), allowedFiles: new Set(['entry.ts', 'dep.ts']),
    })).rejects.toThrow('未声明的动态模块加载')
  })

  it("extensionless 目录 import './dep' 不得隐式解析 index.ts", async () => {
    const root = await workspace({ 'entry.ts': "import './dep'", 'dep/index.ts': 'export {}' })
    await expect(collectRelativeImportClosure(root, ['entry.ts'], {
      allowedFiles: new Set(['entry.ts', 'dep/index.ts']),
    })).rejects.toThrow('无法解析')
  })

  it('tracked symlink root 在 realpath 前被拒绝', async () => {
    const root = await workspace({ 'target.ts': 'export {}' })
    await symlink('target.ts', join(root, 'entry.ts'))
    await expect(collectRelativeImportClosure(root, ['entry.ts'], {
      allowedFiles: new Set(['entry.ts', 'target.ts']),
    })).rejects.toThrow('非符号链接普通文件')
  })

  it('声明的动态 target 不在 tracked manifest 时读取正文前 fail closed', async () => {
    const root = await workspace({
      'entry.ts': "const target = './dynamic-target.js'; void import(target)",
      'dynamic-target.ts': 'sensitive-body-must-not-be-read',
    })
    let message = ''
    try {
      await collectRelativeImportClosure(root, ['entry.ts', 'dynamic-target.ts'], {
        allowedDynamicLoaders: new Set(['entry.ts']), allowedFiles: new Set(['entry.ts']),
      })
    } catch (error) {
      message = String(error)
    }
    expect(message).toContain('不是 tracked 文件')
    expect(message).not.toContain('sensitive-body-must-not-be-read')
  })

  it('嵌套 symlink import 同样 fail closed', async () => {
    const root = await workspace({ 'entry.ts': "import './dep.js'", 'target.ts': 'export {}' })
    await symlink('target.ts', join(root, 'dep.ts'))
    await expect(collectRelativeImportClosure(root, ['entry.ts'], {
      allowedFiles: new Set(['entry.ts', 'dep.ts', 'target.ts']),
    })).rejects.toThrow('无法解析')
  })

  it('明确扩展的 tracked 普通相对文件按 TypeScript ESM 规则解析', async () => {
    const root = await workspace({ 'entry.ts': "import './dep.js'", 'dep.ts': 'export {}' })
    await expect(collectRelativeImportClosure(root, ['entry.ts'], {
      allowedFiles: new Set(['entry.ts', 'dep.ts']),
    })).resolves.toMatchObject({ files: ['dep.ts', 'entry.ts'] })
  })
})
