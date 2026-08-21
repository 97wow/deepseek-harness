import { execFileSync } from 'node:child_process'

export interface SessionMetrics {
  cacheReadTokens: number
  evidenceAfterMutation: boolean
  failedToolResults: number
  inputTokens: number
  mutationCalls: number
  outputTokens: number
  steps: number
  toolCalls: Record<string, number>
  toolResults: number
  turnReason?: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined
}

function asFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function containsObservedFailure(value: unknown): boolean {
  if (typeof value === 'string') {
    return /(?:^|[\n[])exit(?: code)?(?:\s*[:=]|\s+)\s*[1-9]\d*(?:\]|\n|$)/i.test(value)
  }
  if (Array.isArray(value)) return value.some(containsObservedFailure)
  const item = asRecord(value)
  if (!item) return false
  if (item.isError === true) return true
  return Object.values(item).some(containsObservedFailure)
}

export function parseSessionJsonl(jsonl: string): SessionMetrics {
  const metrics: SessionMetrics = {
    cacheReadTokens: 0,
    evidenceAfterMutation: false,
    failedToolResults: 0,
    inputTokens: 0,
    mutationCalls: 0,
    outputTokens: 0,
    steps: 0,
    toolCalls: {},
    toolResults: 0,
  }

  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue

    let event: Record<string, unknown>
    try {
      const parsed = JSON.parse(line) as unknown
      const record = asRecord(parsed)
      if (!record) continue
      event = record
    } catch {
      continue
    }

    const type = event.type
    const data = asRecord(event.data)

    if (type === 'assistant/chunk') {
      const chunk = asRecord(data?.chunk)
      if (chunk?.type !== 'usage') continue
      const usage = asRecord(chunk.usage)
      metrics.inputTokens += asFiniteNumber(usage?.inputTokens)
      metrics.outputTokens += asFiniteNumber(usage?.outputTokens)
      metrics.cacheReadTokens += asFiniteNumber(usage?.cacheReadTokens)
      continue
    }

    if (type === 'step/end') {
      metrics.steps += 1
      continue
    }

    if (type === 'tool/call') {
      const name = typeof data?.name === 'string' ? data.name : 'unknown'
      metrics.toolCalls[name] = (metrics.toolCalls[name] ?? 0) + 1
      if (name === 'write' || name === 'edit') {
        metrics.mutationCalls += 1
        metrics.evidenceAfterMutation = false
      } else if (metrics.mutationCalls > 0 && (name === 'bash' || name === 'read')) {
        metrics.evidenceAfterMutation = true
      }
      continue
    }

    if (type === 'tool/result') {
      metrics.toolResults += 1
      const message = asRecord(data?.message)
      const content = Array.isArray(message?.content) ? message.content : []
      if (content.some(containsObservedFailure)) {
        metrics.failedToolResults += 1
      }
      continue
    }

    if (type === 'turn/end') {
      const reason = data?.reason
      if (typeof reason === 'string') {
        metrics.turnReason = reason
      } else {
        const reasonRecord = asRecord(reason)
        if (typeof reasonRecord?.kind === 'string') {
          metrics.turnReason = reasonRecord.kind
        }
      }
    }
  }

  return metrics
}

export function readCompressedSessionMetrics(
  sessionPath: string,
  zstdBin = process.env.MYTHOS_ZSTD_BIN ?? 'zstd',
): SessionMetrics {
  const jsonl = execFileSync(zstdBin, ['-q', '-d', '-c', sessionPath], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return parseSessionJsonl(jsonl)
}
