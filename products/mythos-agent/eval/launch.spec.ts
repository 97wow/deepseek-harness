import { describe, expect, it, vi } from 'vitest'
import { launchEvaluation } from './launch.js'

describe('结构化评测 launcher', () => {
  it('通过注入 loader 分派 registry 模块且不启动真实 runner', async () => {
    const loader = vi.fn(async () => undefined)
    const runtime = { argv: ['node', 'eval/launch.ts'], environment: {} as Record<string, string | undefined> }
    await launchEvaluation(['repeat', '--suite', 'all', 'case-a'], loader, runtime)
    expect(loader).toHaveBeenCalledExactlyOnceWith('eval/repeat.ts')
    expect(runtime.argv).toEqual(['node', 'eval/repeat.ts', 'case-a'])
    expect(runtime.environment).toMatchObject({ MYTHOS_EVAL_ENTRY_ID: 'repeat', MYTHOS_EVAL_SUITE: 'all' })
  })

  it('未知 entry 在 loader 调用前 fail closed', async () => {
    const loader = vi.fn(async () => undefined)
    await expect(launchEvaluation(['unknown'], loader, { argv: ['node', 'launch'], environment: {} })).rejects.toThrow('未知')
    expect(loader).not.toHaveBeenCalled()
  })
})
