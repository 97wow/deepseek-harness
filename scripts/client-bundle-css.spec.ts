/**
 * Stylesheets enter client bundles through virtual modules, so the loader must
 * register their physical files as watch dependencies.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { clientBundle } from '../packages/client/tsdown.client.ts'

interface CssPlugin {
  name: string
  resolveId?: (source: string, importer?: string) => string | null
  load?: (this: { addWatchFile(id: string): void }, id: string) => Promise<string | null>
}

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const fixtureRoot = fileURLToPath(new URL('./fixtures/client-bundle-css', import.meta.url))

function fixture(name: 'module' | 'global' | 'inline'): { importer: string; stylesheet: string } {
  const directory = join(fixtureRoot, name)
  return {
    importer: join(directory, 'index.fixture'),
    stylesheet: join(directory, name === 'module' ? 'Fixture.module.css' : 'base.css'),
  }
}

function cssPlugin(name: 'dsh-css-modules-inline' | 'dsh-css-global-inline' | 'dsh-css-text-inline'): CssPlugin {
  const configs = clientBundle(
    '@deepseek-ai/dsh-client-test',
    ['lib/types/index.js', 'lib/types/invariant.js'],
  )({ env: { DSH_BUILD_FACE: 'client' } })
  const client = configs.find(config => config.platform === 'browser')
  if (client === undefined) throw new Error('client config missing')
  const plugins = (client as { plugins: CssPlugin[] }).plugins
  const plugin = plugins.find(candidate => candidate.name === name)
  if (plugin === undefined) throw new Error(`${name} missing from client config`)
  return plugin
}

describe('client bundle CSS Modules', () => {
  it('registers the source stylesheet as a watch dependency', async () => {
    const { importer, stylesheet } = fixture('module')
    const plugin = cssPlugin('dsh-css-modules-inline')
    const virtualId = plugin.resolveId?.('./Fixture.module.css', importer)
    if (typeof virtualId !== 'string' || plugin.load === undefined) {
      throw new Error('CSS Modules plugin hooks are incomplete')
    }
    const watched: string[] = []

    const output = await plugin.load.call({ addWatchFile: id => watched.push(id) }, virtualId)

    expect(virtualId).toBe('\0dsh-css:scripts/fixtures/client-bundle-css/module/Fixture.module.css.mjs')
    expect(virtualId).not.toContain(repositoryRoot)
    expect(watched).toEqual([stylesheet])
    expect(output).toContain('data-plugin-css')
  })
})

describe('client bundle global CSS', () => {
  it('compiles a side-effect stylesheet into a watched style injector', async () => {
    const { importer, stylesheet } = fixture('global')
    const plugin = cssPlugin('dsh-css-global-inline')
    const virtualId = plugin.resolveId?.('./base.css', importer)
    if (typeof virtualId !== 'string' || plugin.load === undefined) {
      throw new Error('global CSS plugin hooks are incomplete')
    }
    const watched: string[] = []

    const output = await plugin.load.call({ addWatchFile: id => watched.push(id) }, virtualId)

    expect(virtualId).toBe('\0dsh-global-css:scripts/fixtures/client-bundle-css/global/base.css.mjs')
    expect(virtualId).not.toContain(repositoryRoot)
    expect(watched).toEqual([stylesheet])
    expect(output).toContain('data-plugin-css')
    expect(output).toContain('body{color:red}')
  })

  it('compiles inline stylesheets as watched text without a module side effect', async () => {
    const { importer, stylesheet } = fixture('inline')
    const plugin = cssPlugin('dsh-css-text-inline')
    const virtualId = plugin.resolveId?.('./base.css?inline', importer)
    if (typeof virtualId !== 'string' || plugin.load === undefined) {
      throw new Error('inline CSS plugin hooks are incomplete')
    }
    const watched: string[] = []

    const output = await plugin.load.call({ addWatchFile: id => watched.push(id) }, virtualId)

    expect(virtualId).toBe('\0dsh-inline-css:scripts/fixtures/client-bundle-css/inline/base.css.mjs')
    expect(virtualId).not.toContain(repositoryRoot)
    expect(watched).toEqual([stylesheet])
    expect(output).toContain('export default "body{color:red}"')
    expect(output).not.toContain('data-plugin-css')
  })

  it.each([
    ['dsh-css-modules-inline', './Fixture.module.css'],
    ['dsh-css-global-inline', './base.css'],
    ['dsh-css-text-inline', './base.css?inline'],
  ] as const)('rejects untracked external input for %s', async (name, source) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-client-css-external-'))
    try {
      const stylesheet = join(root, source.includes('Fixture') ? 'Fixture.module.css' : 'base.css')
      await writeFile(stylesheet, 'body { color: red; }\n')
      const plugin = cssPlugin(name)
      expect(() => plugin.resolveId?.(source, join(root, 'index.ts'))).toThrow('outside the repository')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
