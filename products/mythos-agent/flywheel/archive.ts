import { createHash } from 'node:crypto'
import { createReadStream, constants } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
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

const canonicalId = /^[a-z0-9](?:[a-z0-9_-]{0,127})?$/u
const safeSha256 = /^[a-f0-9]{64}$/u

function isCanonicalId(value: unknown): value is string {
  return typeof value === 'string' && canonicalId.test(value)
}

function requireCanonicalId(value: unknown, kind: string): string {
  if (!isCanonicalId(value)) throw new Error(`${kind} 不是规范标识符`)
  return value
}

function reportArchivePath(runId: string): string {
  return `runs/${runId}/report.json`
}

function caseArchiveRoot(runId: string, caseId: string): string {
  return `runs/${runId}/${caseId}`
}

function labelArchivePath(runId: string, caseId: string): string {
  return `${caseArchiveRoot(runId, caseId)}/label.json`
}

function rawArchivePath(runId: string, caseId: string): string {
  return `${caseArchiveRoot(runId, caseId)}/session.jsonl.zstd`
}

function relatedRawArchivePath(runId: string, caseId: string, index: number): string {
  return `${caseArchiveRoot(runId, caseId)}/related/session-${index + 1}.jsonl.zstd`
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
  const archivedRuns = new Set<string>()
  const evidenceDigests = new Set<string>()
  const evidencePaths = new Set<string>()
  const labelDigests = new Set<string>()
  const labelPaths = new Set<string>()
  let rawSessions = 0

  await mkdir(join(outputRoot, 'runs'), { mode: 0o700, recursive: true })

  for (const filename of filenames) {
    const reportContent = await readFile(join(runsRoot, filename), 'utf8')
    const report = parseEvaluationReport(JSON.parse(reportContent))
    const legacy = report.reportVersion === 1
    const runId = requireCanonicalId(report.runId, 'runId')
    if (archivedRuns.has(runId)) throw new Error('同一归档中 runId 必须唯一')
    archivedRuns.add(runId)
    const runRoot = join(outputRoot, 'runs', runId)
    await mkdir(runRoot, { mode: 0o700, recursive: true })
    const archivedReportPath = join(outputRoot, reportArchivePath(runId))
    await writeImmutable(archivedReportPath, reportContent)
    const reportReference = { path: reportArchivePath(runId), sha256: contentSha256(reportContent) }
    const commitment = reportCommitment(report)
    const cases = Array.isArray(report.cases) ? report.cases : []
    const caseIds = cases.map(item => requireCanonicalId(object(item).id, 'caseId'))
    if (new Set(caseIds).size !== caseIds.length) throw new Error('同一报告中 caseId 必须唯一')
    for (const item of cases) {
      if (typeof item !== 'object' || item === null) throw new Error('评测 case 必须是对象')
      const testCase = item as Record<string, unknown>
      const caseId = requireCanonicalId(testCase.id, 'caseId')
      const caseRoot = join(outputRoot, 'runs', runId, caseId)
      await mkdir(caseRoot, { mode: 0o700, recursive: true })
      let raw: { byteExact: true, path: string, sha256: string } | null = null
      if (testCase.rawSession !== undefined) {
        const source = await resolveRawSession(productRoot, sessionsRoot, trustedRoot, testCase.rawSession)
        if (!legacy) verifyV2RawMetrics(source, testCase)
        const archivePath = rawArchivePath(runId, caseId)
        const archivedRawPath = join(outputRoot, archivePath)
        const digest = await copyRawImmutable(source, archivedRawPath)
        if (evidencePaths.has(archivePath) || evidenceDigests.has(digest)) throw new Error('raw evidence 必须按 case 唯一')
        evidencePaths.add(archivePath)
        evidenceDigests.add(digest)
        raw = { byteExact: true, path: archivePath, sha256: digest }
        rawSessions += 1
      }
      const relatedRaw: { byteExact: true; path: string; sha256: string }[] = []
      if (Array.isArray(testCase.relatedRawSessions)) {
        const relatedRoot = join(caseRoot, 'related')
        await mkdir(relatedRoot, { mode: 0o700, recursive: true })
        for (let index = 0; index < testCase.relatedRawSessions.length; index += 1) {
          const source = await resolveRawSession(productRoot, sessionsRoot, trustedRoot, testCase.relatedRawSessions[index])
          const archivePath = relatedRawArchivePath(runId, caseId, index)
          const destination = join(outputRoot, archivePath)
          const digest = await copyRawImmutable(source, destination)
          if (evidencePaths.has(archivePath) || evidenceDigests.has(digest)) throw new Error('raw evidence 必须按 case 唯一')
          evidencePaths.add(archivePath)
          evidenceDigests.add(digest)
          relatedRaw.push({ byteExact: true, path: archivePath, sha256: digest })
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
      const archivedLabelPath = labelArchivePath(runId, caseId)
      const labelSha256 = contentSha256(labelContent)
      if (labelPaths.has(archivedLabelPath) || labelDigests.has(labelSha256)) throw new Error('label 必须按 case 唯一')
      labelPaths.add(archivedLabelPath)
      labelDigests.add(labelSha256)
      index.push({
        caseId,
        cohort: cohort(report, caseId),
        commitment,
        label: { path: archivedLabelPath, sha256: labelSha256 },
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
  if (!hasOnlyKeys(reference, ['path', 'sha256']) || typeof reference.sha256 !== 'string' || !safeSha256.test(reference.sha256)) {
    throw new Error(`${kind} reference 无效`)
  }
  const path = await verifiedArchivedPath(root, reference.path)
  const content = await readFile(path, 'utf8')
  if (contentSha256(content) !== reference.sha256) throw new Error(`${kind} 内容摘要不一致`)
  return { content, path }
}

async function verifyRawReference(root: string, reference: Record<string, unknown>, kind: string): Promise<string> {
  if (!hasOnlyKeys(reference, ['byteExact', 'path', 'sha256']) || reference.byteExact !== true
    || typeof reference.sha256 !== 'string' || !safeSha256.test(reference.sha256)) throw new Error(`${kind} reference 无效`)
  const path = await verifiedArchivedPath(root, reference.path)
  if (await sha256(path) !== reference.sha256) throw new Error(`${kind} 内容摘要不一致`)
  return path
}

function requireReferencePath(reference: Record<string, unknown>, expected: string, kind: string): void {
  if (reference.path !== expected) throw new Error(`${kind} 不在规范证据路径`)
}

interface ReportGroup {
  expectedCaseIds: Set<string>
  reportReference: Record<string, unknown>
  seenCaseIds: Set<string>
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
  const groups = new Map<string, ReportGroup>()
  const reportOwners = new Map<string, string>()
  const evidenceDigests = new Set<string>()
  const evidencePaths = new Set<string>()
  const labelDigests = new Set<string>()
  const labelPaths = new Set<string>()
  const labels: Record<string, unknown>[] = []
  for (const row of rows) {
    const caseId = row.caseId
    const runId = row.runId
    if (!hasOnlyKeys(row, ['caseId', 'cohort', 'commitment', 'label', 'raw', 'relatedRaw', 'report', 'runId'])
      || !isCanonicalId(caseId) || !isCanonicalId(runId) || typeof row.cohort !== 'string') throw new Error('归档索引身份字段无效')
    const identity = `${runId}:${caseId}`
    if (seen.has(identity)) throw new Error('归档索引存在重复 case')
    seen.add(identity)

    const reportReference = object(row.report)
    const labelReference = object(row.label)
    requireReferencePath(reportReference, reportArchivePath(runId), 'report')
    requireReferencePath(labelReference, labelArchivePath(runId, caseId), 'label')
    if (typeof labelReference.sha256 !== 'string' || labelPaths.has(labelReference.path as string)
      || labelDigests.has(labelReference.sha256)) throw new Error('归档 label 路径或内容不唯一')
    labelPaths.add(labelReference.path as string)
    labelDigests.add(labelReference.sha256)
    const reportOwner = reportOwners.get(reportReference.path as string)
    if (reportOwner !== undefined && reportOwner !== runId) throw new Error('归档 report 不得跨 run 共享')
    reportOwners.set(reportReference.path as string, runId)
    const [{ content: reportContent }, { content: labelContent }] = await Promise.all([
      verifiedContent(root, reportReference, 'report'), verifiedContent(root, labelReference, 'label'),
    ])
    const report = parseEvaluationReport(JSON.parse(reportContent))
    const reportCases = Array.isArray(report.cases) ? report.cases.map(object) : []
    const expectedCaseIds = reportCases.map(item => requireCanonicalId(item.id, 'report caseId'))
    if (new Set(expectedCaseIds).size !== expectedCaseIds.length) throw new Error('report caseId 不唯一')
    const existingGroup = groups.get(runId)
    if (existingGroup) {
      if (canonical(existingGroup.reportReference) !== canonical(reportReference)) throw new Error('同一 run 的 report 绑定不一致')
      existingGroup.seenCaseIds.add(caseId)
    } else {
      groups.set(runId, { expectedCaseIds: new Set(expectedCaseIds), reportReference, seenCaseIds: new Set([caseId]) })
    }
    const label = object(JSON.parse(labelContent))
    if (!hasOnlyKeys(label, ['baseline', 'case', 'commitment', 'completedAt', 'evidenceStatus', 'raw', 'relatedRaw', 'replay',
      'report', 'reportVersion', 'runId', 'startedAt'])
      || report.runId !== runId || label.runId !== runId || label.reportVersion !== report.reportVersion
      || canonical(label.report) !== canonical(reportReference) || canonical(label.commitment) !== canonical(row.commitment)) {
      throw new Error('归档 report/label/index 绑定不一致')
    }
    const matchingCases = reportCases.filter(item => item.id === caseId)
    if (matchingCases.length !== 1 || object(label.case).id !== caseId || cohort(report, caseId) !== row.cohort) {
      throw new Error('归档 case/cohort 绑定不一致')
    }
    const reportCase = matchingCases[0]!
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
      requireReferencePath(rawReference, rawArchivePath(runId, caseId), 'raw session')
      if (typeof rawReference.sha256 !== 'string' || evidencePaths.has(rawReference.path as string)
        || evidenceDigests.has(rawReference.sha256)) throw new Error('归档 raw evidence 路径或内容不唯一')
      evidencePaths.add(rawReference.path as string)
      evidenceDigests.add(rawReference.sha256)
      const rawPath = await verifyRawReference(root, rawReference, 'raw session')
      if (!legacy) verifyV2RawMetrics(rawPath, reportCase)
    }
    const related = Array.isArray(row.relatedRaw) ? row.relatedRaw.map(object) : []
    if (canonical(related) !== canonical(Array.isArray(label.relatedRaw) ? label.relatedRaw : [])) {
      throw new Error('归档 related raw 绑定不一致')
    }
    for (let index = 0; index < related.length; index += 1) {
      const reference = related[index]!
      requireReferencePath(reference, relatedRawArchivePath(runId, caseId, index), `related raw ${index + 1}`)
      if (typeof reference.sha256 !== 'string' || evidencePaths.has(reference.path as string)
        || evidenceDigests.has(reference.sha256)) throw new Error('归档 raw evidence 路径或内容不唯一')
      evidencePaths.add(reference.path as string)
      evidenceDigests.add(reference.sha256)
      await verifyRawReference(root, reference, `related raw ${index + 1}`)
    }
    labels.push(label)
  }
  for (const [runId, group] of groups) {
    if (group.expectedCaseIds.size !== group.seenCaseIds.size
      || [...group.expectedCaseIds].some(caseId => !group.seenCaseIds.has(caseId))) {
      throw new Error(`归档索引未完整覆盖 report case 集：${runId}`)
    }
  }
  const runsPath = join(root, 'runs')
  const runEntries = await readdir(runsPath, { withFileTypes: true })
  const archivedRunIds = new Set<string>()
  for (const entry of runEntries) {
    if (!entry.isDirectory() || !isCanonicalId(entry.name)) throw new Error('归档包含非规范 run 目录')
    const reportPath = reportArchivePath(entry.name)
    await verifiedArchivedPath(root, reportPath)
    archivedRunIds.add(entry.name)
  }
  if (archivedRunIds.size !== groups.size || [...archivedRunIds].some(runId => !groups.has(runId))) {
    throw new Error('归档索引与 report run 集不完整')
  }
  return labels
}
