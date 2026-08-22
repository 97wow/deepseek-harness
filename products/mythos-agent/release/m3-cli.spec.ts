import { describe, expect, it } from 'vitest'
import { verifyM3Requests } from './m3-cli.js'

const prompt = 'Read proof.txt.'
const nonce = 'nonce-public-test-value'

interface TestRequest {
  body: Record<string, unknown>
  path: string
}

function messages(requestsValue: TestRequest[], index: number): Array<Record<string, unknown>> {
  const value = requestsValue[index]?.body.messages
  if (!Array.isArray(value)) throw new Error('test fixture messages missing')
  return value as Array<Record<string, unknown>>
}

function toolCalls(message: Record<string, unknown>): Array<Record<string, unknown>> {
  if (!Array.isArray(message.tool_calls)) throw new Error('test fixture tool_calls missing')
  return message.tool_calls as Array<Record<string, unknown>>
}

function requests(toolCount = 25, includeResult = true): TestRequest[] {
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
          { role: 'assistant', tool_calls: [{
            id: 'mythos-read-proof',
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ file_path: 'proof.txt' }) },
          }] },
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
    expect(() => verifyM3Requests(requests(25, false), prompt, nonce)).toThrow('关联的真实 tool result')
  })

  it('拒绝 persona 使用错误 role', () => {
    const wire = requests()
    messages(wire, 0)[0]!.role = 'user'
    expect(() => verifyM3Requests(wire, prompt, nonce)).toThrow('正确 role 的 MYTHOS persona')
  })

  it('拒绝用户 prompt 使用错误 role', () => {
    const wire = requests()
    messages(wire, 0)[1]!.role = 'assistant'
    expect(() => verifyM3Requests(wire, prompt, nonce)).toThrow('正确 role 的用户 prompt')
  })

  it('拒绝缺少 assistant tool_calls', () => {
    const wire = requests()
    delete messages(wire, 1)[0]!.tool_calls
    expect(() => verifyM3Requests(wire, prompt, nonce)).toThrow('缺少 assistant read tool call')
  })

  it('拒绝 assistant tool_calls 中没有 read', () => {
    const wire = requests()
    const call = toolCalls(messages(wire, 1)[0]!)[0]!
    call.function = { name: 'write', arguments: JSON.stringify({ file_path: 'proof.txt' }) }
    expect(() => verifyM3Requests(wire, prompt, nonce)).toThrow('不是 read')
  })

  it('拒绝 read arguments 指向其他文件', () => {
    const wire = requests()
    const call = toolCalls(messages(wire, 1)[0]!)[0]!
    const implementation = call.function as Record<string, unknown>
    implementation.arguments = JSON.stringify({ file_path: 'other.txt' })
    expect(() => verifyM3Requests(wire, prompt, nonce)).toThrow('未指向 proof.txt')
  })

  it('拒绝 tool_call_id 未关联 read call', () => {
    const wire = requests()
    messages(wire, 1)[1]!.tool_call_id = 'different-call'
    expect(() => verifyM3Requests(wire, prompt, nonce)).toThrow('关联的真实 tool result')
  })

  it('拒绝 nonce 仅出现在非 tool 消息', () => {
    const wire = requests(25, false)
    messages(wire, 1).push({ role: 'user', content: nonce })
    expect(() => verifyM3Requests(wire, prompt, nonce)).toThrow('关联的真实 tool result')
  })

  it('拒绝 read tool call 的 type 不是 function', () => {
    const wire = requests()
    toolCalls(messages(wire, 1)[0]!)[0]!.type = 'not-a-function'
    expect(() => verifyM3Requests(wire, prompt, nonce)).toThrow('type 必须为 function')
  })

  it('拒绝 tool result 位于 assistant read call 之前', () => {
    const wire = requests()
    messages(wire, 1).reverse()
    expect(() => verifyM3Requests(wire, prompt, nonce)).toThrow('必须位于 assistant read tool call 之后')
  })

  it('拒绝重复 ID 或多 call 造成的关联多义性', () => {
    const wire = requests()
    const calls = toolCalls(messages(wire, 1)[0]!)
    calls.push(structuredClone(calls[0]!))
    expect(() => verifyM3Requests(wire, prompt, nonce)).toThrow('tool call 数量不是 1')
  })

  it('拒绝同一 read call 的重复 tool result', () => {
    const wire = requests()
    messages(wire, 1).push(structuredClone(messages(wire, 1)[1]!))
    expect(() => verifyM3Requests(wire, prompt, nonce)).toThrow('tool result 数量不是 1')
  })
})
