import { describe, expect, it, vi } from 'vitest'
import { evaluationEntryRegistry, type EvaluationEntryDefinition } from './entry-registry.js'
import { evaluationModuleDispatch, launchEvaluation, validateEvaluationModuleDispatch } from './launch.js'

describe('结构化评测 launcher', () => {
  it('通过注入 loader 分派 registry 模块且不启动真实 runner', async () => {
    const loader = vi.fn(async () => undefined)
    const runtime = { argv: ['node', 'eval/launch.ts'], environment: {} as Record<string, string | undefined> }
    await launchEvaluation(['repeat', '--suite', 'all', 'case-a'], loader, runtime)
    expect(loader).toHaveBeenCalledExactlyOnceWith('eval/repeat.ts')
    expect(runtime.argv).toEqual(['node', 'eval/repeat.ts', 'case-a'])
    expect(runtime.environment).toMatchObject({ MYTHOS_EVAL_ENTRY_ID: 'repeat', MYTHOS_EVAL_SUITE: 'all' })
  })

  it.each(['unknown', 'toString', 'constructor', '__proto__', 'prototype'])('%s entry 在 loader 调用前 fail closed', async entryId => {
    const loader = vi.fn(async () => undefined)
    await expect(launchEvaluation([entryId], loader, { argv: ['node', 'launch'], environment: {} })).rejects.toThrow('未知')
    expect(loader).not.toHaveBeenCalled()
  })

  it('repeat option 后移在 loader 调用前 fail closed', async () => {
    const loader = vi.fn(async () => undefined)
    await expect(launchEvaluation(['repeat', 'case-a', '--suite', 'all'], loader,
      { argv: ['node', 'launch'], environment: {} })).rejects.toThrow('必须位于')
    expect(loader).not.toHaveBeenCalled()
  })

  it('internal-helper 即使注入 registry 也不可启动且 loader 保持零调用', async () => {
    const loader = vi.fn(async () => undefined)
    const standard = evaluationEntryRegistry.get('standard')!
    evaluationEntryRegistry.set('internal-helper' as never,
      { ...standard, visibility: 'internal' } as unknown as EvaluationEntryDefinition)
    try {
      await expect(launchEvaluation(['internal-helper'], loader,
        { argv: ['node', 'launch'], environment: {} })).rejects.toThrow('不可启动')
      expect(loader).not.toHaveBeenCalled()
    } finally {
      evaluationEntryRegistry.delete('internal-helper' as never)
    }
  })

  it('固定 launcher dispatch 与 registry 双向逐项一致', () => {
    expect(evaluationModuleDispatch.size).toBe(evaluationEntryRegistry.size)
    for (const [entryId, entry] of evaluationEntryRegistry) {
      expect(evaluationModuleDispatch.get(entryId)?.module).toBe(entry.module)
    }
    expect(validateEvaluationModuleDispatch).not.toThrow()
  })

  it('新增 entry 未增加固定 import dispatch 时 fail closed', async () => {
    const loader = vi.fn(async () => undefined)
    const standard = evaluationEntryRegistry.get('standard')!
    evaluationEntryRegistry.set('new-safe' as never, { ...standard, id: 'new-safe' } as EvaluationEntryDefinition)
    try {
      await expect(launchEvaluation(['new-safe'], loader,
        { argv: ['node', 'launch'], environment: {} })).rejects.toThrow('集合不一致')
      expect(loader).not.toHaveBeenCalled()
    } finally {
      evaluationEntryRegistry.delete('new-safe' as never)
    }
  })
})
