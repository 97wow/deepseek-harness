import { execFile } from 'node:child_process'
import { access, cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  assertSnapshotRuntimePath,
  commitExecutionSnapshot,
  lockExecutionArtifact,
  materializeExecutionArtifact,
  readExecutionArtifactManifest,
  verifyExecutionArtifact,
  verifyExecutionSnapshot,
  writeExecutionArtifactManifest,
} from './execution-snapshot.js'

const execFileAsync = promisify(execFile)

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mythos-snapshot-test-'))
  for (const [path, contents] of [
    ['package.json', '{}\n'], ['pnpm-lock.yaml', 'lockfileVersion: 9\n'], ['src/entry.ts', 'export const value = 1\n'],
  ] as const) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), contents)
  }
  await execFileAsync('git', ['init', '-q'], { cwd: root })
  await execFileAsync('git', ['config', 'user.email', 'snapshot@test.invalid'], { cwd: root })
  await execFileAsync('git', ['config', 'user.name', 'Snapshot Test'], { cwd: root })
  await execFileAsync('git', ['add', '.'], { cwd: root })
  await execFileAsync('git', ['commit', '-qm', 'fixture'], { cwd: root })
  return root
}

describe('不可变执行快照', () => {
  it('绑定整个 tracked tree；工作树变化不影响已锁定提交，新提交改变 SHA', async () => {
    const root = await fixture()
    const first = await commitExecutionSnapshot(root)
    expect(first.files.map(file => file.path)).toEqual(['package.json', 'pnpm-lock.yaml', 'src/entry.ts'])
    await writeFile(join(root, 'src/entry.ts'), 'export const value = 2\n')
    expect(await commitExecutionSnapshot(root)).toEqual(first)
    await execFileAsync('git', ['add', 'src/entry.ts'], { cwd: root })
    await execFileAsync('git', ['commit', '-qm', 'change'], { cwd: root })
    expect((await commitExecutionSnapshot(root)).sha256).not.toBe(first.sha256)
  })

  it('物化时保留 Git 相对 symlink，临时 worktree 删除后仍位于 artifact 内', async () => {
    const root = await fixture()
    await symlink('entry.ts', join(root, 'src/alias.ts'))
    await execFileAsync('git', ['add', 'src/alias.ts'], { cwd: root })
    await execFileAsync('git', ['commit', '-qm', 'symlink'], { cwd: root })
    const destination = await mkdtemp(join(tmpdir(), 'mythos-artifact-test-'))
    const artifact = await materializeExecutionArtifact(root, destination, undefined, {
      async install(path) { await mkdir(join(path, 'node_modules'), { recursive: true }) },
      async build() {},
    })
    await expect(verifyExecutionArtifact(destination, artifact)).resolves.toMatchObject({ commitmentSha256: artifact.sha256 })
    expect(await readFile(join(destination, 'src/alias.ts'), 'utf8')).toBe('export const value = 1\n')
  })

  it('离线物化依赖和构建产物后可独立重验，源码工作树变化不污染产物', async () => {
    const root = await fixture()
    const source = await commitExecutionSnapshot(root)
    const destination = await mkdtemp(join(tmpdir(), 'mythos-artifact-test-'))
    const artifact = await materializeExecutionArtifact(root, destination, source, {
      async install(path) {
        await mkdir(join(path, 'node_modules/example'), { recursive: true })
        await writeFile(join(path, 'node_modules/example/index.js'), 'export default 1\n')
      },
      async build(path) {
        const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8' })
        expect(stdout.trim()).toBe(source.gitCommit)
        await mkdir(join(path, 'lib'), { recursive: true })
        await writeFile(join(path, 'lib/entry.js'), 'export const built = true\n')
      },
    })
    await expect(access(join(destination, '.git'))).rejects.toThrow()
    await lockExecutionArtifact(destination)
    const verified = await verifyExecutionArtifact(destination, artifact)
    await writeFile(join(destination, 'products/mythos-agent/runs/output.json'), '{}\n')
    await expect(verifyExecutionArtifact(destination, artifact)).resolves.toMatchObject({ commitmentSha256: artifact.sha256 })
    await writeFile(join(root, 'src/entry.ts'), 'uncommitted change\n')
    expect(await readFile(join(destination, 'src/entry.ts'), 'utf8')).toBe('export const value = 1\n')
    expect(await assertSnapshotRuntimePath(verified, join(destination, 'lib/entry.js'))).toContain(destination)
    await expect(assertSnapshotRuntimePath(verified, join(root, 'src/entry.ts'))).rejects.toThrow('之外')
  })

  it('manifest 不含正文且依赖文件修改后离线重验 fail closed', async () => {
    const root = await fixture()
    const destination = await mkdtemp(join(tmpdir(), 'mythos-artifact-test-'))
    const artifact = await materializeExecutionArtifact(root, destination, undefined, {
      async install(path) { await mkdir(join(path, 'node_modules'), { recursive: true }) },
      async build(path) { await writeFile(join(path, 'built.js'), 'sensitive-body\n') },
    })
    const manifestPath = join(await mkdtemp(join(tmpdir(), 'mythos-manifest-test-')), 'manifest.json')
    await writeExecutionArtifactManifest(manifestPath, artifact)
    expect(await readExecutionArtifactManifest(manifestPath)).toEqual(artifact)
    expect(await readFile(manifestPath, 'utf8')).not.toContain('sensitive-body')
    await writeFile(join(destination, 'built.js'), 'tampered\n')
    await expect(verifyExecutionArtifact(destination, artifact)).rejects.toThrow('不一致')
  })

  it('运行期 ESM loader 拒绝快照外模块', async () => {
    const root = await fixture()
    const outside = join(await mkdtemp(join(tmpdir(), 'mythos-outside-test-')), 'outside.mjs')
    await writeFile(outside, 'export default 1\n')
    const loader = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'snapshot-loader.mjs')).href
    const script = `import { initialize, resolve } from ${JSON.stringify(loader)};
initialize({ root: ${JSON.stringify(root)}, mutableRoots: [] });
try { await resolve('outside', {}, async () => ({ url: ${JSON.stringify(pathToFileURL(outside).href)} })); process.exit(2) }
catch (error) { process.stdout.write(String(error.message)) }`
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8' })
    expect(stdout).toContain('快照之外')
  })

  it('正式 register hook 对快照外 CommonJS require 同样 fail closed', async () => {
    const root = await fixture()
    const outside = join(await mkdtemp(join(tmpdir(), 'mythos-outside-test-')), 'outside.cjs')
    await writeFile(outside, 'module.exports = 1\n')
    const main = join(root, 'main.mjs')
    await writeFile(main, `import { createRequire } from 'node:module'; createRequire(import.meta.url)(${JSON.stringify(outside)})\n`)
    const register = join(dirname(fileURLToPath(import.meta.url)), 'snapshot-register.mjs')
    await expect(execFileAsync(process.execPath, [main], {
      env: { ...process.env, MYTHOS_EVAL_ARTIFACT_ROOT: root, NODE_OPTIONS: `--import=${pathToFileURL(register).href}` },
    })).rejects.toThrow('快照之外')
  })

  it('纯源码快照逐 blob 重验并拒绝额外文件', async () => {
    const root = await fixture()
    const commitment = await commitExecutionSnapshot(root)
    const snapshot = await mkdtemp(join(tmpdir(), 'mythos-source-copy-'))
    for (const file of commitment.files) {
      await mkdir(dirname(join(snapshot, file.path)), { recursive: true })
      await cp(join(root, file.path), join(snapshot, file.path))
    }
    await expect(verifyExecutionSnapshot(snapshot, commitment)).resolves.toMatchObject({ gitTree: commitment.gitTree })
    await writeFile(join(snapshot, 'extra'), 'extra')
    await expect(verifyExecutionSnapshot(snapshot, commitment)).rejects.toThrow('文件集合')
  })
})
