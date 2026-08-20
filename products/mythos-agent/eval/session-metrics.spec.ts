import { describe, expect, it } from 'vitest'
import { parseSessionJsonl } from './session-metrics.js'

describe('parseSessionJsonl', () => {
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
      JSON.stringify({ type: 'tool/call', data: { arguments: { secret: true }, name: 'bash' } }),
      JSON.stringify({ type: 'tool/call', data: { name: 'read' } }),
      JSON.stringify({ type: 'tool/call', data: { name: 'bash' } }),
      JSON.stringify({ type: 'tool/result', data: { message: '敏感工具输出' } }),
      JSON.stringify({ type: 'step/end', data: {} }),
      JSON.stringify({ type: 'turn/end', data: { reason: { kind: 'completed' } } }),
      '{broken',
    ].join('\n')

    expect(parseSessionJsonl(jsonl)).toEqual({
      cacheReadTokens: 3,
      inputTokens: 100,
      outputTokens: 20,
      steps: 1,
      toolCalls: { bash: 2, read: 1 },
      toolResults: 1,
      turnReason: 'completed',
    })
  })
})
