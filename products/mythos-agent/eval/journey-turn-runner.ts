import { createRequire } from 'node:module'
import { readFileSync, unlinkSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'mythos-journey-turn-runner'
export const inject = ['agentDefaultModel', 'agents', 'sessionPersistence', 'sessions']

interface TurnConfig {
  action: 'create' | 'resume'
  prompt: string
  sessionId: string
}

interface SessionEvent {
  data: Record<string, unknown>
  seq: number
  type: string
}

interface RunnerContext {
  get(key: string): unknown
}

interface RunnerModules {
  createUserMessage(input: unknown): unknown
  installModelSelection(ctx: RunnerContext, selection: unknown): void
  SessionId(value: string): unknown
}

export function shouldRecoverPlaceholderTurn(events: readonly SessionEvent[], firstSeq: number): boolean {
  const interval = events.filter(event => event.seq >= firstSeq)
  if (interval.some(event => event.type === 'tool/call')) return false
  const text = finalText(interval, firstSeq).trim()
  if (text === '') return true
  return /^(?:let me (?:think|consider)|i(?:'ll| will) (?:start|begin|handle|work)|我(?:先|将|会)(?:想|考虑|开始|处理)|接下来(?:我)?(?:会|将))/iu.test(text)
}

async function loadRunnerModules(): Promise<RunnerModules> {
  const require = createRequire(fileURLToPath(new URL('../../../apps/cli/package.json', import.meta.url)))
  const load = async (name: string): Promise<Record<string, unknown>> =>
    await import(pathToFileURL(require.resolve(name)).href) as Record<string, unknown>
  const [agent, llm, session] = await Promise.all([
    load('@deepseek-ai/dsh-agent'),
    load('@deepseek-ai/dsh-llm'),
    load('@deepseek-ai/dsh-session'),
  ])
  if (typeof agent.installModelSelection !== 'function'
    || typeof llm.createUserMessage !== 'function'
    || typeof session.SessionId !== 'function') {
    throw new Error('DSH 旅程驱动依赖缺少预期导出')
  }
  return {
    createUserMessage: llm.createUserMessage as RunnerModules['createUserMessage'],
    installModelSelection: agent.installModelSelection as RunnerModules['installModelSelection'],
    SessionId: session.SessionId as RunnerModules['SessionId'],
  }
}

function readTurnConfig(): TurnConfig {
  const action = process.env.MYTHOS_JOURNEY_ACTION
  const promptFile = process.env.MYTHOS_JOURNEY_PROMPT_FILE
  const sessionId = process.env.MYTHOS_JOURNEY_SESSION_ID
  if (action !== 'create' && action !== 'resume') {
    throw new Error('MYTHOS_JOURNEY_ACTION 必须是 create 或 resume')
  }
  if (typeof promptFile !== 'string' || promptFile === '') {
    throw new Error('缺少 MYTHOS_JOURNEY_PROMPT_FILE')
  }
  if (typeof sessionId !== 'string' || !/^session-[a-zA-Z0-9._-]+$/u.test(sessionId)) {
    throw new Error('MYTHOS_JOURNEY_SESSION_ID 格式无效')
  }
  const prompt = readFileSync(promptFile, 'utf8')
  unlinkSync(promptFile)
  delete process.env.MYTHOS_JOURNEY_PROMPT_FILE
  if (prompt.trim() === '' || prompt.length > 100_000) {
    throw new Error('旅程提示必须是 1..100000 字符')
  }
  return { action, prompt, sessionId }
}

function finalText(events: readonly SessionEvent[], firstSeq: number): string {
  const message = events.findLast(event => event.seq >= firstSeq && event.type === 'assistant/message')
  const data = message?.data
  const payload = data && typeof data.message === 'object' && data.message !== null
    ? data.message as { content?: unknown }
    : undefined
  const content = Array.isArray(payload?.content) ? payload.content : []
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join('')
}

async function run(ctx: RunnerContext, config: TurnConfig): Promise<void> {
  const loader = ctx.get('loader') as { await(): Promise<void> } | undefined
  await loader?.await()
  const exit = ctx.get('appExit') as ((code: number) => void) | undefined
  const agents = ctx.get('agents') as {
    create(options: Record<string, unknown>): Promise<{ agent: RunnerAgent }>
    resume(options: Record<string, unknown>): Promise<{ agent: RunnerAgent }>
  } | undefined
  const defaultModel = ctx.get('agentDefaultModel') as {
    currentSelection(): { model: string; provider: string }
  } | undefined
  const sessions = ctx.get('sessions') as { flush(session: unknown): Promise<void> } | undefined
  if (!exit || !agents || !defaultModel || !sessions) return

  const modules = await loadRunnerModules()
  const selection = defaultModel.currentSelection()
  const setup = (agentCtx: RunnerContext): void => {
    modules.installModelSelection(agentCtx, { current: selection, assembled: undefined })
  }
  const options = {
    agentOptions: { provider: selection.provider, model: selection.model },
    setup,
  }
  const handle = config.action === 'create'
    ? await agents.create({ ...options, sessionId: modules.SessionId(config.sessionId), meta: { cwd: process.cwd() } })
    : await agents.resume({ ...options, resumeSessionId: modules.SessionId(config.sessionId) })
  await handle.agent.whenIdle()
  const firstSeq = handle.agent.session.seq
  handle.agent.followup(modules.createUserMessage({
    content: [{ type: 'text', text: config.prompt }],
    source: { kind: 'user' },
  }))
  await handle.agent.whenIdle()
  if (shouldRecoverPlaceholderTurn(handle.agent.session.events, firstSeq)) {
    handle.agent.followup(modules.createUserMessage({
      content: [{ type: 'text', text: `上一轮只给出了占位回复，没有执行原任务。现在立即继续并完整完成原任务；必须使用工具取得客观证据。原任务：${config.prompt}` }],
      source: { kind: 'plugin', plugin: 'mythos-experience' },
    }))
    await handle.agent.whenIdle()
  }
  await sessions.flush(handle.agent.session)
  process.stdout.write(`${finalText(handle.agent.session.events, firstSeq)}\n`)
  exit(0)
}

interface RunnerAgent {
  followup(message: unknown): void
  session: { events: readonly SessionEvent[]; seq: number }
  whenIdle(): Promise<void>
}

export function apply(ctx: RunnerContext): void {
  const exit = ctx.get('appExit') as ((code: number) => void) | undefined
  if (!exit) throw new Error('旅程驱动器需要 appExit')
  let config: TurnConfig
  try {
    config = readTurnConfig()
  } catch (error) {
    process.stderr.write(`mythos journey: ${error instanceof Error ? error.message : String(error)}\n`)
    exit(1)
    return
  }
  void run(ctx, config).catch((error: unknown) => {
    process.stderr.write(`mythos journey: ${error instanceof Error ? error.message : String(error)}\n`)
    exit(1)
  })
}
