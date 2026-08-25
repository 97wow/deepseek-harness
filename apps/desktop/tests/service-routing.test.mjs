import assert from 'node:assert/strict'
import test from 'node:test'
import {
  searchEndpoint, selectServiceEndpoint, SERVICE_ENDPOINTS, validatedServiceEndpoints,
} from '../src/service-routing.mjs'

test('prefers the primary managed service endpoint', async () => {
  const requests = []
  const selected = await selectServiceEndpoint('secret', async (url, options) => {
    requests.push({ options, url })
    return { status: 200 }
  })
  assert.deepEqual(selected, { endpoint: SERVICE_ENDPOINTS[0], reachable: true })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].options.headers.authorization, 'Bearer secret')
})

test('falls back to llmapi.pro when the primary route is unavailable', async () => {
  const selected = await selectServiceEndpoint('', async url => {
    if (url.startsWith(SERVICE_ENDPOINTS[0])) throw new Error('unreachable')
    return { status: 401 }
  })
  assert.deepEqual(selected, { endpoint: SERVICE_ENDPOINTS[1], reachable: true })
  assert.equal(searchEndpoint(selected.endpoint), 'https://llmapi.pro/v1')
})

test('keeps the primary route as a deterministic default when offline', async () => {
  const selected = await selectServiceEndpoint('', async () => ({ status: 503 }))
  assert.deepEqual(selected, { endpoint: SERVICE_ENDPOINTS[0], reachable: false })
})

test('accepts only a small HTTPS endpoint list without embedded credentials', () => {
  assert.deepEqual(validatedServiceEndpoints({
    version: 1,
    serviceEndpoints: ['https://d.llmapi.pro:99', 'https://llmapi.pro/'],
  }), [...SERVICE_ENDPOINTS])
  assert.throws(() => validatedServiceEndpoints({ version: 1, serviceEndpoints: ['http://llmapi.pro'] }), /HTTPS/u)
  assert.throws(() => validatedServiceEndpoints({ version: 1, serviceEndpoints: ['https://key@llmapi.pro'] }), /HTTPS/u)
  assert.throws(() => validatedServiceEndpoints({ version: 1, serviceEndpoints: Array(5).fill('https://llmapi.pro') }), /数量/u)
})
