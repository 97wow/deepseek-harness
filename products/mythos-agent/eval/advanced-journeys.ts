import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { VerificationResult } from './cases.js'

export interface AdvancedJourneyCase {
  dimensions: readonly string[]
  id: string
  minCompactionSummaries: number
  minParallelSubagents: number
  overlay: 'compaction' | 'subagent'
  setup(workspace: string): Promise<void>
  stages: readonly string[]
  verify(workspace: string): Promise<VerificationResult>
}

async function runNode(args: string[], cwd: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
}

async function filesBelow(root: string): Promise<string[]> {
  const result: string[] = []
  async function visit(path: string, prefix: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const child = join(path, entry.name)
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await visit(child, name)
      else result.push(name)
    }
  }
  await visit(root, '')
  return result.sort()
}

function parseObject(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown> : {}
  } catch { return {} }
}

const compactionContinuity: AdvancedJourneyCase = {
  dimensions: ['multi-turn', 'cold-resume', 'compaction', 'conversation-memory', 'repository-change'],
  id: 'journey-compaction-continuity',
  minCompactionSummaries: 1,
  minParallelSubagents: 0,
  overlay: 'compaction',
  stages: [
    [
      '这是长上下文事故修复，口令是 ORBIT-739；口令只能保存在对话中，禁止写入文件。',
      '读取 evidence 目录内全部四个日志文件和 src/quota.js、verify.mjs，运行 node verify.mjs 复现。',
      '只诊断，不修改源码或验证文件。创建 assessment.json，只含 rootCause="string-concatenation"、',
      'affectedTenant="t-204"、expectedTotal=12 三个字段。日志很长，必须逐个读取以取得原始证据。',
    ].join(''),
    [
      '继续该事故。依据上一轮证据修复 src/quota.js，使数值字符串按数字累加，非法值忽略，且不得修改 verify.mjs。',
      '创建 continuity.json，只含 conversationMarker 字段，值是上一轮仅在对话中给你的口令。运行 node verify.mjs。',
    ].join(''),
    [
      '完成交付验证：为 sumUsage 增加可选 tenantFilter，仅统计匹配 tenant；不传时保持兼容。',
      '不得修改 verify.mjs。运行验证，然后创建 release-evidence.json，只含 testExitCode=0、',
      'markerPreserved=true、tenantFilterSupported=true；最后读取检查该文件。',
    ].join(''),
  ],
  async setup(workspace) {
    await mkdir(join(workspace, 'src'), { recursive: true })
    await mkdir(join(workspace, 'evidence'), { recursive: true })
    await writeFile(join(workspace, 'package.json'), '{"type":"module","scripts":{"test":"node verify.mjs"}}\n')
    const filler = Array.from({ length: 90 }, (_, index) => `trace-${String(index).padStart(3, '0')} gateway accepted request; cache stable; no retry anomaly`).join('\n')
    for (let index = 1; index <= 4; index += 1) {
      const fact = index === 3 ? 'tenant=t-204 usage=7 followed-by usage=5 expected-total=12' : `tenant=t-${200 + index} usage=${index}`
      await writeFile(join(workspace, 'evidence', `segment-${index}.log`), `${filler}\n${fact}\n${filler}\n`)
    }
    await writeFile(join(workspace, 'src', 'quota.js'), [
      'export function sumUsage(rows) {',
      "  return rows.reduce((total, row) => total + row.usage, 0)",
      '}',
      '',
    ].join('\n'))
    await writeFile(join(workspace, 'verify.mjs'), [
      "import assert from 'node:assert/strict'",
      "import { sumUsage } from './src/quota.js'",
      "assert.equal(sumUsage([{tenant:'t-204',usage:'7'},{tenant:'t-204',usage:'5'}]), 12)",
      "assert.equal(sumUsage([{tenant:'t-204',usage:'bad'},{tenant:'t-204',usage:2}]), 2)",
      '',
    ].join('\n'))
    await chmod(join(workspace, 'verify.mjs'), 0o444)
  },
  async verify(workspace) {
    const [assessmentText, continuityText, releaseText, verifyText] = await Promise.all([
      readFile(join(workspace, 'assessment.json'), 'utf8').catch(() => ''),
      readFile(join(workspace, 'continuity.json'), 'utf8').catch(() => ''),
      readFile(join(workspace, 'release-evidence.json'), 'utf8').catch(() => ''),
      readFile(join(workspace, 'verify.mjs'), 'utf8'),
    ])
    const assessment = parseObject(assessmentText)
    const continuity = parseObject(continuityText)
    const release = parseObject(releaseText)
    const assessmentCorrect = Object.keys(assessment).sort().join(',') === 'affectedTenant,expectedTotal,rootCause'
      && assessment.rootCause === 'string-concatenation' && assessment.affectedTenant === 't-204' && assessment.expectedTotal === 12
    const markerPreserved = Object.keys(continuity).join(',') === 'conversationMarker' && continuity.conversationMarker === 'ORBIT-739'
    const releaseCorrect = Object.keys(release).sort().join(',') === 'markerPreserved,tenantFilterSupported,testExitCode'
      && release.testExitCode === 0 && release.markerPreserved === true && release.tenantFilterSupported === true
    const baseExit = await runNode(['verify.mjs'], workspace)
    const hidden = join(workspace, '.mythos-hidden-verify.mjs')
    await writeFile(hidden, [
      "import assert from 'node:assert/strict'",
      "import { sumUsage } from './src/quota.js'",
      "const rows=[{tenant:'a',usage:'2.5'},{tenant:'b',usage:9},{tenant:'a',usage:'1.5'}]",
      'assert.equal(sumUsage(rows), 13)',
      "assert.equal(sumUsage(rows, 'a'), 4)",
      '',
    ].join('\n'))
    const hiddenExit = await runNode([hidden], workspace)
    const scopeClean = (await filesBelow(workspace)).every(file => file.startsWith('evidence/') || new Set([
      '.mythos-hidden-verify.mjs', 'assessment.json', 'continuity.json', 'package.json',
      'release-evidence.json', 'src/quota.js', 'verify.mjs',
    ]).has(file))
    const protectedInputUnchanged = verifyText.includes("assert.equal(sumUsage([{tenant:'t-204',usage:'7'}")
    const passed = assessmentCorrect && markerPreserved && releaseCorrect && baseExit === 0 && hiddenExit === 0 && scopeClean && protectedInputUnchanged
    return { evidence: { assessmentCorrect, baseExit, hiddenExit, markerPreserved, protectedInputUnchanged, releaseCorrect, scopeClean }, passed,
      reason: passed ? '压缩前后对话记忆、实现和隐藏验证全部通过' : '压缩连续性、实现或范围控制失败' }
  },
}

const parallelSubagents: AdvancedJourneyCase = {
  dimensions: ['subagent', 'parallel-delegation', 'parent-integration', 'repository-change'],
  id: 'journey-subagent-parallel',
  minCompactionSummaries: 0,
  minParallelSubagents: 2,
  overlay: 'subagent',
  stages: [[
    '修复这个双模块仓库。你必须在同一个 assistant step 中并行发起两个 subagent 调用（都设置 run_in_background=false）：',
    '一个只审查 src/billing.js 并把诊断写入 reviews/billing.json，另一个只审查 src/usage.js 并写入 reviews/usage.json。',
    '两个子 Agent 不得修改 src 或 verify.mjs。父 Agent 收到两份结果后必须读取两份 review，亲自修复两个源码文件，',
    '运行 node verify.mjs，再创建 integration-evidence.json，只含 delegatedReviews=2、testExitCode=0、parentIntegrated=true，',
    '最后读取检查。禁止绕过委派，禁止修改 verify.mjs。',
  ].join('')],
  async setup(workspace) {
    await mkdir(join(workspace, 'src'), { recursive: true })
    await mkdir(join(workspace, 'reviews'), { recursive: true })
    await writeFile(join(workspace, 'package.json'), '{"type":"module","scripts":{"test":"node verify.mjs"}}\n')
    await writeFile(join(workspace, 'src', 'billing.js'), "export const charge = (units, price) => Math.floor(units) * price\n")
    await writeFile(join(workspace, 'src', 'usage.js'), "export const normalizeUsage = value => Number.parseInt(value, 10)\n")
    await writeFile(join(workspace, 'verify.mjs'), [
      "import assert from 'node:assert/strict'",
      "import { charge } from './src/billing.js'",
      "import { normalizeUsage } from './src/usage.js'",
      'assert.equal(charge(1.5, 2), 3)',
      "assert.equal(normalizeUsage('2.75'), 2.75)",
      "assert.equal(normalizeUsage('bad'), 0)",
      '',
    ].join('\n'))
    await chmod(join(workspace, 'verify.mjs'), 0o444)
  },
  async verify(workspace) {
    const [billingReview, usageReview, evidenceText, verifyText] = await Promise.all([
      readFile(join(workspace, 'reviews', 'billing.json'), 'utf8').catch(() => ''),
      readFile(join(workspace, 'reviews', 'usage.json'), 'utf8').catch(() => ''),
      readFile(join(workspace, 'integration-evidence.json'), 'utf8').catch(() => ''),
      readFile(join(workspace, 'verify.mjs'), 'utf8'),
    ])
    const evidence = parseObject(evidenceText)
    const reviewsPresent = Object.keys(parseObject(billingReview)).length > 0 && Object.keys(parseObject(usageReview)).length > 0
    const evidenceCorrect = Object.keys(evidence).sort().join(',') === 'delegatedReviews,parentIntegrated,testExitCode'
      && evidence.delegatedReviews === 2 && evidence.testExitCode === 0 && evidence.parentIntegrated === true
    const baseExit = await runNode(['verify.mjs'], workspace)
    const hidden = join(workspace, '.mythos-hidden-verify.mjs')
    await writeFile(hidden, [
      "import assert from 'node:assert/strict'",
      "import { charge } from './src/billing.js'",
      "import { normalizeUsage } from './src/usage.js'",
      'assert.equal(charge(0.25, 8), 2)',
      'assert.equal(normalizeUsage(null), 0)',
      '',
    ].join('\n'))
    const hiddenExit = await runNode([hidden], workspace)
    const scopeClean = (await filesBelow(workspace)).every(file => new Set([
      '.mythos-hidden-verify.mjs', 'integration-evidence.json', 'package.json', 'reviews/billing.json',
      'reviews/usage.json', 'src/billing.js', 'src/usage.js', 'verify.mjs',
    ]).has(file))
    const protectedInputUnchanged = verifyText.includes("assert.equal(charge(1.5, 2), 3)")
    const passed = reviewsPresent && evidenceCorrect && baseExit === 0 && hiddenExit === 0 && scopeClean && protectedInputUnchanged
    return { evidence: { baseExit, evidenceCorrect, hiddenExit, protectedInputUnchanged, reviewsPresent, scopeClean }, passed,
      reason: passed ? '两个子 Agent 产出、父 Agent 集成和隐藏验证全部通过' : '委派产出、父级集成或验证失败' }
  },
}

export const advancedJourneyCases: readonly AdvancedJourneyCase[] = [compactionContinuity, parallelSubagents]
