import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'

type ObjectValue = Record<string, unknown>

export interface ServerDatasetHealth {
  artifact: {
    contentIncluded: boolean
    identityMode: string
    rows: number
    sha256: string
  }
  generatedAt: string
  schemaVersion: number
  status: string
}

export interface ServerDatasetManifest {
  byteExact: true
  datasetSha256: string
  health: ServerDatasetHealth
  importedAt: string
  rows: number
  source: string
}

export interface ServerDatasetSummary {
  anthropicRows: number
  authorizationLeaks: number
  completeEvidenceCoverage: number
  contentCoverage: number
  deepseekM3Rows: number
  economicsCoverage: number
  exactEvidenceCoverage: number
  gptRows: number
  harnessSessionRows: number
  rawIdentityCoverage: number
  rows: number
  tokenBillingCoverage: number
  usageCoverage: number
}

export interface ServerGateResult {
  failures: string[]
  passed: boolean
}

function object(value: unknown, label: string): ObjectValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} 必须是对象`)
  return value as ObjectValue
}

function nonEmptyText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} 必须是非空字符串`)
  return value
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} 必须是有限数字`)
  return value
}

function coverage(count: number, total: number): number {
  return total === 0 ? 0 : count / total
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

export function parseServerRow(line: string, lineNumber: number): ObjectValue {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error(`服务器飞轮第 ${String(lineNumber)} 行不是合法 JSON`)
  }
  const row = object(value, `服务器飞轮第 ${String(lineNumber)} 行`)
  finiteNumber(row.schemaVersion, 'schemaVersion')
  nonEmptyText(row.occurredAt, 'occurredAt')
  object(row.correlation, 'correlation')
  object(row.identities, 'identities')
  const routing = object(row.routing, 'routing')
  nonEmptyText(routing.requestedModel, 'routing.requestedModel')
  nonEmptyText(routing.billingMode, 'routing.billingMode')
  const usage = object(row.usage, 'usage')
  finiteNumber(usage.inputTokens, 'usage.inputTokens')
  finiteNumber(usage.outputTokens, 'usage.outputTokens')
  const economics = object(row.economics, 'economics')
  nonEmptyText(economics.standardCostUSD, 'economics.standardCostUSD')
  nonEmptyText(economics.chargedCostUSD, 'economics.chargedCostUSD')
  nonEmptyText(row.contentPolicy, 'contentPolicy')
  if (row.evidence !== null) object(row.evidence, 'evidence')
  if (row.content !== null) object(row.content, 'content')
  return row
}

export function parseServerDataset(data: string): ObjectValue[] {
  const lines = data.split('\n').filter(line => line.trim() !== '')
  if (lines.length === 0) throw new Error('服务器飞轮数据集为空')
  return lines.map((line, index) => parseServerRow(line, index + 1))
}

function hasRedactedAuthorization(evidence: ObjectValue): { leak: boolean, present: boolean } {
  const request = evidence.request
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return { leak: false, present: false }
  const headers = (request as ObjectValue).headers
  if (!Array.isArray(headers)) return { leak: false, present: false }
  for (let index = 0; index < headers.length - 1; index += 2) {
    if (String(headers[index]).toLowerCase() !== 'authorization') continue
    return {
      leak: !/^Bearer \[REDACTED sha256=[a-f0-9]{64}\]$/u.test(String(headers[index + 1])),
      present: true,
    }
  }
  return { leak: false, present: false }
}

export function analyzeServerDataset(rows: readonly ObjectValue[]): ServerDatasetSummary {
  let anthropicRows = 0
  let authorizationLeaks = 0
  let completeEvidence = 0
  let content = 0
  let deepseekM3Rows = 0
  let economics = 0
  let exactEvidence = 0
  let gptRows = 0
  let harnessSessions = 0
  let rawIdentity = 0
  let tokenBilling = 0
  let usage = 0

  for (const row of rows) {
    const routing = object(row.routing, 'routing')
    const requestedModel = String(routing.requestedModel).toLowerCase()
    if (requestedModel === 'deepseek-v4-flash') deepseekM3Rows += 1
    if (requestedModel.startsWith('gpt-')) gptRows += 1
    if (requestedModel.includes('claude') || requestedModel.includes('anthropic')) anthropicRows += 1
    if (routing.billingMode === 'token') tokenBilling += 1
    if (row.contentPolicy === 'full_fidelity_business_data_credentials_redacted') rawIdentity += 1

    const rowUsage = object(row.usage, 'usage')
    if (typeof rowUsage.inputTokens === 'number' && typeof rowUsage.outputTokens === 'number') usage += 1
    const rowEconomics = object(row.economics, 'economics')
    if (rowEconomics.standardCostUSD !== null && rowEconomics.chargedCostUSD !== null
      && rowEconomics.providerEstimatedCostUSD !== null) economics += 1

    const correlation = object(row.correlation, 'correlation')
    if (typeof correlation.harnessSessionId === 'string' && correlation.harnessSessionId !== '') harnessSessions += 1
    if (row.content !== null) {
      const rowContent = object(row.content, 'content')
      if (rowContent.byteExact === true) content += 1
    }
    if (row.evidence !== null) {
      const evidence = object(row.evidence, 'evidence')
      if (evidence.matchConfidence === 'exact') exactEvidence += 1
      const request = evidence.request
      const response = evidence.response
      if (typeof request === 'object' && request !== null && !Array.isArray(request)
        && typeof response === 'object' && response !== null && !Array.isArray(response)
        && (request as ObjectValue).complete === true && (response as ObjectValue).complete === true) {
        completeEvidence += 1
      }
      if (hasRedactedAuthorization(evidence).leak) authorizationLeaks += 1
    }
  }

  const total = rows.length
  return {
    anthropicRows,
    authorizationLeaks,
    completeEvidenceCoverage: coverage(completeEvidence, total),
    contentCoverage: coverage(content, total),
    deepseekM3Rows,
    economicsCoverage: coverage(economics, total),
    exactEvidenceCoverage: coverage(exactEvidence, total),
    gptRows,
    harnessSessionRows: harnessSessions,
    rawIdentityCoverage: coverage(rawIdentity, total),
    rows: total,
    tokenBillingCoverage: coverage(tokenBilling, total),
    usageCoverage: coverage(usage, total),
  }
}

export function evaluateServerGate(
  summary: ServerDatasetSummary,
  health: ServerDatasetHealth,
): ServerGateResult {
  const failures: string[] = []
  if (health.status !== 'ok') failures.push(`对账状态为 ${health.status}`)
  if (!health.artifact.contentIncluded) failures.push('对账产物未包含内容引用')
  if (health.artifact.identityMode !== 'raw') failures.push(`身份模式为 ${health.artifact.identityMode}`)
  if (health.artifact.rows !== summary.rows) failures.push('健康报告与数据集行数不一致')
  if (summary.rows < 20) failures.push(`样本量仅 ${String(summary.rows)}`)
  if (summary.tokenBillingCoverage !== 1) failures.push('API token 计费覆盖率不是 100%')
  if (summary.rawIdentityCoverage !== 1) failures.push('原始身份覆盖率不是 100%')
  if (summary.usageCoverage !== 1) failures.push('usage 覆盖率不是 100%')
  if (summary.economicsCoverage !== 1) failures.push('economics 覆盖率不是 100%')
  if (summary.contentCoverage < 0.8) failures.push(`字节级内容覆盖率 ${summary.contentCoverage.toFixed(4)}`)
  if (summary.exactEvidenceCoverage < 0.8) failures.push(`exact evidence 覆盖率 ${summary.exactEvidenceCoverage.toFixed(4)}`)
  if (summary.completeEvidenceCoverage < 0.85) failures.push(`完整 evidence 覆盖率 ${summary.completeEvidenceCoverage.toFixed(4)}`)
  if (summary.deepseekM3Rows < 1) failures.push('缺少 Mythos M3 样本')
  if (summary.gptRows < 1) failures.push('缺少 GPT 样本')
  if (summary.anthropicRows < 1) failures.push('缺少 Anthropic/Claude 样本')
  if (summary.harnessSessionRows < 1) failures.push('缺少 DSH Session 关联样本')
  if (summary.authorizationLeaks !== 0) failures.push(`发现 ${String(summary.authorizationLeaks)} 条未脱敏 Authorization`)
  return { failures, passed: failures.length === 0 }
}

export function parseServerHealth(data: string): ServerDatasetHealth {
  const health = object(JSON.parse(data), '健康报告')
  const artifact = object(health.artifact, '健康报告 artifact')
  return {
    artifact: {
      contentIncluded: artifact.contentIncluded === true,
      identityMode: nonEmptyText(artifact.identityMode, 'artifact.identityMode'),
      rows: finiteNumber(artifact.rows, 'artifact.rows'),
      sha256: nonEmptyText(artifact.sha256, 'artifact.sha256'),
    },
    generatedAt: nonEmptyText(health.generatedAt, 'generatedAt'),
    schemaVersion: finiteNumber(health.schemaVersion, 'schemaVersion'),
    status: nonEmptyText(health.status, 'status'),
  }
}

export async function importServerDataset(options: {
  dataRoot: string
  datasetPath: string
  healthPath: string
}): Promise<{ directory: string, manifest: ServerDatasetManifest }> {
  const source = resolve(options.datasetPath)
  const [data, healthData] = await Promise.all([readFile(source), readFile(resolve(options.healthPath), 'utf8')])
  const rows = parseServerDataset(data.toString('utf8'))
  const health = parseServerHealth(healthData)
  const datasetSha256 = sha256(data)
  if (health.artifact.sha256 !== datasetSha256) throw new Error('健康报告 SHA-256 与服务器飞轮文件不一致')
  if (health.artifact.rows !== rows.length) throw new Error('健康报告行数与服务器飞轮文件不一致')

  const directory = join(resolve(options.dataRoot), 'server', datasetSha256)
  const target = join(directory, 'dataset.ndjson')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    await copyFile(source, target, constants.COPYFILE_EXCL)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (sha256(await readFile(target)) !== datasetSha256) throw new Error('已归档服务器飞轮与相同 SHA 目录冲突')
  }
  const manifest: ServerDatasetManifest = {
    byteExact: true,
    datasetSha256,
    health,
    importedAt: new Date().toISOString(),
    rows: rows.length,
    source,
  }
  const manifestPath = join(directory, 'manifest.json')
  try {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  await writeFile(join(resolve(options.dataRoot), 'server', 'latest.json'), `${JSON.stringify({
    dataset: join(datasetSha256, basename(target)),
    manifest: join(datasetSha256, basename(manifestPath)),
  }, null, 2)}\n`, { mode: 0o600 })
  return { directory, manifest }
}

export async function loadLatestServerDataset(dataRoot: string): Promise<{
  health: ServerDatasetHealth
  rows: ObjectValue[]
}> {
  const serverRoot = join(resolve(dataRoot), 'server')
  const latest = object(JSON.parse(await readFile(join(serverRoot, 'latest.json'), 'utf8')), 'server/latest.json')
  const dataset = nonEmptyText(latest.dataset, 'latest.dataset')
  const manifestPath = nonEmptyText(latest.manifest, 'latest.manifest')
  if (resolve(serverRoot, dataset).startsWith(`${serverRoot}${sep}`) === false
    || resolve(serverRoot, manifestPath).startsWith(`${serverRoot}${sep}`) === false) throw new Error('服务器飞轮 latest 指针越界')
  const [data, manifestData] = await Promise.all([
    readFile(resolve(serverRoot, dataset)),
    readFile(resolve(serverRoot, manifestPath), 'utf8'),
  ])
  const manifest = object(JSON.parse(manifestData), '服务器飞轮 manifest')
  const expectedHash = nonEmptyText(manifest.datasetSha256, 'manifest.datasetSha256')
  if (sha256(data) !== expectedHash) throw new Error('已归档服务器飞轮 SHA-256 校验失败')
  return {
    health: parseServerHealth(JSON.stringify(manifest.health)),
    rows: parseServerDataset(data.toString('utf8')),
  }
}
