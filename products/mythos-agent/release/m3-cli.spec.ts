import { describe, expect, it } from 'vitest'
import { verifyM3Requests } from './m3-cli.js'

const prompt = 'Read proof.txt.'
const nonce = 'nonce-public-test-value'

function requests(toolCount = 25, includeResult = true) {
  const tools = Array.from({ length: toolCount }, (_, index) => ({
    type: 'function',
    function: { name: index === 0 ? 'read' : `tool-${String(index)}` },
  }))
  return [
    {
      path: '/chat/completions',
      body: {
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: 'You are Mythos Agent.' },
          { role: 'user', content: prompt },
        ],
        tools,
      },
    },
    {
      path: '/chat/completions',
      body: {
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'assistant', tool_calls: [{ id: 'mythos-read-proof', function: { name: 'read' } }] },
          { role: 'tool', tool_call_id: 'mythos-read-proof', content: includeResult ? nonce : 'missing' },
        ],
      },
    },
  ]
}

describe('发布包 M3 CLI wire contract', () => {
  it('接受 M3 persona、25 个工具与 read result 后续请求', () => {
    expect(() => verifyM3Requests(requests(), prompt, nonce)).not.toThrow()
  })

  it('拒绝工具 schema 数量漂移', () => {
    expect(() => verifyM3Requests(requests(24), prompt, nonce)).toThrow('工具 schema 应为 25')
  })

  it('拒绝未把真实 read result 带入后续请求', () => {
    expect(() => verifyM3Requests(requests(25, false), prompt, nonce)).toThrow('缺少真实 read tool result')
  })
})
