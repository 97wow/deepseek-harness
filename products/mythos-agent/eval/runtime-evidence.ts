import { readFile, rm } from 'node:fs/promises'

const safeToken = /^[a-zA-Z0-9._@/-]+$/u
const supportedCurrencies = new Set(['USD'])
const trustedBillingSources = new Set(['provider_invoice', 'provider_signed_usage'])

export interface ProviderResponseObservation {
  billing: {
    amount: number
    currency: string
    source: 'provider_invoice' | 'provider_signed_usage'
  } | null
  identity: {
    deployment: string
    model: string
    provider: string
  } | null
  source: 'm3_provider_response'
}

export interface CaseRuntimeEvidence {
  agentIdleObserved: boolean
  providerResponses: readonly ProviderResponseObservation[]
  sessionFlushObserved: boolean
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function safeString(value: unknown): string | null {
  return typeof value === 'string' && safeToken.test(value) ? value : null
}

function responseIdentity(value: unknown): ProviderResponseObservation['identity'] {
  const response = record(value)
  const identity = record(response.identity)
  const model = safeString(identity.model ?? response.model)
  const provider = safeString(identity.provider ?? response.provider)
  const deployment = safeString(identity.deployment ?? response.deployment)
  return model !== null && provider !== null && deployment !== null
    ? { deployment, model, provider }
    : null
}

function responseBilling(value: unknown): ProviderResponseObservation['billing'] {
  const response = record(value)
  const billing = record(response.billing)
  const amount = typeof billing.amount === 'number' && Number.isFinite(billing.amount) && billing.amount >= 0
    ? billing.amount
    : null
  const currency = typeof billing.currency === 'string' && supportedCurrencies.has(billing.currency)
    ? billing.currency
    : null
  const source = typeof billing.source === 'string' && trustedBillingSources.has(billing.source)
    ? billing.source as 'provider_invoice' | 'provider_signed_usage'
    : null
  return amount !== null && currency !== null && source !== null ? { amount, currency, source } : null
}

/** Extracts only response-owned identity and billing fields; request/config labels are never inputs. */
export function observeM3ProviderResponse(value: unknown): ProviderResponseObservation {
  return {
    billing: responseBilling(value),
    identity: responseIdentity(value),
    source: 'm3_provider_response',
  }
}

/** Folds streamed response chunks without retaining text, reasoning, tool calls, or other response content. */
export function observeM3ProviderPayloads(payloads: readonly unknown[]): ProviderResponseObservation {
  let billing: ProviderResponseObservation['billing'] = null
  let identity: ProviderResponseObservation['identity'] = null
  let billingConflict = false
  let identityConflict = false
  for (const payload of payloads) {
    const observed = observeM3ProviderResponse(payload)
    if (observed.billing !== null && !billingConflict) {
      if (billing !== null && JSON.stringify(billing) !== JSON.stringify(observed.billing)) {
        billing = null
        billingConflict = true
      } else billing = observed.billing
    }
    if (observed.identity !== null) {
      if (identity !== null && JSON.stringify(identity) !== JSON.stringify(observed.identity)) {
        identity = null
        identityConflict = true
      } else if (!identityConflict) identity = observed.identity
    }
  }
  return { billing, identity, source: 'm3_provider_response' }
}

export function parseObservedProviderEvidence(data: string): ProviderResponseObservation[] {
  const observations: ProviderResponseObservation[] = []
  for (const line of data.split('\n')) {
    if (line.trim() === '') continue
    let value: unknown
    try { value = JSON.parse(line) } catch { continue }
    const row = record(value)
    if (row.source !== 'm3_provider_response') continue
    const observed = observeM3ProviderResponse(row)
    observations.push(observed)
  }
  return observations
}

export async function readObservedProviderEvidence(path: string): Promise<ProviderResponseObservation[]> {
  try { return parseObservedProviderEvidence(await readFile(path, 'utf8')) }
  catch { return [] }
  finally { await rm(path, { force: true }) }
}

export function aggregateProviderEvidence(observations: readonly ProviderResponseObservation[]): {
  billing: ProviderResponseObservation['billing']
  identity: ProviderResponseObservation['identity']
} {
  if (observations.length === 0) return { billing: null, identity: null }
  const identities = observations.map(item => item.identity)
  const identity = identities.every(item => item !== null && JSON.stringify(item) === JSON.stringify(identities[0]))
    ? identities[0]!
    : null
  const billings = observations.map(item => item.billing)
  if (billings.some(item => item === null)) return { billing: null, identity }
  const first = billings[0]!
  if (!billings.every(item => item!.currency === first.currency && item!.source === first.source)) {
    return { billing: null, identity }
  }
  return {
    billing: { amount: billings.reduce((sum, item) => sum + item!.amount, 0), currency: first.currency, source: first.source },
    identity,
  }
}
