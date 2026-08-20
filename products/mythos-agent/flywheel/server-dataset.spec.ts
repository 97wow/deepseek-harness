import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  analyzeServerDataset,
  evaluateServerGate,
  importServerDataset,
  loadLatestServerDataset,
  parseServerDataset,
  type ServerDatasetHealth,
  type ServerDatasetSummary,
} from './server-dataset.js'

function row(model: string, harnessSessionId: string | null = null): Record<string, unknown> {
  return {
    schemaVersion: 2,
    eventId: `event-${model}`,
    occurredAt: '2026-08-21T00:00:00+08:00',
    correlation: { harnessSessionId },
    identities: { user: 1, apiKey: 2, account: 3, group: 4 },
    routing: { requestedModel: model, billingMode: 'token' },
    usage: { inputTokens: 10, outputTokens: 2 },
    economics: {
      standardCostUSD: '0.1',
      chargedCostUSD: '0.05',
      providerEstimatedCostUSD: '0.01',
    },
    evidence: {
      matchConfidence: 'exact',
      request: {
        complete: true,
        headers: ['Authorization', `Bearer [REDACTED sha256=${'a'.repeat(64)}]`],
      },
      response: { complete: true },
    },
    content: { byteExact: true },
    contentPolicy: 'full_fidelity_business_data_credentials_redacted',
  }
}

function health(rows: number, digest = 'a'.repeat(64)): ServerDatasetHealth {
  return {
    artifact: { contentIncluded: true, identityMode: 'raw', rows, sha256: digest },
    generatedAt: '2026-08-21T00:00:00Z',
    schemaVersion: 2,
    status: 'ok',
  }
}

describe('服务器飞轮数据整理', () => {
  it('按实际 schema 校验并统计 M3、GPT、Anthropic 与 DSH 关联', () => {
    const rows = parseServerDataset([
      JSON.stringify(row('deepseek-v4-flash', 'session-1')),
      JSON.stringify(row('gpt-5.6-sol')),
      JSON.stringify(row('anthropic/claude-haiku-4-5')),
    ].join('\n'))
    expect(analyzeServerDataset(rows)).toMatchObject({
      anthropicRows: 1,
      authorizationLeaks: 0,
      contentCoverage: 1,
      deepseekM3Rows: 1,
      gptRows: 1,
      harnessSessionRows: 1,
      rawIdentityCoverage: 1,
      tokenBillingCoverage: 1,
    })
  })

  it('拒绝字段缺失和未脱敏 Authorization', () => {
    expect(() => parseServerDataset('{}')).toThrow('schemaVersion')
    const leaked = row('deepseek-v4-flash')
    const evidence = leaked.evidence as Record<string, unknown>
    const request = evidence.request as Record<string, unknown>
    request.headers = ['Authorization', ['Bearer', 'secret-value-that-must-not-ship'].join(' ')]
    expect(analyzeServerDataset([leaked]).authorizationLeaks).toBe(1)
  })

  it('把 DSH Session 关联作为服务器质量硬门禁', () => {
    const summary: ServerDatasetSummary = {
      anthropicRows: 1,
      authorizationLeaks: 0,
      completeEvidenceCoverage: 0.9,
      contentCoverage: 0.9,
      deepseekM3Rows: 1,
      economicsCoverage: 1,
      exactEvidenceCoverage: 0.9,
      gptRows: 1,
      harnessSessionRows: 1,
      rawIdentityCoverage: 1,
      rows: 20,
      tokenBillingCoverage: 1,
      usageCoverage: 1,
    }
    expect(evaluateServerGate(summary, health(20))).toEqual({ failures: [], passed: true })
    expect(evaluateServerGate({ ...summary, harnessSessionRows: 0 }, health(20))).toMatchObject({
      failures: ['缺少 DSH Session 关联样本'],
      passed: false,
    })
  })

  it('逐字节归档、校验健康报告哈希并可从 latest 重载', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mythos-server-flywheel-'))
    const datasetPath = join(root, 'flywheel.ndjson')
    const healthPath = join(root, 'health.json')
    const data = `${JSON.stringify(row('deepseek-v4-flash', 'session-1'))}\n`
    const digest = createHash('sha256').update(data).digest('hex')
    await writeFile(datasetPath, data)
    await writeFile(healthPath, JSON.stringify(health(1, digest)))
    const imported = await importServerDataset({ dataRoot: join(root, 'data'), datasetPath, healthPath })
    expect(await readFile(join(imported.directory, 'dataset.ndjson'), 'utf8')).toBe(data)
    await expect(loadLatestServerDataset(join(root, 'data'))).resolves.toMatchObject({
      health: { artifact: { sha256: digest } },
      rows: [{ routing: { requestedModel: 'deepseek-v4-flash' } }],
    })
  })
})
