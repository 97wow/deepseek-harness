import { spawnSync } from 'node:child_process'
import { access, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { archiveReleaseTree, assertNoAbsoluteBuildRoots, buildWebFrontend, normalizeReleaseMetadata } from './pack.js'

const temporaryRoots: string[] = []
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

async function stagingFixture(): Promise<string> {
  const stagingRoot = await mkdtemp(join(tmpdir(), 'mythos-pack-determinism-'))
  temporaryRoots.push(stagingRoot)
  const releaseRoot = join(stagingRoot, 'mythos-agent')
  await mkdir(join(releaseRoot, 'runtime'), { recursive: true })
  await writeFile(join(releaseRoot, 'runtime', 'entry.js'), 'export default "mythos"\n')
  await symlink('runtime', join(releaseRoot, 'node_modules'))
  return stagingRoot
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe('Mythos 发布包确定性', () => {
  it('拒绝发布闭包中的绝对 checkout 或 staging 根', async () => {
    const stagingRoot = await stagingFixture()
    const releaseRoot = join(stagingRoot, 'mythos-agent')
    await writeFile(join(releaseRoot, 'runtime', 'leak.js'), `//#region dsh-css:${repositoryRoot}/packages/example.css`)
    await expect(assertNoAbsoluteBuildRoots(releaseRoot, [repositoryRoot, stagingRoot])).rejects.toThrow('绝对构建根')
  })

  it('不依赖预构建 dist 即可从 frozen workspace 构建 Web frontend', async () => {
    const webDist = join(repositoryRoot, 'apps', 'web', 'dist')
    await rm(webDist, { force: true, recursive: true })
    await buildWebFrontend()
    await expect(access(join(webDist, 'index.html'))).resolves.toBeUndefined()
  }, 30_000)

  it('跨墙钟创建的独立 staging 产生相同归档字节', async () => {
    const firstRoot = await stagingFixture()
    await new Promise(resolve => setTimeout(resolve, 1_100))
    const secondRoot = await stagingFixture()

    await normalizeReleaseMetadata(join(firstRoot, 'mythos-agent'))
    await normalizeReleaseMetadata(join(secondRoot, 'mythos-agent'))

    const first = await archiveReleaseTree(firstRoot)
    const second = await archiveReleaseTree(secondRoot)
    const firstTar = gunzipSync(first)
    const secondTar = gunzipSync(second)
    const difference = firstTar.findIndex((byte, index) => byte !== secondTar[index])
    expect(first.equals(second), `首个 tar 差异 offset=${String(difference)}，block=${String(Math.floor(difference / 512))}`).toBe(true)
    const listing = spawnSync('tar', ['--numeric-owner', '-tvzf', '-'], { encoding: 'utf8', input: first })
    expect(listing.status, listing.stderr).toBe(0)
    for (const line of listing.stdout.trim().split('\n')) expect(line).toMatch(/^\S+\s+0\s+0\s+/u)
  })
})
