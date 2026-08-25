import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { verifyProductProfiles } from './config.js'

const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(productRoot, '..', '..')
const execFileAsync = promisify(execFile)

describe('Mythos 产品 Profile', () => {
  it('保持 Headless、Web 与 Agent Preset 的 M3 身份和能力一致', async () => {
    await expect(verifyProductProfiles(productRoot)).resolves.toBeUndefined()
  })

  it('最终 CLI 组装保留 Mythos 产品目录，不回退到通用预设', async () => {
    const result = await execFileAsync(process.execPath, [
      '--import', 'tsx/esm', 'apps/cli/src/bin.ts',
      '--profile', 'mythos-web', '--dump-config',
    ], {
      cwd: repositoryRoot,
      env: { ...process.env, DSH_HOME: join(productRoot, 'home') },
    })
    expect(result.stdout).toContain('default: mythos')
    expect(result.stdout).toContain("process.env.DSH_HOME + '/.agent-presets'")
    expect(result.stdout).not.toContain('apps/cli/config/agent-presets')
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
