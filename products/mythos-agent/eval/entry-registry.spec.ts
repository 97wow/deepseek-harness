import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  canonicalEvaluationCommand,
  evaluationEntryRegistry,
  parseEvaluationLaunchArguments,
  publicEvaluationScripts,
  registeredEvaluationReferenceScripts,
  validatePackageEvaluationScripts,
} from './entry-registry.js'

async function packageScripts(): Promise<Record<string, string>> {
  const manifest = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
  }
  return manifest.scripts
}

describe('结构化评测入口 registry', () => {
  it('当前 package scripts 与 registry canonical command 精确一一对应', async () => {
    const scripts = await packageScripts()
    expect(() => validatePackageEvaluationScripts(scripts)).not.toThrow()
    expect(Object.keys(evaluationEntryRegistry)).toHaveLength(10)
    expect(Object.keys(publicEvaluationScripts)).toHaveLength(11)
    expect(scripts.typecheck).toBe(registeredEvaluationReferenceScripts.typecheck)
    for (const scriptName of Object.keys(publicEvaluationScripts) as (keyof typeof publicEvaluationScripts)[]) {
      expect(scripts[scriptName]).toBe(canonicalEvaluationCommand(scriptName))
    }
  })

  it.each([
    ['eval:unknown', 'tsx eval/unknown.ts'],
    ['extra', 'env X=1 tsx eval/launch.ts standard'],
    ['extra', 'echo tsx eval/launch.ts standard'],
    ['extra', "busybox sh -c 'tsx eval/launch.ts standard'"],
    ['extra', 'tsx eval/launch.ts $ENTRY'],
    ['extra', 'command time tsx eval/run.ts'],
    ['extra', 'tsx launch.ts standard'],
    ['bench:qwen-local:extra', 'echo harmless'],
    ['extra', 'tsx run-qwen-local.ts'],
  ])('未注册或动态 package script fail closed：%s=%s', async (name, command) => {
    const scripts = await packageScripts()
    expect(() => validatePackageEvaluationScripts({ ...scripts, [name]: command })).toThrow('未注册')
  })

  it('已注册 script 的任意字节差异 fail closed', async () => {
    const scripts = await packageScripts()
    expect(() => validatePackageEvaluationScripts({ ...scripts, eval: `${scripts.eval} ` })).toThrow('不匹配')
    expect(() => validatePackageEvaluationScripts({ ...scripts, typecheck: `${scripts.typecheck} ` })).toThrow('不匹配')
  })

  it.each([
    [], [''], ['unknown'], ['standard', ''], ['standard', '--suite', 'all'], ['repeat', '--suite', 'all', '--suite', 'all'],
    ['repeat', '--unknown', 'x'], ['standard', 'case', 'case'], ['standard', '../eval/run.ts'], ['journey', 'case'],
  ])('未知、空、重复、未声明或动态 launcher 参数被拒绝：%j', argv => {
    expect(() => parseEvaluationLaunchArguments(argv)).toThrow()
  })

  it('registry 中所有 public script 的结构化参数均可验证', () => {
    for (const definition of Object.values(publicEvaluationScripts)) {
      expect(parseEvaluationLaunchArguments([definition.entryId, ...definition.args]).entryId).toBe(definition.entryId)
    }
  })
})
