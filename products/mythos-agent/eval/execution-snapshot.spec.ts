import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  assertSnapshotRuntimePath,
  assertExecutionArtifactParentAnchor,
  commitExecutionSnapshot,
  executionArtifactParentAnchor,
  lockExecutionArtifact,
  materializeExecutionArtifact,
  readAnchoredArtifactFile,
  readExecutionArtifactManifest,
  verifyExecutionArtifact,
  verifyExecutionSnapshot,
  writeExecutionArtifactManifest,
} from './execution-snapshot.js'

const execFileAsync = promisify(execFile)
const evaluationDirectory = dirname(fileURLToPath(import.meta.url))

async function commandWithInput(root: string, args: readonly string[], input: Buffer): Promise<Buffer> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', chunk => stdout.push(chunk as Buffer))
    child.stderr.on('data', chunk => stderr.push(chunk as Buffer))
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolvePromise(Buffer.concat(stdout))
      else reject(new Error(Buffer.concat(stderr).toString('utf8')))
    })
    child.stdin.end(input)
  })
}

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

async function hookFixture(): Promise<string> {
  const root = await fixture()
  for (const [path, contents] of [
    ['eval/snapshot-loader.mjs', await readFile(join(evaluationDirectory, 'snapshot-loader.mjs'))],
    ['eval/snapshot-register.mjs', await readFile(join(evaluationDirectory, 'snapshot-register.mjs'))],
    ['src/allowed.mjs', "export default 'original-esm'\n"],
    ['src/allowed.cjs', "module.exports = 'original-cjs'\n"],
    ['src/esm-main.mjs', "import value from './allowed.mjs'; process.stdout.write(value)\n"],
    ['src/cjs-main.cjs', "process.stdout.write(require('./allowed.cjs'))\n"],
    ['src/outside-main.cjs', "require(process.env.MYTHOS_TEST_OUTSIDE)\n"],
  ] as const) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), contents)
  }
  await execFileAsync('git', ['add', 'eval', 'src'], { cwd: root })
  await execFileAsync('git', ['commit', '-qm', 'hook fixture'], { cwd: root })
  return root
}

async function anchoredHookEnvironment(root: string, artifact: Awaited<ReturnType<typeof materializeExecutionArtifact>>) {
  const manifestPath = join(await mkdtemp(join(tmpdir(), 'mythos-hook-manifest-')), 'manifest.json')
  await writeExecutionArtifactManifest(manifestPath, artifact)
  const registerBytes = await readAnchoredArtifactFile(root, artifact, 'eval/snapshot-register.mjs')
  const loaderBytes = await readAnchoredArtifactFile(root, artifact, 'eval/snapshot-loader.mjs')
  const parent = executionArtifactParentAnchor(artifact)
  return {
    ...process.env,
    MYTHOS_EVAL_ARTIFACT_MANIFEST: manifestPath,
    MYTHOS_EVAL_ARTIFACT_ROOT: root,
    MYTHOS_EVAL_EXPECTED_ARTIFACT_SHA256: parent.artifactSha256,
    MYTHOS_EVAL_EXPECTED_GIT_COMMIT: parent.gitCommit,
    MYTHOS_EVAL_EXPECTED_GIT_TREE: parent.gitTree,
    MYTHOS_EVAL_EXPECTED_LOADER_SHA256: createHash('sha256').update(loaderBytes).digest('hex'),
    MYTHOS_EVAL_LOADER_DATA_URL: `data:text/javascript;base64,${loaderBytes.toString('base64')}`,
    NODE_OPTIONS: `--import=data:text/javascript;base64,${registerBytes.toString('base64')}`,
  }
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
    expect(artifact.files).toContainEqual(expect.objectContaining({ path: 'src/alias.ts', symlinkTarget: 'entry.ts' }))
    await chmod(join(destination, 'src'), 0o755)
    await rm(join(destination, 'src/alias.ts'))
    await symlink('../package.json', join(destination, 'src/alias.ts'))
    await chmod(join(destination, 'src'), 0o555)
    await expect(verifyExecutionArtifact(destination, artifact)).rejects.toThrow('清单')
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
    await chmod(join(destination, 'built.js'), 0o644)
    await writeFile(join(destination, 'built.js'), 'tampered\n')
    await expect(verifyExecutionArtifact(destination, artifact)).rejects.toThrow('不一致')
  })

  it('root 先 realpath，使 macOS /var 别名下的合法 ESM 位于快照内', async () => {
    const root = await fixture()
    const contents = await readFile(join(root, 'src/entry.ts'))
    const loader = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'snapshot-loader.mjs')).href
    const script = `import { initialize, resolve } from ${JSON.stringify(loader)};
initialize({ root: ${JSON.stringify(root)}, mutableRoots: [], files: [{ path: 'src/entry.ts', type: 'file', sha256: ${JSON.stringify(createHash('sha256').update(contents).digest('hex'))}, size: ${contents.length} }] });
const result = resolve('inside', {}, () => ({ url: ${JSON.stringify(pathToFileURL(join(root, 'src/entry.ts')).href)} }));
process.stdout.write(result.url)`
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8' })
    expect(stdout).toContain('entry.ts')
    if (process.platform === 'darwin' && root.startsWith('/var/')) expect(await realpath(root)).toMatch(/^\/private\/var\//)
  })

  it('正式 register hook 对快照外 CommonJS require fail closed', async () => {
    const root = await hookFixture()
    const destination = await mkdtemp(join(tmpdir(), 'mythos-artifact-test-'))
    const artifact = await materializeExecutionArtifact(root, destination, undefined, {
      async install() {}, async build() {},
    })
    const outside = join(await mkdtemp(join(tmpdir(), 'mythos-outside-test-')), 'outside.cjs')
    await writeFile(outside, 'module.exports = 1\n')
    const environment = await anchoredHookEnvironment(destination, artifact)
    await expect(execFileAsync(process.execPath, [join(destination, 'src/outside-main.cjs')], {
      env: { ...environment, MYTHOS_TEST_OUTSIDE: outside },
    })).rejects.toThrow('快照之外')
  })

  it.each([
    ['ESM', 'src/allowed.mjs', 'src/esm-main.mjs', "export default 'modified-esm'\n", 'modified-esm'],
    ['CommonJS', 'src/allowed.cjs', 'src/cjs-main.cjs', "module.exports = 'modified-cjs'\n", 'modified-cjs'],
  ] as const)('重验后改写 %s 时不执行改写字节', async (_format, target, main, replacement, marker) => {
    const root = await hookFixture()
    const destination = await mkdtemp(join(tmpdir(), 'mythos-artifact-test-'))
    const artifact = await materializeExecutionArtifact(root, destination, undefined, {
      async install() {}, async build() {},
    })
    await expect(verifyExecutionArtifact(destination, artifact)).resolves.toBeDefined()
    await chmod(join(destination, target), 0o644)
    await writeFile(join(destination, target), replacement)
    try {
      await execFileAsync(process.execPath, [join(destination, main)], {
        encoding: 'utf8', env: await anchoredHookEnvironment(destination, artifact),
      })
      throw new Error('改写模块不应执行')
    } catch (error) {
      const output = String(error)
      expect(output).toContain('parent anchor')
      expect(output).not.toContain(marker)
    }
  })

  it('伪造 manifest commit/tree 并重算公开 SHA 仍被 parent anchor 拒绝', async () => {
    const root = await hookFixture()
    const destination = await mkdtemp(join(tmpdir(), 'mythos-artifact-test-'))
    const artifact = await materializeExecutionArtifact(root, destination, undefined, {
      async install() {}, async build() {},
    })
    const parent = executionArtifactParentAnchor(artifact)
    const forged = structuredClone(artifact)
    forged.source.gitCommit = '0'.repeat(40)
    forged.source.gitTree = '1'.repeat(40)
    const identity = { build: forged.build, files: forged.files, mutableRoots: forged.mutableRoots, source: forged.source }
    const canonical = (value: unknown): string => {
      if (value === null || typeof value !== 'object') return JSON.stringify(value)
      if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
      const record = value as Record<string, unknown>
      return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
    }
    forged.sha256 = createHash('sha256').update(canonical(identity)).digest('hex')
    expect(() => assertExecutionArtifactParentAnchor(forged, parent)).toThrow('parent anchor')
    const environment = await anchoredHookEnvironment(destination, artifact)
    const forgedManifest = join(await mkdtemp(join(tmpdir(), 'mythos-forged-manifest-')), 'manifest.json')
    await writeFile(forgedManifest, JSON.stringify(forged))
    await expect(execFileAsync(process.execPath, [join(destination, 'src/esm-main.mjs')], {
      env: { ...environment, MYTHOS_EVAL_ARTIFACT_MANIFEST: forgedManifest },
    })).rejects.toThrow('parent anchor')
  })

  it('目录及 mode 属于 inventory，新增空目录与 mode 变化均 fail closed', async () => {
    const root = await fixture()
    const destination = await mkdtemp(join(tmpdir(), 'mythos-artifact-test-'))
    const artifact = await materializeExecutionArtifact(root, destination, undefined, {
      async install() {}, async build() {},
    })
    expect(artifact.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.', type: 'directory', mode: 0o555 }),
      expect.objectContaining({ path: 'src', type: 'directory', mode: 0o555 }),
    ]))
    await chmod(destination, 0o755)
    await mkdir(join(destination, 'empty'))
    await chmod(destination, 0o555)
    await expect(verifyExecutionArtifact(destination, artifact)).rejects.toThrow('清单')
    await chmod(destination, 0o755)
    await rm(join(destination, 'empty'), { recursive: true })
    await chmod(destination, 0o555)
    await chmod(join(destination, 'src/entry.ts'), 0o644)
    await expect(verifyExecutionArtifact(destination, artifact)).rejects.toThrow('清单')
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

  it('复杂 UTF-8 Git 路径可无损绑定，非 UTF-8 路径在物化前 fail closed', async () => {
    const root = await fixture()
    const complexPath = 'src/复杂 名称\n.ts'
    await writeFile(join(root, complexPath), 'export {}\n')
    await execFileAsync('git', ['add', complexPath], { cwd: root })
    await execFileAsync('git', ['commit', '-qm', 'complex path'], { cwd: root })
    expect((await commitExecutionSnapshot(root)).files.map(file => file.path)).toContain(complexPath)

    const blob = (await commandWithInput(root, ['hash-object', '-w', '--stdin'], Buffer.from('invalid path\n')))
      .toString('ascii').trim()
    const treeInput = Buffer.concat([Buffer.from(`100644 blob ${blob}\tbad-`, 'ascii'), Buffer.from([0xff, 0])])
    const tree = (await commandWithInput(root, ['mktree', '-z'], treeInput)).toString('ascii').trim()
    const { stdout: commit } = await execFileAsync('git', ['commit-tree', tree, '-m', 'invalid utf8'], {
      cwd: root, encoding: 'utf8',
    })
    await expect(commitExecutionSnapshot(root, commit.trim())).rejects.toThrow('有效 UTF-8')
  })
})
