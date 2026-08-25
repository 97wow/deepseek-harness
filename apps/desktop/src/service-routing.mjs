import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const SERVICE_ENDPOINTS = Object.freeze([
  'https://d.llmapi.pro:99',
  'https://llmapi.pro',
])

export function validatedServiceEndpoints(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('服务线路配置无效')
  if (value.version !== 1 || !Array.isArray(value.serviceEndpoints)) throw new Error('服务线路配置无效')
  if (value.serviceEndpoints.length === 0 || value.serviceEndpoints.length > 4) throw new Error('服务线路数量无效')
  const endpoints = value.serviceEndpoints.map(candidate => {
    if (typeof candidate !== 'string') throw new Error('服务线路地址无效')
    const url = new URL(candidate)
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.pathname !== '/') {
      throw new Error('服务线路必须是无凭据的 HTTPS 源地址')
    }
    return url.toString().replace(/\/$/u, '')
  })
  if (new Set(endpoints).size !== endpoints.length) throw new Error('服务线路不能重复')
  return endpoints
}

export async function loadServiceEndpoints(configRoot) {
  try {
    const value = JSON.parse(await readFile(join(configRoot, 'desktop', 'service-routing.json'), 'utf8'))
    return validatedServiceEndpoints(value)
  } catch {
    return SERVICE_ENDPOINTS
  }
}

export function searchEndpoint(endpoint) {
  return `${endpoint.replace(/\/+$/u, '')}/v1`
}

export async function probeServiceEndpoint(endpoint, credential = '', fetchImplementation = fetch, timeoutMs = 4500) {
  const headers = credential === '' ? {} : { authorization: `Bearer ${credential}` }
  try {
    const response = await fetchImplementation(`${searchEndpoint(endpoint)}/models`, {
      headers,
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.status < 500
  } catch {
    return false
  }
}

export async function selectServiceEndpoint(credential = '', fetchImplementation = fetch, endpoints = SERVICE_ENDPOINTS) {
  for (const endpoint of endpoints) {
    if (await probeServiceEndpoint(endpoint, credential, fetchImplementation)) {
      return { endpoint, reachable: true }
    }
  }
  return { endpoint: endpoints[0], reachable: false }
}
