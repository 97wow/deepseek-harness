import { describe, expect, it } from 'vitest'
import { parseSessionJsonl } from './session-metrics.js'

describe('parseSessionJsonl', () => {
  it('counts multi-turn resume and compaction boundaries', () => {
    const metrics = parseSessionJsonl([
      JSON.stringify({ type: 'turn/start', data: { turn: 1 } }),
      JSON.stringify({ type: 'session/end-seed', data: {} }),
      JSON.stringify({ type: 'turn/start', data: { turn: 2 } }),
      JSON.stringify({ type: 'compaction/summary', data: {} }),
      JSON.stringify({ type: 'user/message', data: { source: { kind: 'plugin', plugin: 'mythos-experience' } } }),
      '',
    ].join('\n'))
    expect(metrics).toMatchObject({ compactionSummaries: 1, experienceRecoveries: 1, resumeBoundaries: 1, turns: 2 })
  })

  it('只提取聚合指标并忽略内容和损坏行', () => {
    const jsonl = [
      JSON.stringify({ version: 1 }),
      JSON.stringify({
        type: 'assistant/chunk',
        data: { chunk: { type: 'text', text: '敏感原始内容' } },
      }),
      JSON.stringify({
        type: 'assistant/chunk',
        data: {
          chunk: {
            type: 'usage',
            usage: { cacheReadTokens: 3, inputTokens: 100, outputTokens: 20 },
          },
        },
      }),
      JSON.stringify({ type: 'tool/call', data: { name: 'write' } }),
      JSON.stringify({ type: 'tool/call', data: { name: 'read' } }),
      JSON.stringify({ type: 'tool/call', data: { name: 'bash' } }),
      JSON.stringify({
        type: 'tool/result',
        data: {
          message: {
            content: [{
              type: 'tool-result',
              isError: false,
              content: [{ type: 'text', text: 'AssertionError\n[exit code: 1]' }],
            }],
          },
        },
      }),
      JSON.stringify({ type: 'step/end', data: {} }),
      JSON.stringify({ type: 'turn/end', data: { reason: { kind: 'completed' } } }),
      '{broken',
    ].join('\n')

    expect(parseSessionJsonl(jsonl)).toEqual({
      agentIdleObserved: false,
      cacheReadTokens: 3,
      compactionSummaries: 0,
      evidenceAfterMutation: true,
      experienceRecoveries: 0,
      failedToolResults: 1,
      inputTokens: 100,
      mutationCalls: 1,
      maxSubagentCallsPerStep: 0,
      outputTokens: 20,
      resumeBoundaries: 0,
      sessionFlushObserved: false,
      steps: 1,
      toolCalls: { bash: 1, read: 1, write: 1 },
      toolResults: 1,
      turnReason: 'completed',
      turns: 0,
      usageObserved: true,
    })
  })

  it('记录同一模型步骤内的并行子 Agent 调用数', () => {
    const metrics = parseSessionJsonl([
      JSON.stringify({ type: 'tool/call', data: { name: 'subagent' } }),
      JSON.stringify({ type: 'tool/call', data: { name: 'subagent' } }),
      JSON.stringify({ type: 'step/end', data: {} }),
      JSON.stringify({ type: 'tool/call', data: { name: 'subagent' } }),
      JSON.stringify({ type: 'step/end', data: {} }),
    ].join('\n'))
    expect(metrics.maxSubagentCallsPerStep).toBe(2)
  })
})
