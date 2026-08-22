import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:https'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { promisify } from 'node:util'
import { zstdDecompress } from 'node:zlib'
import { exposedSecretPolicies } from './security.js'

const outputLimit = 1024 * 1024
const requestLimit = 2 * 1024 * 1024
const expectedModel = 'deepseek-v4-flash'
const expectedToolCount = 25
const zstdMagic = 0xFD2FB528
const decompressZstdFrame = promisify(zstdDecompress)

interface ChildResult {
  code: number | null
  stderr: string
  stdout: string
}

interface MockRequest {
  body: Record<string, unknown>
  path: string
}

interface MockServer {
  baseUrl: string
  close(): Promise<void>
  requests: MockRequest[]
}

interface ZstdFrameRange {
  end: number
  start: number
}

function scanCompleteZstdFrames(buffer: Buffer): ZstdFrameRange[] {
  const frames: ZstdFrameRange[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 5 || buffer.readUInt32LE(offset) !== zstdMagic) {
      throw new Error(`Mythos M3 session zstd 头损坏：byte ${String(offset)}`)
    }
    offset += 4
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error('Mythos M3 session zstd 含保留 header bit')
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const headerBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < headerBytes) throw new Error('Mythos M3 session zstd header 不完整')
    offset += headerBytes
    for (;;) {
      if (buffer.length - offset < 3) throw new Error('Mythos M3 session zstd block header 不完整')
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error('Mythos M3 session zstd 含保留 block type')
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) throw new Error('Mythos M3 session zstd block 不完整')
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) throw new Error('Mythos M3 session zstd checksum 不完整')
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

function appendBounded(current: string, chunk: Buffer): string {
  const next = current + chunk.toString('utf8')
  if (Buffer.byteLength(next) > outputLimit) throw new Error('Mythos M3 CLI 输出超过 1 MiB')
  return next
}

function cleanEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of ['COMSPEC', 'LANG', 'LC_ALL', 'PATH', 'PATHEXT', 'SYSTEMROOT', 'TEMP', 'TERM', 'TMP', 'TMPDIR']) {
    if (source[key] !== undefined) environment[key] = source[key]
  }
  return environment
}

async function runCli(entry: string, cwd: string, environment: NodeJS.ProcessEnv, prompt: string): Promise<ChildResult> {
  const child = spawn(process.execPath, [entry, 'headless', prompt], {
    cwd,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout = appendBounded(stdout, chunk) })
  child.stderr.on('data', (chunk: Buffer) => { stderr = appendBounded(stderr, chunk) })
  return await new Promise<ChildResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Mythos M3 CLI 未在 45 秒内退出'))
    }, 45_000)
    child.once('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', code => {
      clearTimeout(timeout)
      resolve({ code, stderr, stdout })
    })
  })
}

function writeSse(response: ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`)
}

function finishSse(response: ServerResponse): void {
  response.write('data: [DONE]\n\n')
  response.end()
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > requestLimit) throw new Error('mock request exceeds 2 MiB')
    chunks.push(bytes)
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('mock request is not an object')
  return parsed as Record<string, unknown>
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Mythos HTTPS mock 未获得 TCP 地址')
  return address.port
}

async function startHttpsMock(root: string, credential: string, nonce: string): Promise<MockServer> {
  const keyPath = join(root, 'localhost.key')
  const certPath = join(root, 'localhost.crt')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', keyPath, '-out', certPath, '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'ignore' })
  const requests: MockRequest[] = []
  const server = createServer({ cert: await readFile(certPath), key: await readFile(keyPath) }, (request, response) => {
    void (async () => {
      if (request.method !== 'POST' || request.url !== '/chat/completions') {
        response.writeHead(404).end()
        return
      }
      if (request.headers.authorization !== `Bearer ${credential}`) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end('{"error":{"message":"unauthorized"}}')
        return
      }
      const body = await readJson(request)
      requests.push({ body, path: request.url })
      response.writeHead(200, {
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'content-type': 'text/event-stream',
      })
      if (requests.length === 1) {
        writeSse(response, {
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: 'mythos-read-proof',
                type: 'function',
                function: { name: 'read', arguments: JSON.stringify({ file_path: 'proof.txt' }) },
              }],
            },
            finish_reason: null,
          }],
        })
        writeSse(response, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: {
          prompt_tokens: 64, completion_tokens: 8, total_tokens: 72,
        } })
        finishSse(response)
        return
      }
      if (requests.length === 2) {
        writeSse(response, { choices: [{ index: 0, delta: { content: `MYTHOS_M3_MOCK_OK:${nonce}` }, finish_reason: null }] })
        writeSse(response, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: {
          prompt_tokens: 96, completion_tokens: 12, total_tokens: 108,
        } })
        finishSse(response)
        return
      }
      response.writeHead(500).end()
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
  })
  const port = await listen(server)
  return {
    baseUrl: `https://127.0.0.1:${String(port)}`,
    requests,
    close: async () => await new Promise<void>((resolveClose, reject) => {
      server.close(error => { if (error === undefined) resolveClose(); else reject(error) })
      server.closeAllConnections()
    }),
  }
}

function objectRows(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.some(row => row === null || typeof row !== 'object' || Array.isArray(row))) {
    throw new Error(`Mythos M3 mock ${label} 不是对象数组`)
  }
  return value as Array<Record<string, unknown>>
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Mythos M3 mock ${label} 不是对象`)
  }
  return value as Record<string, unknown>
}

function readCallArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') throw new Error('Mythos M3 mock read tool call arguments 不是 JSON 字符串')
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Mythos M3 mock read tool call arguments 不是有效 JSON')
  }
  return objectValue(parsed, 'read tool call arguments')
}

interface IndexedMessageValue {
  index: number
  value: Record<string, unknown>
}

function verifyReadExchange(messages: Array<Record<string, unknown>>, nonce: string): void {
  const calls: IndexedMessageValue[] = []
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'assistant' || message.tool_calls === undefined) continue
    for (const call of objectRows(message.tool_calls, 'assistant tool_calls')) calls.push({ index, value: call })
  }
  if (calls.length === 0) throw new Error('Mythos M3 mock 次请求缺少 assistant read tool call')
  if (calls.length !== 1) throw new Error('Mythos M3 mock 次请求 assistant tool call 数量不是 1，wire 存在多义性')

  const indexedCall = calls[0]!
  const call = indexedCall.value
  if (call.type !== 'function') throw new Error('Mythos M3 mock read tool call type 必须为 function')
  if (typeof call.id !== 'string' || call.id.trim() === '') throw new Error('Mythos M3 mock read tool call 缺少有效 id')
  const implementation = objectValue(call.function, 'assistant tool call function')
  if (implementation.name !== 'read') throw new Error('Mythos M3 mock assistant tool call 不是 read')
  const argumentsValue = readCallArguments(implementation.arguments)
  if (argumentsValue.file_path !== 'proof.txt') throw new Error('Mythos M3 mock read tool call 未指向 proof.txt')

  const results: IndexedMessageValue[] = []
  for (const [index, message] of messages.entries()) {
    if (message.role === 'tool' && message.tool_call_id === call.id) results.push({ index, value: message })
  }
  if (results.length === 0) throw new Error('Mythos M3 mock 次请求缺少与 read call id 关联的真实 tool result')
  if (results.length !== 1) throw new Error('Mythos M3 mock read tool result 数量不是 1，wire 存在多义性')
  const result = results[0]!
  if (result.index <= indexedCall.index) throw new Error('Mythos M3 mock tool result 必须位于 assistant read tool call 之后')
  if (typeof result.value.content !== 'string' || !result.value.content.includes(nonce)) {
    throw new Error('Mythos M3 mock 次请求缺少与 read call id 关联的真实 tool result')
  }
}

/** Assert the two OpenAI-compatible requests prove persona, tool execution, and continuation. */
export function verifyM3Requests(requests: readonly MockRequest[], prompt: string, nonce: string): void {
  if (requests.length !== 2) throw new Error(`Mythos M3 mock 请求数应为 2，实际 ${String(requests.length)}`)
  const first = requests[0]?.body
  const second = requests[1]?.body
  if (first === undefined || second === undefined) throw new Error('Mythos M3 mock 缺少请求体')
  if (first.model !== expectedModel || second.model !== expectedModel) throw new Error('Mythos M3 mock 未使用 deepseek-v4-flash')
  const firstMessages = objectRows(first.messages, '首请求 messages')
  const secondMessages = objectRows(second.messages, '次请求 messages')
  const systemMessage = firstMessages.find(message => message.role === 'system'
    && typeof message.content === 'string' && message.content.includes('You are Mythos Agent'))
  if (systemMessage === undefined) throw new Error('Mythos M3 mock 首请求缺少正确 role 的 MYTHOS persona')
  const userMessage = firstMessages.find(message => message.role === 'user' && message.content === prompt)
  if (userMessage === undefined) throw new Error('Mythos M3 mock 首请求缺少正确 role 的用户 prompt')
  const tools = objectRows(first.tools, '首请求 tools')
  if (tools.length !== expectedToolCount) {
    throw new Error(`Mythos M3 mock 工具 schema 应为 ${String(expectedToolCount)}，实际 ${String(tools.length)}`)
  }
  const readSchema = tools.find(tool => tool.type === 'function'
    && tool.function !== null && typeof tool.function === 'object' && !Array.isArray(tool.function)
    && (tool.function as Record<string, unknown>).name === 'read')
  if (readSchema === undefined) throw new Error('Mythos M3 mock 工具 schema 缺少 read')

  verifyReadExchange(secondMessages, nonce)
}

async function collectSessionFiles(root: string): Promise<string[]> {
  const result: string[] = []
  async function visit(path: string): Promise<void> {
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile() && entry.name === 'session.jsonl.zstd') result.push(child)
    }
  }
  await visit(root)
  return result.sort()
}

async function readSession(path: string): Promise<string> {
  const bytes = await readFile(path)
  const ranges = scanCompleteZstdFrames(bytes)
  if (ranges.length === 0) throw new Error('Mythos M3 session zstd 不完整')
  const frames = await Promise.all(ranges.map(frame => decompressZstdFrame(bytes.subarray(frame.start, frame.end))))
  const text = Buffer.concat(frames).toString('utf8')
  for (const line of text.split('\n').filter(Boolean)) JSON.parse(line)
  return text
}

function assertNoSensitiveEvidence(values: readonly string[], credential: string): void {
  for (const value of values) {
    if (value.includes(credential)) throw new Error('Mythos M3 验收输出或 session 泄露 mock credential')
    if (exposedSecretPolicies(value).length > 0) throw new Error('Mythos M3 验收输出或 session 命中密钥模式')
    if (/authorization\s*[:=]|bearer\s+[A-Za-z0-9._-]+|[?&](?:api[_-]?key|token)=/iu.test(value)) {
      throw new Error('Mythos M3 验收输出或 session 泄露 header/query credential')
    }
  }
}

/** Run the extracted release entry through one deterministic read-only M3 tool round. */
export async function verifyM3CliMock(releaseRoot: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'mythos-m3-cli-mock-'))
  const workspace = join(root, 'workspace')
  const nonce = `nonce-${randomBytes(12).toString('hex')}`
  const credential = randomBytes(24).toString('base64url')
  const prompt = `Use only the read tool to read proof.txt and return its exact nonce. Do not use shell, web, write, edit, subagents, or any other tool. Expected proof begins ${nonce.slice(0, 12)}.`
  await mkdir(workspace)
  await writeFile(join(workspace, 'proof.txt'), `${nonce}\n`, { mode: 0o444 })
  const mock = await startHttpsMock(root, credential, nonce)
  const entry = join(releaseRoot, 'bin', 'mythos.js')
  const environment = cleanEnvironment(process.env)
  environment.HOME = join(releaseRoot, 'home')
  environment.USERPROFILE = environment.HOME
  environment.DEEPSEEK_API_KEY = credential
  environment.DEEPSEEK_BASE_URL = mock.baseUrl
  environment.DSH_PERMISSION_MODE = 'read-only'
  environment.NODE_EXTRA_CA_CERTS = join(root, 'localhost.crt')
  const sessionsRoot = join(releaseRoot, 'home', 'sessions')
  const before = new Set(await collectSessionFiles(sessionsRoot))
  try {
    const positive = await runCli(entry, workspace, environment, prompt)
    const sessionFiles = (await collectSessionFiles(sessionsRoot)).filter(path => !before.has(path))
    if (positive.code !== 0) throw new Error(`Mythos M3 mock CLI 退出 ${String(positive.code)}：${positive.stderr}`)
    if (positive.stdout.trim() !== `MYTHOS_M3_MOCK_OK:${nonce}`) throw new Error('Mythos M3 mock CLI final stdout 不匹配')
    if (positive.stderr !== '') throw new Error(`Mythos M3 mock CLI stderr 非空：${positive.stderr}`)
    verifyM3Requests(mock.requests, prompt, nonce)
    if (sessionFiles.length !== 1) throw new Error(`Mythos M3 mock 应落盘 1 个 session，实际 ${String(sessionFiles.length)}`)
    const session = await readSession(sessionFiles[0]!)
    if (!session.includes(nonce) || !session.includes('mythos-read-proof') || !session.includes('tool')) {
      throw new Error('Mythos M3 mock session 缺少 prompt、tool call 或 tool result')
    }
    assertNoSensitiveEvidence([
      positive.stdout, positive.stderr, JSON.stringify(mock.requests.map(request => request.body)), session,
    ], credential)

    const requestsBeforeMissingKey = mock.requests.length
    const missingEnvironment = { ...environment }
    delete missingEnvironment.DEEPSEEK_API_KEY
    const missing = await runCli(entry, workspace, missingEnvironment, 'Return a one-word answer.')
    if (missing.code === 0) throw new Error('Mythos M3 CLI 缺少 key 时错误地退出 0')
    if (mock.requests.length !== requestsBeforeMissingKey) throw new Error('Mythos M3 CLI 缺少 key 时仍发起网络请求')
    if (!/no API key|DEEPSEEK_API_KEY|credential/iu.test(missing.stderr)) {
      throw new Error('Mythos M3 CLI 缺少 key 时未给出可操作提示')
    }
    assertNoSensitiveEvidence([missing.stdout, missing.stderr], credential)
  } finally {
    await mock.close()
    await rm(root, { force: true, recursive: true })
  }
}
