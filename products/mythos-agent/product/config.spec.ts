import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { verifyProductProfiles } from './config.js'

const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('Mythos 产品 Profile', () => {
  it('保持 Headless、Web 与 Agent Preset 的 M3 身份和能力一致', async () => {
    await expect(verifyProductProfiles(productRoot)).resolves.toBeUndefined()
  })

  it('要求实现型 bugfix 在证据充分后及时最小修改并聚焦验证', async () => {
    const profiles = await Promise.all([
      'home/profiles/mythos/cordis.patch.yml',
      'home/profiles/mythos-web/cordis.patch.yml',
      'home/.agent-presets/mythos/agent.cordis.yml',
    ].map(path => readFile(join(productRoot, path), 'utf8')))

    for (const profile of profiles) {
      expect(profile).toContain('edit promptly instead of repeating searches or broadening the')
      expect(profile).toContain('then run the focused requested verification')
    }
  })
})
