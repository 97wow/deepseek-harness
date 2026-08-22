import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { evaluationRuntimePaths } from './runtime-paths.js'

describe('评测运行路径', () => {
  it.each([
    ['/snapshot/products/mythos-agent/eval/run.ts'],
    ['/snapshot/products/mythos-agent/.mythos-eval-runtime/eval/run.js'],
  ])('源码与编译模块都定位到已物化产品 metadata：%s', modulePath => {
    expect(evaluationRuntimePaths(pathToFileURL(modulePath).href)).toEqual({
      productRoot: '/snapshot/products/mythos-agent',
      repoRoot: '/snapshot',
    })
  })
})
