import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

type ObjectValue = Record<string, unknown>

export interface EvalAttribution {
  baseline: ObjectValue
  caseId: string
  passed: boolean
  reason: string
  runId: string
  startedAt: string
}

export interface ProductSession {
  eval?: EvalAttribution
  rawSession: string
  sessionId: string
  updatedAt: string
}

export interface CuratedSession {
  billingModes: string[]
  classification: 'eval-failure' | 'golden' | 'low-evidence' | 'review'
  contentCoverage: number
  evidenceRefs: Array<{
    eventId: string
    requestRef: string | null
    responseRef: string | null
  }>
  eval?: EvalAttribution
  exactEvidenceCoverage: number
  failureReasons: string[]
  firstSeenAt: string
  identities: {
    apiKeys: unknown[]
    users: unknown[]
  }
  inputTokens: number
  lastSeenAt: string
  models: string[]
  outputTokens: number
  rawSession: string
  rows: number
  sessionId: string
}

export interface CurationSummary {
  classifications: Record<CuratedSession['classification'], number>
  curatedRows: number
  evalSessions: number
  goldenSessions: number
  linkedSessions: number
  productSessions: number
}

export interface CurationGateResult {
  failures: string[]
  passed: boolean
}

function object(value: unknown): ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as ObjectValue
    : {}
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function coverage(count: number, total: number): number {
  return total === 0 ? 0 : count / total
}

function unique(values: unknown[]): unknown[] {
  return [...new Map(values.map(value => [JSON.stringify(value), value])).values()]
}

function sessionIdFromPath(path: string): string | undefined {
  const id = basename(dirname(path))
  return /^session-[a-zA-Z0-9._-]+$/u.test(id) ? id : undefined
}

async function visitSessionFiles(root: string): Promise<string[]> {
  const result: string[] = []
  async function visit(path: string): Promise<void> {
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile() && entry.name === 'session.jsonl.zstd') result.push(child)
    }
  }
  await visit(root)
  return result.sort()
}

async function evalAttributions(productRoot: string, runsRoot: string): Promise<Map<string, EvalAttribution>> {
  const result = new Map<string, EvalAttribution>()
  let filenames: string[] = []
  try {
    filenames = (await readdir(runsRoot)).filter(name => name.endsWith('.json')).sort()
  } catch {
    return result
  }
  for (const filename of filenames) {
    const report = object(JSON.parse(await readFile(join(runsRoot, filename), 'utf8')))
    const runId = typeof report.runId === 'string' ? report.runId : undefined
    const startedAt = typeof report.startedAt === 'string' ? report.startedAt : undefined
    if (!runId || !startedAt || !Array.isArray(report.cases)) continue
    for (const value of report.cases) {
      const testCase = object(value)
      if (typeof testCase.rawSession !== 'string' || typeof testCase.id !== 'string') continue
      const absolute = resolve(productRoot, testCase.rawSession)
      if (!absolute.startsWith(`${productRoot}${sep}`)) continue
      const verification = object(testCase.verification)
      result.set(absolute, {
        baseline: object(report.baseline),
        caseId: testCase.id,
        passed: testCase.passed === true,
        reason: typeof verification.reason === 'string' ? verification.reason : '',
        runId,
        startedAt,
      })
    }
  }
  return result
}

export async function buildProductSessionRegistry(options: {
  productRoot: string
  runsRoot: string
  sessionsRoot: string
}): Promise<ProductSession[]> {
  const productRoot = resolve(options.productRoot)
  const sessionsRoot = resolve(options.sessionsRoot)
  if (!sessionsRoot.startsWith(`${productRoot}${sep}`)) throw new Error('sessionsRoot 必须位于产品目录内')
  const [files, evals] = await Promise.all([
    visitSessionFiles(sessionsRoot),
    evalAttributions(productRoot, resolve(options.runsRoot)),
  ])
  const sessions: ProductSession[] = []
  for (const path of files) {
    const sessionId = sessionIdFromPath(path)
    if (!sessionId) continue
    const metadata = await stat(path)
    const evaluation = evals.get(path)
    sessions.push({
      ...(evaluation ? { eval: evaluation } : {}),
      rawSession: relative(productRoot, path),
      sessionId,
      updatedAt: metadata.mtime.toISOString(),
    })
  }
  return sessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId))
}

export function curateProductSessions(
  rows: readonly ObjectValue[],
  registry: readonly ProductSession[],
): CuratedSession[] {
  const products = new Map(registry.map(session => [session.sessionId, session]))
  const groups = new Map<string, ObjectValue[]>()
  for (const row of rows) {
    const correlation = object(row.correlation)
    const sessionId = correlation.harnessSessionId
    if (typeof sessionId !== 'string' || !products.has(sessionId)) continue
    const group = groups.get(sessionId) ?? []
    group.push(row)
    groups.set(sessionId, group)
  }

  const curated: CuratedSession[] = []
  for (const [sessionId, group] of groups) {
    const product = products.get(sessionId)
    if (!product) continue
    group.sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)))
    let exact = 0
    let withContent = 0
    let inputTokens = 0
    let outputTokens = 0
    const failureReasons: string[] = []
    const evidenceRefs: CuratedSession['evidenceRefs'] = []
    for (const row of group) {
      const evidence = object(row.evidence)
      const content = object(row.content)
      const usage = object(row.usage)
      const telemetry = object(row.agentTelemetry)
      const performance = object(row.performance)
      if (evidence.matchConfidence === 'exact') exact += 1
      if (content.byteExact === true) withContent += 1
      inputTokens += finiteNumber(usage.inputTokens)
      outputTokens += finiteNumber(usage.outputTokens)
      if (telemetry.status === 'error') failureReasons.push(`usage:${String(telemetry.errorReason ?? 'error')}`)
      if (typeof performance.status === 'number' && performance.status >= 400) {
        failureReasons.push(`http:${String(performance.status)}`)
      }
      evidenceRefs.push({
        eventId: String(row.eventId ?? ''),
        requestRef: typeof content.requestRef === 'string' ? content.requestRef : null,
        responseRef: typeof content.responseRef === 'string' ? content.responseRef : null,
      })
    }
    if (product.eval && !product.eval.passed) failureReasons.push(`eval:${product.eval.reason || 'failed'}`)
    const exactEvidenceCoverage = coverage(exact, group.length)
    const contentCoverage = coverage(withContent, group.length)
    const classification: CuratedSession['classification'] = product.eval && !product.eval.passed
      ? 'eval-failure'
      : contentCoverage < 1 || exactEvidenceCoverage < 0.8
        ? 'low-evidence'
        : failureReasons.length > 0
          ? 'review'
          : 'golden'
    curated.push({
      billingModes: unique(group.map(row => object(row.routing).billingMode)).map(String).sort(),
      classification,
      contentCoverage,
      evidenceRefs,
      ...(product.eval ? { eval: product.eval } : {}),
      exactEvidenceCoverage,
      failureReasons: [...new Set(failureReasons)].sort(),
      firstSeenAt: String(group[0]?.occurredAt ?? ''),
      identities: {
        apiKeys: unique(group.map(row => object(row.identities).apiKey)),
        users: unique(group.map(row => object(row.identities).user)),
      },
      inputTokens,
      lastSeenAt: String(group.at(-1)?.occurredAt ?? ''),
      models: unique(group.map(row => object(row.routing).requestedModel)).map(String).sort(),
      outputTokens,
      rawSession: product.rawSession,
      rows: group.length,
      sessionId,
    })
  }
  return curated.sort((a, b) => a.sessionId.localeCompare(b.sessionId))
}

export function summarizeCuration(curated: readonly CuratedSession[], productSessions: number): CurationSummary {
  const classifications: CurationSummary['classifications'] = {
    'eval-failure': 0,
    golden: 0,
    'low-evidence': 0,
    review: 0,
  }
  for (const candidate of curated) classifications[candidate.classification] += 1
  return {
    classifications,
    curatedRows: curated.reduce((sum, candidate) => sum + candidate.rows, 0),
    evalSessions: curated.filter(candidate => candidate.eval !== undefined).length,
    goldenSessions: classifications.golden,
    linkedSessions: curated.length,
    productSessions,
  }
}

export function registrySha256(registry: readonly ProductSession[]): string {
  return createHash('sha256').update(JSON.stringify(registry)).digest('hex')
}

export function evaluateCurationGate(summary: CurationSummary): CurationGateResult {
  const failures: string[] = []
  if (summary.productSessions < 1) failures.push('本地产品会话注册表为空')
  if (summary.linkedSessions < 1) failures.push('没有产品会话与服务器飞轮关联')
  if (summary.evalSessions < 1) failures.push('没有评测会话完成服务器关联')
  if (summary.goldenSessions < 1) failures.push('没有可进入回归候选集的 golden 会话')
  if (summary.curatedRows < 1) failures.push('整理后的服务器调用为空')
  return { failures, passed: failures.length === 0 }
}
