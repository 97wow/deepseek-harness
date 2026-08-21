import { describe, expect, it, vi } from 'vitest'
import { evaluationEntryRegistry } from './entry-registry.js'
import { launchEvaluation } from './launch.js'

describe('结构化评测 launcher', () => {
  it('通过注入 loader 分派 registry 模块且不启动真实 runner', async () => {
    const executionHook = vi.fn(async () => undefined)
    const runtime = { argv: ['node', 'eval/launch.ts'], environment: {} as Record<string, string | undefined> }
    await launchEvaluation(['repeat', '--suite', 'all', 'case-a'], executionHook, runtime)
    expect(executionHook).toHaveBeenCalledExactlyOnceWith('repeat', evaluationEntryRegistry.get('repeat')!.load)
    expect(runtime.argv).toEqual(['node', 'eval/launch.ts', 'case-a'])
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

  it('执行 hook 只能接收 registry 已绑定的 loader，不能替换映射', async () => {
    const executionHook = vi.fn(async (_entryId, load: () => Promise<unknown>) => { expect(load).toBeTypeOf('function') })
    await launchEvaluation(['standard'], executionHook, { argv: ['node', 'launch'], environment: {} })
    expect(executionHook).toHaveBeenCalledExactlyOnceWith('standard', evaluationEntryRegistry.get('standard')!.load)
  })
})
