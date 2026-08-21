import { homedir } from 'node:os'
import { join } from 'node:path'

interface StreamUsage {
  completion_tokens?: number
  prompt_tokens?: number
  total_tokens?: number
}

const endpoint = 'http://127.0.0.1:18080/v1/chat/completions'
const model = process.env.MYTHOS_QWEN_MODEL_PATH ?? join(
  homedir(),
  'Library',
  'Caches',
  'Mythos',
  'huggingface',
  'models--mlx-community--Qwen3.8-27B-4bit',
  'snapshots',
  '3e6447f082e89cc7f0bc6e5441afd38dfce760ff',
)
const startedAt = performance.now()
const response = await fetch(endpoint, {
  body: JSON.stringify({
    max_tokens: 128,
    messages: [{ role: 'user', content: 'Reply with exactly MYTHOS_LOCAL_OK.' }],
    model,
    reasoning_effort: 'low',
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0,
  }),
  headers: {
    Authorization: 'Bearer mythos-loopback-only',
    'Content-Type': 'application/json',
  },
  method: 'POST',
})
if (!response.ok || !response.body) throw new Error(`本地 Qwen 服务返回 HTTP ${response.status}`)

const reader = response.body.getReader()
const decoder = new TextDecoder()
let buffer = ''
let firstTokenMs: number | undefined
let output = ''
let usage: StreamUsage | undefined
for (;;) {
  const chunk = await reader.read()
  if (chunk.done) break
  buffer += decoder.decode(chunk.value, { stream: true })
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]\r') continue
    const raw = line.slice(6).trim()
    if (raw === '[DONE]' || raw === '') continue
    const event = JSON.parse(raw) as {
      choices?: Array<{ delta?: { content?: string, reasoning_content?: string } }>
      usage?: StreamUsage
    }
    if (event.usage) usage = event.usage
    const delta = event.choices?.[0]?.delta
    const text = delta?.reasoning_content ?? delta?.content ?? ''
    if (text !== '' && firstTokenMs === undefined) firstTokenMs = performance.now() - startedAt
    output += delta?.content ?? ''
  }
}

const result = {
  firstTokenMs: firstTokenMs === undefined ? null : Math.round(firstTokenMs),
  output: output.trim(),
  totalMs: Math.round(performance.now() - startedAt),
  usage: usage ?? null,
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (result.output !== 'MYTHOS_LOCAL_OK') process.exitCode = 1
