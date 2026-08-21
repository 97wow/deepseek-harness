import { describe, expect, it } from 'vitest'
import {
  aggregateProviderEvidence,
  observeM3ProviderPayloads,
  parseObservedProviderEvidence,
} from './runtime-evidence.js'

describe('M3 provider 运行证据', () => {
  it('只接受响应拥有的完整 identity 与 billing 字段', () => {
    const observed = observeM3ProviderPayloads([{
      billing: { amount: 0.25, currency: 'USD', source: 'provider_signed_usage' },
      deployment: 'm3-production', model: 'deepseek-v4-flash', provider: 'deepseek',
      choices: [{ delta: { content: 'must-not-be-retained' } }],
    }])
    expect(observed).toEqual({
      billing: { amount: 0.25, currency: 'USD', source: 'provider_signed_usage' },
      identity: { deployment: 'm3-production', model: 'deepseek-v4-flash', provider: 'deepseek' },
      source: 'm3_provider_response',
    })
    expect(JSON.stringify(observed)).not.toContain('must-not-be-retained')
  })

  it('来源不可信、字段缺失或 identity 冲突时拒绝', () => {
    expect(parseObservedProviderEvidence(JSON.stringify({
      billing: { amount: 1, currency: 'USD', source: 'provider_invoice' },
      identity: { deployment: 'fake', model: 'fake', provider: 'fake' },
      source: 'environment_label',
    }))).toEqual([])
    expect(observeM3ProviderPayloads([{ model: 'request-label' }])).toMatchObject({ billing: null, identity: null })
    expect(aggregateProviderEvidence([
      observeM3ProviderPayloads([{ deployment: 'a', model: 'm', provider: 'p' }]),
      observeM3ProviderPayloads([{ deployment: 'b', model: 'm', provider: 'p' }]),
    ])).toMatchObject({ billing: null, identity: null })
  })

  it('费用缺失保持 null，不默认为零', () => {
    const observed = observeM3ProviderPayloads([{ deployment: 'm3-production', model: 'm3', provider: 'deepseek' }])
    expect(aggregateProviderEvidence([observed])).toEqual({
      billing: null,
      identity: { deployment: 'm3-production', model: 'm3', provider: 'deepseek' },
    })
  })
})
