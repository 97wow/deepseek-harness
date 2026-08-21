import { createHash } from 'node:crypto'
import { createReadStream, constants } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { authoritativeCaseSemantics, parseEvaluationReport } from '../eval/report-contract.js'
import { readCompressedSessionMetrics } from '../eval/session-metrics.js'

export interface ArchiveOptions {
  outputRoot: string
  productRoot: string
  runsRoot: string
  sessionsRoot: string
}

export interface ArchiveResult {
  rawSessions: number
  samples: number
}

const safeId = /^[a-zA-Z0-9._-]+$/
const safeSha256 = /^[a-f0-9]{64}$/u

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && value !== '.' && value !== '..' && safeId.test(value)
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function contentSha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every(key => keys.has(key))
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const valueObject = value as Record<string, unknown>
  return `{${Object.keys(valueObject).sort().map(key => `${JSON.stringify(key)}:${canonical(valueObject[key])}`).join(',')}}`
}

function cohort(report: Record<string, unknown>, caseId: string): string {
  const baseline = object(report.baseline)
  return [baseline.dshVersion, baseline.mythosVersion, baseline.configurationSha256, baseline.variant ?? 'default', caseId]
    .map(value => String(value ?? 'unknown')).join(':')
}

function reportCommitment(report: Record<string, unknown>): Record<string, unknown> {
  const implementation = object(report.implementation)
  const runtime = object(implementation.runtime)
  return {
    endpointSha256: object(runtime.endpoint).sha256 ?? null,
    implementationSha256: implementation.sha256 ?? null,
    parametersSha256: runtime.parametersSha256 ?? null,
  }
}

async function resolveRawSession(productRoot: string, sessionsRoot: string, trustedRoot: string, value: unknown): Promise<string> {
  if (typeof value !== 'string') throw new Error('评测记录的 rawSession 必须是字符串')
  const lexicalPath = resolve(productRoot, value)
  if (!lexicalPath.startsWith(`${sessionsRoot}${sep}`)) throw new Error('rawSession 越出会话根目录')
  const trustedPath = await realpath(lexicalPath)
  if (!trustedPath.startsWith(`${trustedRoot}${sep}`)) throw new Error('rawSession 符号链接越出会话根目录')
  if (!(await stat(trustedPath)).isFile()) throw new Error('rawSession 不是普通文件')
  return trustedPath
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'EEXIST'
}

async function writeImmutable(path: string, content: string): Promise<void> {
  const expected = Buffer.from(content)
  try {
    await writeFile(path, expected, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (!isAlreadyExists(error)) throw error
    if (!(await readFile(path)).equals(expected)) throw new Error(`飞轮不可变文件已被篡改：${path}`)
  }
}

async function copyRawImmutable(source: string, destination: string): Promise<string> {
  const sourceSha256 = await sha256(source)
  try {
    await copyFile(source, destination, constants.COPYFILE_EXCL)
    await chmod(destination, 0o600)
  } catch (error) {
    if (!isAlreadyExists(error)) throw error
  }
  if (await sha256(destination) !== sourceSha256) throw new Error(`飞轮原始会话副本与来源不一致：${destination}`)
  return sourceSha256
}

function verifyV2RawMetrics(source: string, testCase: Record<string, unknown>): void {
  const observed = readCompressedSessionMetrics(source)
  const metrics = typeof testCase.metrics === 'object' && testCase.metrics !== null ? testCase.metrics as Record<string, unknown> : {}
  const billing = typeof testCase.billing === 'object' && testCase.billing !== null ? testCase.billing as Record<string, unknown> : {}
  const tokens = typeof billing.tokens === 'object' && billing.tokens !== null ? billing.tokens as Record<string, unknown> : {}
  if (metrics.inputTokens !== observed.inputTokens || metrics.outputTokens !== observed.outputTokens
    || metrics.cacheReadTokens !== observed.cacheReadTokens || metrics.turnReason !== observed.turnReason
    || tokens.input !== observed.inputTokens || tokens.output !== observed.outputTokens || tokens.cache !== observed.cacheReadTokens) {
    throw new Error('v2 评测报告与原始会话指标不一致')
  }
}

export async function archiveFlywheel(options: ArchiveOptions): Promise<ArchiveResult> {
  const productRoot = resolve(options.productRoot)
  const runsRoot = resolve(options.runsRoot)
  const sessionsRoot = resolve(options.sessionsRoot)
  const outputRoot = resolve(options.outputRoot)
  const trustedRoot = await realpath(sessionsRoot)
  const filenames = (await readdir(runsRoot)).filter(name => name.endsWith('.json')).sort()
  const index: Record<string, unknown>[] = []
  let rawSessions = 0

  for (const filename of filenames) {
    const reportContent = await readFile(join(runsRoot, filename), 'utf8')
    const report = parseEvaluationReport(JSON.parse(reportContent))
    const legacy = report.reportVersion === 1
    const runId = report.runId
    if (!isSafeId(runId)) continue
    const runRoot = join(outputRoot, 'runs', runId)
    await mkdir(runRoot, { mode: 0o700, recursive: true })
    const archivedReportPath = join(runRoot, 'report.json')
    await writeImmutable(archivedReportPath, reportContent)
    const reportReference = { path: relative(outputRoot, archivedReportPath), sha256: contentSha256(reportContent) }
    const commitment = reportCommitment(report)
    const cases = Array.isArray(report.cases) ? report.cases : []
    for (const item of cases) {
      if (typeof item !== 'object' || item === null) continue
      const testCase = item as Record<string, unknown>
      const caseId = testCase.id
      if (!isSafeId(caseId)) continue
      const caseRoot = join(outputRoot, 'runs', runId, caseId)
      await mkdir(caseRoot, { mode: 0o700, recursive: true })
      let raw: { byteExact: true, path: string, sha256: string } | null = null
      if (testCase.rawSession !== undefined) {
        const source = await resolveRawSession(productRoot, sessionsRoot, trustedRoot, testCase.rawSession)
        if (!legacy) verifyV2RawMetrics(source, testCase)
        const archivedRawPath = join(caseRoot, 'session.jsonl.zstd')
        raw = { byteExact: true, path: relative(outputRoot, archivedRawPath), sha256: await copyRawImmutable(source, archivedRawPath) }
        rawSessions += 1
      }
      const relatedRaw: { byteExact: true; path: string; sha256: string }[] = []
      if (Array.isArray(testCase.relatedRawSessions)) {
        const relatedRoot = join(caseRoot, 'related')
        await mkdir(relatedRoot, { mode: 0o700, recursive: true })
        for (let index = 0; index < testCase.relatedRawSessions.length; index += 1) {
          const source = await resolveRawSession(productRoot, sessionsRoot, trustedRoot, testCase.relatedRawSessions[index])
          const destination = join(relatedRoot, `session-${index + 1}.jsonl.zstd`)
          relatedRaw.push({ byteExact: true, path: relative(outputRoot, destination), sha256: await copyRawImmutable(source, destination) })
          rawSessions += 1
        }
      }
      const archivedCase = legacy ? {
        accepted: false,
        failure: { category: 'harness_failure', reason: 'legacy_unverified' },
        id: caseId,
        passed: testCase.passed === true,
        ...(testCase.rawSession !== undefined ? { rawSession: testCase.rawSession } : {}),
      } : testCase
      const label = {
        baseline: report.baseline,
        case: archivedCase,
        commitment,
        completedAt: report.completedAt,
        evidenceStatus: legacy ? 'legacy_unverified' : 'v2',
        raw,
        ...(relatedRaw.length > 0 ? { relatedRaw } : {}),
        reportVersion: report.reportVersion,
        replay: report.replay,
        report: reportReference,
        runId,
        startedAt: report.startedAt,
      }
      const labelPath = join(caseRoot, 'label.json')
      const labelContent = `${JSON.stringify(label, null, 2)}\n`
      await writeImmutable(labelPath, labelContent)
      index.push({
        caseId,
        cohort: cohort(report, caseId),
        commitment,
        label: { path: relative(outputRoot, labelPath), sha256: contentSha256(labelContent) },
        raw,
        relatedRaw,
        report: reportReference,
        runId,
      })
    }
  }

  await mkdir(outputRoot, { mode: 0o700, recursive: true })
  const target = join(outputRoot, 'index.jsonl')
  const temporary = `${target}.${process.pid}.tmp`
  const content = index.map(row => JSON.stringify(row)).join('\n') + (index.length ? '\n' : '')
  await writeFile(temporary, content, { mode: 0o600 })
  await rename(temporary, target)
  return { rawSessions, samples: index.length }
}

async function verifiedArchivedPath(root: string, value: unknown): Promise<string> {
  if (typeof value !== 'string' || value === '' || isAbsolute(value) || value.split(/[\\/]/u).includes('..')) {
    throw new Error('归档路径无效')
  }
  const lexical = resolve(root, value)
  if (!lexical.startsWith(`${root}${sep}`)) throw new Error('归档路径越界')
  const trusted = await realpath(lexical)
  if (trusted !== lexical || !trusted.startsWith(`${root}${sep}`) || !(await stat(trusted)).isFile()) {
    throw new Error('归档路径包含符号链接或不是普通文件')
  }
  return trusted
}

async function verifiedContent(root: string, reference: Record<string, unknown>, kind: string): Promise<{ content: string; path: string }> {
  if (typeof reference.sha256 !== 'string' || !safeSha256.test(reference.sha256)) throw new Error(`${kind} digest 无效`)
  const path = await verifiedArchivedPath(root, reference.path)
  const content = await readFile(path, 'utf8')
  if (contentSha256(content) !== reference.sha256) throw new Error(`${kind} 内容摘要不一致`)
  return { content, path }
}

async function verifyRawReference(root: string, reference: Record<string, unknown>, kind: string): Promise<string> {
  if (typeof reference.sha256 !== 'string' || !safeSha256.test(reference.sha256)) throw new Error(`${kind} digest 无效`)
  const path = await verifiedArchivedPath(root, reference.path)
  if (await sha256(path) !== reference.sha256) throw new Error(`${kind} 内容摘要不一致`)
  return path
}

/**
 * Revalidates the content-addressed archive before gate use. This detects accidental or partial mutation,
 * but is not a signature trust root against a host controller that can rewrite code and every manifest.
 */
export async function readArchivedLabels(dataRoot: string): Promise<Record<string, unknown>[]> {
  const root = await realpath(resolve(dataRoot))
  const indexPath = await verifiedArchivedPath(root, 'index.jsonl')
  const rows = (await readFile(indexPath, 'utf8')).split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
  const seen = new Set<string>()
  const labels: Record<string, unknown>[] = []
  for (const row of rows) {
    const caseId = row.caseId
    const runId = row.runId
    if (!hasOnlyKeys(row, ['caseId', 'cohort', 'commitment', 'label', 'raw', 'relatedRaw', 'report', 'runId'])
      || !isSafeId(caseId) || !isSafeId(runId) || typeof row.cohort !== 'string') throw new Error('归档索引身份字段无效')
    const identity = `${runId}:${caseId}`
    if (seen.has(identity)) throw new Error('归档索引存在重复 case')
    seen.add(identity)

    const reportReference = object(row.report)
    const labelReference = object(row.label)
    const [{ content: reportContent }, { content: labelContent }] = await Promise.all([
      verifiedContent(root, reportReference, 'report'), verifiedContent(root, labelReference, 'label'),
    ])
    const report = parseEvaluationReport(JSON.parse(reportContent))
    const label = object(JSON.parse(labelContent))
    if (!hasOnlyKeys(label, ['baseline', 'case', 'commitment', 'completedAt', 'evidenceStatus', 'raw', 'relatedRaw', 'replay',
      'report', 'reportVersion', 'runId', 'startedAt'])
      || report.runId !== runId || label.runId !== runId || label.reportVersion !== report.reportVersion
      || canonical(label.report) !== canonical(reportReference) || canonical(label.commitment) !== canonical(row.commitment)) {
      throw new Error('归档 report/label/index 绑定不一致')
    }
    const reportCases = Array.isArray(report.cases) ? report.cases.map(object).filter(item => item.id === caseId) : []
    if (reportCases.length !== 1 || object(label.case).id !== caseId || cohort(report, caseId) !== row.cohort) {
      throw new Error('归档 case/cohort 绑定不一致')
    }
    const reportCase = reportCases[0]!
    const legacy = report.reportVersion === 1
    const expectedCase = legacy ? {
      accepted: false,
      failure: { category: 'harness_failure', reason: 'legacy_unverified' },
      id: caseId,
      passed: reportCase.passed === true,
      ...(reportCase.rawSession !== undefined ? { rawSession: reportCase.rawSession } : {}),
    } : reportCase
    if (canonical(label.case) !== canonical(expectedCase) || canonical(row.commitment) !== canonical(reportCommitment(report))) {
      throw new Error('归档 case/commitment 内容不一致')
    }
    if (!legacy && canonical(authoritativeCaseSemantics(reportCase)) !== canonical({
      accepted: reportCase.accepted, capabilityEligible: reportCase.capabilityEligible, failure: reportCase.failure,
    })) throw new Error('归档 case 权威语义不一致')

    const rawReference = row.raw === null ? null : object(row.raw)
    const labelRaw = label.raw === null ? null : object(label.raw)
    if (canonical(rawReference) !== canonical(labelRaw)) throw new Error('归档 raw 绑定不一致')
    if (rawReference) {
      const rawPath = await verifyRawReference(root, rawReference, 'raw session')
      if (!legacy) verifyV2RawMetrics(rawPath, reportCase)
    }
    const related = Array.isArray(row.relatedRaw) ? row.relatedRaw.map(object) : []
    if (canonical(related) !== canonical(Array.isArray(label.relatedRaw) ? label.relatedRaw : [])) {
      throw new Error('归档 related raw 绑定不一致')
    }
    await Promise.all(related.map((reference, index) => verifyRawReference(root, reference, `related raw ${index + 1}`)))
    labels.push(label)
  }
  return labels
}
