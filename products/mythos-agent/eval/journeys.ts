import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { VerificationResult } from './cases.js'

export interface JourneyCase {
  id: string
  minCompactionSummaries: number
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
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await visit(child, relative)
      else result.push(relative)
    }
  }
  await visit(root, '')
  return result.sort()
}

const coldResumeFeature: JourneyCase = {
  id: 'journey-cold-resume-feature',
  minCompactionSummaries: 0,
  stages: [
    [
      '这是一个分阶段事故修复。事故标识是 NEBULA-417，请只在对话中记住，第一阶段绝对不要把它写入任何文件。',
      '先检查 incident.json、src/retry-policy.js 和 verify.mjs，并实际运行 node verify.mjs 复现失败。',
      '这一阶段只诊断，不得修改 src/retry-policy.js 或 verify.mjs。',
      '创建 assessment.json，且只能包含 rootCause、affectedInput、recommended 三个字段：',
      '值依次为字符串 integer-truncation、字符串 "1.5"、字符串 finite-positive-number。',
    ].join(''),
    [
      '继续上一阶段。根据先前诊断修复 retry-after 的小数、空值、非法值和负数处理，不得修改 verify.mjs。',
      '创建 continuity.json，且只能包含 incidentMarker 字段，值必须是我上一轮只在对话里给你的事故标识。',
      '完成后实际运行 node verify.mjs。',
    ].join(''),
    [
      '追加一个兼容性需求：retryDecision 增加可选的第三个 source 参数。',
      '未传 source 时返回对象形状必须与现在完全相同；传入字符串时才增加 source 字段。',
      '不得修改 verify.mjs。运行现有验证后创建 release-evidence.json，且只能包含',
      'testExitCode: 0、backwardCompatible: true、sourceSupported: true；创建后必须读取并检查该文件。',
    ].join(''),
  ],
  async setup(workspace) {
    await mkdir(join(workspace, 'src'), { recursive: true })
    await writeFile(join(workspace, 'package.json'), '{"type":"module","scripts":{"test":"node verify.mjs"}}\n')
    await writeFile(join(workspace, 'incident.json'), '{"status":429,"retryAfter":"1.5"}\n')
    await writeFile(join(workspace, 'src', 'retry-policy.js'), [
      'export function parseRetryAfter(value) {',
      '  const seconds = Number.parseInt(value, 10)',
      '  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0',
      '}',
      '',
      'export function retryDecision(status, retryAfter) {',
      '  return { retry: status === 429, delayMs: status === 429 ? parseRetryAfter(retryAfter) : 0 }',
      '}',
      '',
    ].join('\n'))
    await writeFile(join(workspace, 'verify.mjs'), [
      "import assert from 'node:assert/strict'",
      "import { parseRetryAfter, retryDecision } from './src/retry-policy.js'",
      "assert.equal(parseRetryAfter('1.5'), 1500)",
      "assert.equal(parseRetryAfter(' 3 '), 3000)",
      "assert.equal(parseRetryAfter('-1'), 0)",
      "assert.equal(parseRetryAfter('invalid'), 0)",
      'assert.equal(parseRetryAfter(null), 0)',
      "assert.deepEqual(retryDecision(500, '4'), { retry: false, delayMs: 0 })",
      '',
    ].join('\n'))
    await chmod(join(workspace, 'verify.mjs'), 0o444)
    await chmod(join(workspace, 'incident.json'), 0o444)
  },
  async verify(workspace) {
    const [test, incident, assessmentText, continuityText, evidenceText] = await Promise.all([
      readFile(join(workspace, 'verify.mjs'), 'utf8'),
      readFile(join(workspace, 'incident.json'), 'utf8'),
      readFile(join(workspace, 'assessment.json'), 'utf8').catch(() => ''),
      readFile(join(workspace, 'continuity.json'), 'utf8').catch(() => ''),
      readFile(join(workspace, 'release-evidence.json'), 'utf8').catch(() => ''),
    ])
    const parse = (text: string): Record<string, unknown> => {
      try {
        const value = JSON.parse(text) as unknown
        return typeof value === 'object' && value !== null && !Array.isArray(value)
          ? value as Record<string, unknown> : {}
      } catch { return {} }
    }
    const assessment = parse(assessmentText)
    const continuity = parse(continuityText)
    const evidence = parse(evidenceText)
    const assessmentCorrect = Object.keys(assessment).sort().join(',') === 'affectedInput,recommended,rootCause'
      && assessment.rootCause === 'integer-truncation' && assessment.affectedInput === '1.5'
      && assessment.recommended === 'finite-positive-number'
    const continuityCorrect = Object.keys(continuity).join(',') === 'incidentMarker'
      && continuity.incidentMarker === 'NEBULA-417'
    const evidenceCorrect = Object.keys(evidence).sort().join(',') === 'backwardCompatible,sourceSupported,testExitCode'
      && evidence.testExitCode === 0 && evidence.backwardCompatible === true && evidence.sourceSupported === true
    const protectedInputsUnchanged = incident === '{"status":429,"retryAfter":"1.5"}\n'
      && test.includes("assert.deepEqual(retryDecision(500, '4'), { retry: false, delayMs: 0 })")
    const baseExit = await runNode(['verify.mjs'], workspace)
    const hidden = join(workspace, '.mythos-hidden-verify.mjs')
    await writeFile(hidden, [
      "import assert from 'node:assert/strict'",
      "import { retryDecision } from './src/retry-policy.js'",
      "assert.deepEqual(retryDecision(429, '2'), { retry: true, delayMs: 2000 })",
      "assert.deepEqual(retryDecision(429, '2', 'gateway'), { retry: true, delayMs: 2000, source: 'gateway' })",
      '',
    ].join('\n'))
    const hiddenExit = await runNode([hidden], workspace)
    const allowed = new Set(['assessment.json', 'continuity.json', 'incident.json', 'package.json', 'release-evidence.json', 'src/retry-policy.js', 'verify.mjs', '.mythos-hidden-verify.mjs'])
    const scopeClean = (await filesBelow(workspace)).every(file => allowed.has(file))
    const passed = assessmentCorrect && continuityCorrect && evidenceCorrect && protectedInputsUnchanged
      && baseExit === 0 && hiddenExit === 0 && scopeClean
    return {
      evidence: { assessmentCorrect, baseExit, continuityCorrect, evidenceCorrect, hiddenExit, protectedInputsUnchanged, scopeClean },
      passed,
      reason: passed ? '三阶段冷恢复、对话记忆、修复与兼容扩展全部通过' : '旅程连续性、实现、验证或范围控制失败',
    }
  },
}

export const journeyCases: readonly JourneyCase[] = [coldResumeFeature]
