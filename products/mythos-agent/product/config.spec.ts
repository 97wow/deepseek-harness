import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { verifyProductProfiles } from './config.js'

const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('Mythos 产品 Profile', () => {
  it('保持 Headless、Web 与 Agent Preset 的 M3 身份和能力一致', async () => {
    await expect(verifyProductProfiles(productRoot)).resolves.toBeUndefined()
  })
})
