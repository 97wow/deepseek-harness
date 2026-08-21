import { appendFileSync } from 'node:fs'
import { observeM3ProviderPayloads, observeM3ProviderResponse, type ProviderResponseObservation } from './runtime-evidence.js'

export const name = 'mythos-runtime-evidence-observer'

function ssePayloads(data: string): unknown[] {
  const result: unknown[] = []
  for (const event of data.replaceAll('\r\n', '\n').split('\n\n')) {
    const payload = event.split('\n').filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart()).join('\n')
    if (payload === '' || payload === '[DONE]') continue
    try { result.push(JSON.parse(payload)) } catch { /* malformed payload remains the adapter's responsibility */ }
  }
  return result
}

export function apply(ctx: { effect(callback: () => void): void }): void {
  const output = process.env.MYTHOS_RUNTIME_EVIDENCE_PATH
  if (output === undefined || output === '') return
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init)
    if (!response.ok || response.body === null) return response
    let path: string
    try { path = new URL(input instanceof Request ? input.url : String(input)).pathname }
    catch { return response }
    if (!path.endsWith('/chat/completions')) return response
    const decoder = new TextDecoder()
    let pending = ''
    const observations: ProviderResponseObservation[] = []
    const consumeCompleteEvents = () => {
      const normalized = pending.replaceAll('\r\n', '\n')
      const boundary = normalized.lastIndexOf('\n\n')
      if (boundary < 0) return
      observations.push(...ssePayloads(normalized.slice(0, boundary + 2)).map(observeM3ProviderResponse))
      pending = normalized.slice(boundary + 2)
    }
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true })
        consumeCompleteEvents()
        controller.enqueue(chunk)
      },
      flush() {
        pending += decoder.decode()
        consumeCompleteEvents()
        const observation = observeM3ProviderPayloads(observations)
        appendFileSync(output, `${JSON.stringify(observation)}\n`, { encoding: 'utf8', mode: 0o600 })
        pending = ''
        observations.length = 0
      },
    })
    return new Response(response.body.pipeThrough(transform), {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    })
  }
  ctx.effect(() => { globalThis.fetch = originalFetch })
}
