import { describe, expect, it } from 'vitest'
import { exposedSecretPolicies } from './security.js'

describe('发布密钥扫描', () => {
  it('拒绝长 API Key 和 Token 值但允许变量名', () => {
    expect(exposedSecretPolicies('DEEPSEEK_API_KEY')).toEqual([])
    expect(exposedSecretPolicies(['sk', 'relay', 'abcdefghijklmnopqrstuvwxyz123456'].join('-'))).toContain('secret-pattern-1')
    expect(exposedSecretPolicies(`api_key = "${'a'.repeat(30)}"`)).toContain('secret-pattern-2')
  })
})
