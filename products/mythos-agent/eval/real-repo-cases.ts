import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { VerificationResult } from './cases.js'

export interface RealRepoCase {
  dimensions: readonly string[]
  futureRevision: string
  id: string
  parentRevision: string
  prompt: string
  targetPaths: readonly string[]
  testPath: string
}

export interface RealRepoVerification extends VerificationResult {
  testExitCode: number
}

export const realRepoCases: readonly RealRepoCase[] = [
  {
    dimensions: ['real-repository', 'performance', 'identity-contract', 'scope-control'],
    futureRevision: '1c77a78d6ac16a49f6821a60fa1ae285ae5e885d',
    id: 'dsh-session-seed-identity',
    parentRevision: '1c77a78d6ac16a49f6821a60fa1ae285ae5e885d^',
    prompt: [
      '这是 DeepSeek Harness 真实仓库的性能缺陷。PersistenceCoordinator 首次 flush 一个已有不可变事件 seed 的 Session 时，',
      '不必要地克隆完整 seed，破坏传给 backend.appendBatch 的引用身份并放大长会话内存开销。',
      '定位并修复实现，使首次 appendBatch 直接复用 Session 暴露的不可变 seed。',
      '只允许修改 packages/session/session-persistence/src/coordinator.ts；不得修改任何测试、配置或依赖文件。',
      '修改后必须运行：node node_modules/vitest/vitest.mjs run --configLoader runner --config vitest.config.ts ',
      'packages/session/session-persistence/tests/persistence.spec.ts。',
    ].join(''),
    targetPaths: ['packages/session/session-persistence/src/coordinator.ts'],
    testPath: 'packages/session/session-persistence/tests/persistence.spec.ts',
  },
  {
    dimensions: ['real-repository', 'shell-parsing', 'regression-fix', 'scope-control'],
    futureRevision: '2f759a6b6509c3e56be761692068ea62b0372fe2',
    id: 'dsh-pwsh-prompt-collision',
    parentRevision: '2f759a6b6509c3e56be761692068ea62b0372fe2^',
    prompt: [
      '这是 DeepSeek Harness 真实仓库的 PowerShell 输出缺失缺陷。持久 PowerShell 工具执行的命令若输出文本恰好等于私有 shell prompt，',
      '当前解析会把合法命令输出当作尾部 prompt 删除。修复输出提取逻辑：仍应移除协议包装和边界换行，但必须保留与 prompt 相同的命令输出。',
      '只允许修改 packages/shell/tool-pwsh-persistent/src/index.ts；不得修改任何测试、package.json、配置或依赖文件。',
      '修改后必须运行：node node_modules/vitest/vitest.mjs run --configLoader runner --config vitest.config.ts ',
      'packages/shell/tool-pwsh-persistent/tests/tools.spec.ts。',
    ].join(''),
    targetPaths: ['packages/shell/tool-pwsh-persistent/src/index.ts'],
    testPath: 'packages/shell/tool-pwsh-persistent/tests/tools.spec.ts',
  },
]

export function futureTest(repoRoot: string, testCase: RealRepoCase): Buffer {
  return execFileSync('git', ['show', `${testCase.futureRevision}:${testCase.testPath}`], {
    cwd: repoRoot,
    encoding: 'buffer',
    maxBuffer: 32 * 1024 * 1024,
  })
}

export async function installFutureTest(repoRoot: string, workspace: string, testCase: RealRepoCase): Promise<boolean> {
  const path = join(workspace, testCase.testPath)
  const before = await readFile(path)
  const expectedBefore = execFileSync('git', ['show', `${testCase.parentRevision}:${testCase.testPath}`], {
    cwd: repoRoot,
    encoding: 'buffer',
    maxBuffer: 32 * 1024 * 1024,
  })
  await writeFile(path, futureTest(repoRoot, testCase))
  return before.equals(expectedBefore)
}
