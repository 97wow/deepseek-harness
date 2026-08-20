import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildProductSessionRegistry,
  curateProductSessions,
  evaluateCurationGate,
  summarizeCuration,
  type ProductSession,
} from './session-curation.js'

function serverRow(sessionId: string, options: {
  content?: boolean
  exact?: boolean
  status?: number
} = {}): Record<string, unknown> {
  return {
    agentTelemetry: { status: options.status && options.status >= 400 ? 'error' : 'success' },
    content: options.content === false ? null : { byteExact: true, requestRef: 'req.gz', responseRef: 'resp.gz' },
    correlation: { harnessSessionId: sessionId },
    economics: {},
    eventId: `event-${sessionId}`,
    evidence: { matchConfidence: options.exact === false ? 'medium' : 'exact' },
    identities: { apiKey: 2, user: 1 },
    occurredAt: '2026-08-21T00:00:00+08:00',
    performance: { status: options.status ?? 200 },
    routing: { billingMode: 'subscription', requestedModel: 'deepseek-v4-flash' },
    usage: { inputTokens: 10, outputTokens: 2 },
  }
}

describe('Mythos 产品会话整理', () => {
  it('只关联产品注册表中的 DSH 会话并保留原始引用', () => {
    const registry: ProductSession[] = [{
      rawSession: 'home/sessions/x/session-product/session.jsonl.zstd',
      sessionId: 'session-product',
      updatedAt: '2026-08-21T00:00:00Z',
    }]
    const curated = curateProductSessions([
      serverRow('session-product'),
      serverRow('session-other'),
    ], registry)
    expect(curated).toHaveLength(1)
    expect(curated[0]).toMatchObject({
      classification: 'golden',
      contentCoverage: 1,
      exactEvidenceCoverage: 1,
      inputTokens: 10,
      outputTokens: 2,
      sessionId: 'session-product',
    })
    expect(curated[0]?.evidenceRefs).toEqual([{ eventId: 'event-session-product', requestRef: 'req.gz', responseRef: 'resp.gz' }])
  })

  it('失败评测不会进入 golden，证据不足单独隔离', () => {
    const failed: ProductSession = {
      eval: { baseline: {}, caseId: 'case', passed: false, reason: 'verification failed', runId: 'run', startedAt: 'now' },
      rawSession: 'failed', sessionId: 'session-failed', updatedAt: 'now',
    }
    const low: ProductSession = { rawSession: 'low', sessionId: 'session-low', updatedAt: 'now' }
    const curated = curateProductSessions([
      serverRow('session-failed'),
      serverRow('session-low', { exact: false }),
    ], [failed, low])
    expect(curated.map(item => item.classification)).toEqual(['eval-failure', 'low-evidence'])
    expect(curated[0]?.failureReasons).toEqual(['eval:verification failed'])
    expect(summarizeCuration(curated, 2)).toMatchObject({
      classifications: { 'eval-failure': 1, golden: 0, 'low-evidence': 1, review: 0 },
      evalSessions: 1,
      linkedSessions: 2,
    })
    expect(evaluateCurationGate(summarizeCuration(curated, 2))).toMatchObject({
      failures: ['没有可进入回归候选集的 golden 会话'],
      passed: false,
    })
  })

  it('从私有 DSH_HOME 和评测报告建立产品会话注册表', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mythos-registry-'))
    const sessions = join(root, 'home', 'sessions', 'workspace', 'session-abc')
    const runs = join(root, 'runs')
    await mkdir(sessions, { recursive: true })
    await mkdir(runs, { recursive: true })
    const raw = join(sessions, 'session.jsonl.zstd')
    await writeFile(raw, 'raw')
    await writeFile(join(runs, 'run.json'), JSON.stringify({
      baseline: { mythosVersion: '0.1.0' },
      cases: [{
        id: 'exact-file', passed: true,
        rawSession: 'home/sessions/workspace/session-abc/session.jsonl.zstd',
        verification: { reason: 'ok' },
      }],
      runId: 'run-1', startedAt: '2026-08-21T00:00:00Z',
    }))
    await expect(buildProductSessionRegistry({ productRoot: root, runsRoot: runs, sessionsRoot: join(root, 'home', 'sessions') }))
      .resolves.toMatchObject([{
        eval: { caseId: 'exact-file', passed: true, runId: 'run-1' },
        sessionId: 'session-abc',
      }])
  })
})
