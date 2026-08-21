import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEvaluationLaunchArguments, type EvaluationEntryId } from './entry-registry.js'
import {
  assertSnapshotRuntimePath,
  assertExecutionArtifactParentAnchor,
  executionArtifactParentAnchor,
  lockExecutionArtifact,
  materializeExecutionArtifact,
  readAnchoredArtifactFile,
  readExecutionArtifactManifest,
  verifyExecutionArtifact,
  writeExecutionArtifactManifest,
} from './execution-snapshot.js'

export type EvaluationExecutionHook = (entryId: EvaluationEntryId, load: () => Promise<unknown>) => Promise<void>

export interface EvaluationLaunchRuntime {
  argv: string[]
  environment: Record<string, string | undefined>
}

const executeEntry: EvaluationExecutionHook = async (_entryId, load) => { await load() }

function childProcess(file: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { ...options, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal !== null) reject(new Error(`执行快照进程被信号终止：${signal}`))
      else resolvePromise(code ?? 1)
    })
  })
}

async function verifyFormalRuntime(parameters: readonly string[]): Promise<void> {
  const manifestPath = process.env.MYTHOS_EVAL_ARTIFACT_MANIFEST
  const artifactRoot = process.env.MYTHOS_EVAL_ARTIFACT_ROOT
  if (manifestPath === undefined || artifactRoot === undefined) throw new Error('正式评测缺少执行产物证据')
  const commitment = await readExecutionArtifactManifest(manifestPath)
  assertExecutionArtifactParentAnchor(commitment, {
    artifactSha256: process.env.MYTHOS_EVAL_EXPECTED_ARTIFACT_SHA256 ?? '',
    gitCommit: process.env.MYTHOS_EVAL_EXPECTED_GIT_COMMIT ?? '',
    gitTree: process.env.MYTHOS_EVAL_EXPECTED_GIT_TREE ?? '',
  })
  const verified = await verifyExecutionArtifact(artifactRoot, commitment)
  await assertSnapshotRuntimePath(verified, fileURLToPath(import.meta.url))
  const expectedProductRoot = await realpath(resolve(verified.root, 'products/mythos-agent'))
  if (await realpath(process.cwd()) !== expectedProductRoot) throw new Error('正式评测 cwd 不在已验证执行产物内')
  const expectedCommand = ['tsx', 'eval/launch.ts', ...parameters].join(' ')
  if (process.env.MYTHOS_EVAL_CANONICAL_COMMAND !== expectedCommand) throw new Error('正式评测 command 与预承诺不一致')
  if (process.env.MYTHOS_EVAL_INVOCATION_JSON !== JSON.stringify(parameters)) throw new Error('正式评测参数与预承诺不一致')
  process.env.MYTHOS_EVAL_ARTIFACT_SHA256 = commitment.sha256
  process.env.MYTHOS_EVAL_GIT_COMMIT = commitment.source.gitCommit
  process.env.MYTHOS_EVAL_GIT_TREE = commitment.source.gitTree
}

async function bootstrapFormalRuntime(parameters: readonly string[]): Promise<void> {
  const currentProductRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const repoRoot = resolve(currentProductRoot, '..', '..')
  const temporary = await mkdtemp(join(tmpdir(), 'mythos-eval-artifact-'))
  const artifactRoot = join(temporary, 'artifact')
  const manifestPath = join(temporary, 'manifest.json')
  const commitment = await materializeExecutionArtifact(repoRoot, artifactRoot)
  const parentAnchor = executionArtifactParentAnchor(commitment)
  await writeExecutionArtifactManifest(manifestPath, commitment)
  await verifyExecutionArtifact(artifactRoot, commitment)
  await lockExecutionArtifact(artifactRoot)
  const verifiedArtifactRoot = await realpath(artifactRoot)
  const productRoot = join(verifiedArtifactRoot, 'products/mythos-agent')
  const launcherPath = join(productRoot, '.mythos-eval-runtime/eval/launch.js')
  const registerBytes = await readAnchoredArtifactFile(verifiedArtifactRoot, commitment,
    'products/mythos-agent/eval/snapshot-register.mjs')
  const loaderBytes = await readAnchoredArtifactFile(verifiedArtifactRoot, commitment,
    'products/mythos-agent/eval/snapshot-loader.mjs')
  const registerUrl = `data:text/javascript;base64,${registerBytes.toString('base64')}`
  const loaderUrl = `data:text/javascript;base64,${loaderBytes.toString('base64')}`
  const command = ['tsx', 'eval/launch.ts', ...parameters].join(' ')
  const environment: NodeJS.ProcessEnv = { ...process.env, MYTHOS_EVAL_ARTIFACT_MANIFEST: manifestPath,
    MYTHOS_EVAL_ARTIFACT_ROOT: verifiedArtifactRoot, MYTHOS_EVAL_CANONICAL_COMMAND: command,
    MYTHOS_EVAL_EXPECTED_ARTIFACT_SHA256: parentAnchor.artifactSha256,
    MYTHOS_EVAL_EXPECTED_GIT_COMMIT: parentAnchor.gitCommit, MYTHOS_EVAL_EXPECTED_GIT_TREE: parentAnchor.gitTree,
    MYTHOS_EVAL_EXPECTED_LOADER_SHA256: createHash('sha256').update(loaderBytes).digest('hex'),
    MYTHOS_EVAL_INVOCATION_JSON: JSON.stringify(parameters), MYTHOS_EVAL_LOADER_DATA_URL: loaderUrl,
    NODE_OPTIONS: `--import=${registerUrl}` }
  delete environment.NODE_PATH
  const code = await childProcess(process.execPath, [launcherPath, ...parameters], {
    cwd: productRoot,
    env: environment,
  })
  process.stdout.write(`\n[Mythos Eval Artifact] ${verifiedArtifactRoot}\n`)
  if (code !== 0) process.exitCode = code
}

export async function launchEvaluation(
  parameters: readonly string[],
  executionHook: EvaluationExecutionHook = executeEntry,
  runtime: EvaluationLaunchRuntime = { argv: process.argv, environment: process.env },
): Promise<void> {
  const invocation = parseEvaluationLaunchArguments(parameters)
  for (const [name, value] of invocation.entry.environment) runtime.environment[name] = value
  for (const [name, value] of invocation.entry.environmentDefaults ?? []) runtime.environment[name] ??= value
  const suite = invocation.options.get('suite')
  if (suite !== undefined) runtime.environment.MYTHOS_EVAL_SUITE = suite
  runtime.environment.MYTHOS_EVAL_ENTRY_ID = invocation.entryId
  runtime.argv.splice(0, runtime.argv.length, runtime.argv[0] ?? process.execPath, 'eval/launch.ts', ...invocation.caseIds)
  await executionHook(invocation.entryId, invocation.entry.load)
}

const executedPath = process.argv[1] === undefined ? null : resolve(process.argv[1])
if (executedPath === fileURLToPath(import.meta.url)) {
  const parameters = process.argv.slice(2)
  if (process.env.MYTHOS_EVAL_ARTIFACT_MANIFEST === undefined) await bootstrapFormalRuntime(parameters)
  else { await verifyFormalRuntime(parameters); await launchEvaluation(parameters) }
}
