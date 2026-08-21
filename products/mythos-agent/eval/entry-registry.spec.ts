import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  canonicalEvaluationCommand,
  canonicalPackageScripts,
  evaluationEntryRegistry,
  parseEvaluationLaunchArguments,
  publicEvaluationScripts,
  validateEvaluationRegistry,
  validatePackageEvaluationScripts,
  type EvaluationEntryDefinition,
  type PublicEvaluationInvocation,
} from './entry-registry.js'

async function packageScripts(): Promise<Record<string, string>> {
  const manifest = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
  }
  return manifest.scripts
}

function copyScripts(scripts: Readonly<Record<string, string>>): Record<string, string> {
  return Object.assign(Object.create(null) as Record<string, string>, scripts)
}

describe('结构化评测入口 registry', () => {
  it('package scripts 整张表与机器策略字节级一致', async () => {
    const scripts = await packageScripts()
    expect(() => validatePackageEvaluationScripts(scripts)).not.toThrow()
    expect(evaluationEntryRegistry.size).toBe(11)
    expect(publicEvaluationScripts.size).toBe(12)
    expect(canonicalPackageScripts.size).toBe(Object.keys(scripts).length)
    expect(new Set([...canonicalPackageScripts.values()].map(item => item.category)))
      .toEqual(new Set(['evaluation', 'internal-tool', 'non-eval']))
    for (const [scriptName, policy] of canonicalPackageScripts) expect(scripts[scriptName]).toBe(policy.command)
    for (const scriptName of publicEvaluationScripts.keys()) expect(scripts[scriptName]).toBe(canonicalEvaluationCommand(scriptName))
  })

  it.each([
    ['dynamic:new', 'echo harmless'],
    ['eval:unknown', 'tsx eval/unknown.ts'],
    ['wrapper', 'env X=1 tsx eval/launch.ts standard'],
    ['echo', 'echo tsx eval/launch.ts standard'],
    ['shell', "busybox sh -c 'tsx eval/launch.ts standard'"],
    ['variable', 'tsx eval/launch.ts $ENTRY'],
  ])('任何未纳入策略的 package script fail closed：%s=%s', async (name, command) => {
    const scripts = copyScripts(await packageScripts())
    scripts[name] = command
    expect(() => validatePackageEvaluationScripts(scripts)).toThrow('键集合')
  })

  it('新增、删除、改名或任意命令字节变化都 fail closed', async () => {
    const original = await packageScripts()
    const changed = copyScripts(original)
    changed.eval = changed.eval + ' '
    expect(() => validatePackageEvaluationScripts(changed)).toThrow('不匹配')

    const deleted = copyScripts(original)
    delete deleted.web
    expect(() => validatePackageEvaluationScripts(deleted)).toThrow('键集合')

    const renamed = copyScripts(original)
    renamed['web:new'] = renamed.web!
    delete renamed.web
    expect(() => validatePackageEvaluationScripts(renamed)).toThrow('不匹配')
  })

  it.each(['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__', 'prototype', ' standard', 'standard ', 'ｓｔａｎｄａｒｄ'])(
    '原型链、空白与 Unicode/confusable entry ID 被拒绝：%s',
    entryId => expect(() => parseEvaluationLaunchArguments([entryId])).toThrow('未知'),
  )

  it.each(['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__', 'prototype'])(
    '原型链 script name 无法绕过整表策略：%s',
    async scriptName => {
      const scripts = copyScripts(await packageScripts())
      scripts[scriptName] = 'echo harmless'
      expect(() => validatePackageEvaluationScripts(scripts)).toThrow()
    },
  )

  it.each([
    [], [''], ['unknown'], ['standard', ''], ['standard', '--suite', 'all'], ['repeat', '--suite', 'all', '--suite', 'all'],
    ['repeat', '--unknown', 'x'], ['repeat', '--suite', ''], ['standard', 'case', 'case'], ['standard', '../eval/run.ts'],
    ['journey', 'case'], ['repeat', 'case-a', '--suite', 'all'],
  ])('未知、空、重复、未声明、动态或非 canonical 顺序参数被拒绝：%j', argv => {
    expect(() => parseEvaluationLaunchArguments(argv)).toThrow()
  })

  it('repeat 只接受 option 在 positional case IDs 前的单一 grammar', () => {
    const invocation = parseEvaluationLaunchArguments(['repeat', '--suite', 'all', 'case-a', 'case-b'])
    expect(invocation.options).toEqual(new Map([['suite', 'all']]))
    expect(invocation.caseIds).toEqual(['case-a', 'case-b'])
  })

  it('M3 minimal smoke 固定现有单 case、单 attempt、并发 1、零重试和请求上限', () => {
    const invocation = parseEvaluationLaunchArguments(['m3-smoke', 'exact-file'])
    expect(invocation.caseIds).toEqual(['exact-file'])
    expect(invocation.entry.smokePolicy).toEqual({
      attempts: 1, concurrency: 1, maxRetries: 0, maxTokens: 4096, timeoutMs: 120000,
    })
    expect(() => parseEvaluationLaunchArguments(['m3-smoke'])).toThrow('固定 case')
    expect(() => parseEvaluationLaunchArguments(['m3-smoke', 'bugfix-protected-test'])).toThrow('固定 case')
    expect(canonicalEvaluationCommand('eval:m3-smoke')).toBe('tsx eval/launch.ts m3-smoke exact-file')
  })

  it('entry 与 public invocation 双向校验，孤立 public entry fail closed', () => {
    expect(() => validateEvaluationRegistry()).not.toThrow()
    const entries = new Map<string, EvaluationEntryDefinition>(evaluationEntryRegistry)
    const standard = evaluationEntryRegistry.get('standard')!
    entries.set('new-safe', { ...standard, load: async () => undefined })
    expect(() => validateEvaluationRegistry(entries, publicEvaluationScripts)).toThrow('没有 script invocation')

    const invocations = new Map<string, PublicEvaluationInvocation>(publicEvaluationScripts)
    invocations.set('eval:new-safe', { args: [], entryId: 'new-safe' as never })
    expect(() => validateEvaluationRegistry(evaluationEntryRegistry, invocations)).toThrow('未知或内部')
  })

  it('internal-helper 无法通过 registry validation，即使自报消费者', () => {
    const standard = evaluationEntryRegistry.get('standard')!
    const entries = new Map<string, EvaluationEntryDefinition>(evaluationEntryRegistry)
    entries.set('internal-helper', { ...standard, referencedBy: ['standard'], visibility: 'internal' } as unknown as EvaluationEntryDefinition)
    expect(() => validateEvaluationRegistry(entries, publicEvaluationScripts)).toThrow('禁止独立 internal entry')
  })

  it('registry 中所有 public script 的结构化参数均可验证', () => {
    for (const definition of publicEvaluationScripts.values()) {
      expect(parseEvaluationLaunchArguments([definition.entryId, ...definition.args]).entryId).toBe(definition.entryId)
    }
  })

  it('registry view 与 entry loader 初始化后不可改写', () => {
    const standard = evaluationEntryRegistry.get('standard')!
    const original = standard.load
    expect(Object.isFrozen(evaluationEntryRegistry)).toBe(true)
    expect(Object.isFrozen(standard)).toBe(true)
    expect('set' in evaluationEntryRegistry).toBe(false)
    expect(() => {
      (standard as EvaluationEntryDefinition & { load: () => Promise<unknown> }).load = async () => undefined
    }).toThrow()
    expect(standard.load).toBe(original)
  })
})
