import { createHash } from 'node:crypto'
import { createReadStream, constants } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

export interface ArchiveOptions {
  outputRoot: string
  productRoot: string
  runsRoot: string
  sessionsRoot: string
}

export interface ArchiveResult {
  rawSessions: number
  samples: number
}

const safeId = /^[a-zA-Z0-9._-]+$/

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && value !== '.' && value !== '..' && safeId.test(value)
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function resolveRawSession(productRoot: string, sessionsRoot: string, trustedRoot: string, value: unknown): Promise<string> {
  if (typeof value !== 'string') throw new Error('评测记录的 rawSession 必须是字符串')
  const lexicalPath = resolve(productRoot, value)
  if (!lexicalPath.startsWith(`${sessionsRoot}${sep}`)) throw new Error('rawSession 越出会话根目录')
  const trustedPath = await realpath(lexicalPath)
  if (!trustedPath.startsWith(`${trustedRoot}${sep}`)) throw new Error('rawSession 符号链接越出会话根目录')
  if (!(await stat(trustedPath)).isFile()) throw new Error('rawSession 不是普通文件')
  return trustedPath
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'EEXIST'
}

async function writeImmutable(path: string, content: string): Promise<void> {
  const expected = Buffer.from(content)
  try {
    await writeFile(path, expected, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (!isAlreadyExists(error)) throw error
    if (!(await readFile(path)).equals(expected)) throw new Error(`飞轮不可变文件已被篡改：${path}`)
  }
}

async function copyRawImmutable(source: string, destination: string): Promise<string> {
  const sourceSha256 = await sha256(source)
  try {
    await copyFile(source, destination, constants.COPYFILE_EXCL)
    await chmod(destination, 0o600)
  } catch (error) {
    if (!isAlreadyExists(error)) throw error
  }
  if (await sha256(destination) !== sourceSha256) throw new Error(`飞轮原始会话副本与来源不一致：${destination}`)
  return sourceSha256
}

export async function archiveFlywheel(options: ArchiveOptions): Promise<ArchiveResult> {
  const productRoot = resolve(options.productRoot)
  const runsRoot = resolve(options.runsRoot)
  const sessionsRoot = resolve(options.sessionsRoot)
  const outputRoot = resolve(options.outputRoot)
  const trustedRoot = await realpath(sessionsRoot)
  const filenames = (await readdir(runsRoot)).filter(name => name.endsWith('.json')).sort()
  const index: Record<string, unknown>[] = []
  let rawSessions = 0

  for (const filename of filenames) {
    const report = JSON.parse(await readFile(join(runsRoot, filename), 'utf8')) as Record<string, unknown>
    const runId = report.runId
    if (!isSafeId(runId)) continue
    const cases = Array.isArray(report.cases) ? report.cases : []
    for (const item of cases) {
      if (typeof item !== 'object' || item === null) continue
      const testCase = item as Record<string, unknown>
      const caseId = testCase.id
      if (!isSafeId(caseId)) continue
      const caseRoot = join(outputRoot, 'runs', runId, caseId)
      await mkdir(caseRoot, { mode: 0o700, recursive: true })
      let raw: { byteExact: true, sha256: string } | null = null
      if (testCase.rawSession !== undefined) {
        const source = await resolveRawSession(productRoot, sessionsRoot, trustedRoot, testCase.rawSession)
        raw = { byteExact: true, sha256: await copyRawImmutable(source, join(caseRoot, 'session.jsonl.zstd')) }
        rawSessions += 1
      }
      const label = {
        baseline: report.baseline,
        case: testCase,
        completedAt: report.completedAt,
        raw,
        reportVersion: report.reportVersion,
        runId,
        startedAt: report.startedAt,
      }
      const labelPath = join(caseRoot, 'label.json')
      await writeImmutable(labelPath, `${JSON.stringify(label, null, 2)}\n`)
      index.push({
        caseId,
        hasRaw: raw !== null,
        label: relative(outputRoot, labelPath),
        passed: testCase.passed === true,
        runId,
        ...(raw ? { sha256: raw.sha256 } : {}),
      })
    }
  }

  await mkdir(outputRoot, { mode: 0o700, recursive: true })
  const target = join(outputRoot, 'index.jsonl')
  const temporary = `${target}.${process.pid}.tmp`
  const content = index.map(row => JSON.stringify(row)).join('\n') + (index.length ? '\n' : '')
  await writeFile(temporary, content, { mode: 0o600 })
  await rename(temporary, target)
  return { rawSessions, samples: index.length }
}
