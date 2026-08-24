import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'

type RecordValue = Record<string, unknown>

const cordisSchema = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('tag:yaml.org,2002:js', {
    construct: source => source,
    kind: 'scalar',
  }),
])

export interface ProductProfileIdentity {
  agentDefaultModel: RecordValue
  llmPiAi: RecordValue
  persona: string
}

function object(value: unknown, label: string): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`)
  }
  return value as RecordValue
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} 必须是非空字符串`)
  return value
}

async function yamlDocument(path: string): Promise<unknown> {
  return yaml.load(await readFile(path, 'utf8'), { schema: cordisSchema })
}

async function patchRows(path: string): Promise<RecordValue[]> {
  const value = await yamlDocument(path)
  if (!Array.isArray(value)) throw new Error(`${path} 必须是 patch 数组`)
  return value.map((row, index) => object(row, `${path}[${String(index)}]`))
}

function row(rows: readonly RecordValue[], id: string): RecordValue {
  const row = rows.find(candidate => candidate.id === id)
  if (row === undefined) throw new Error(`缺少 ${id} 配置`)
  return row
}

function rowConfig(rows: readonly RecordValue[], id: string): RecordValue {
  return object(row(rows, id).config, `${id}.config`)
}

function requireDisabled(rows: readonly RecordValue[], id: string): void {
  if (row(rows, id).disabled !== true) throw new Error(`${id} 必须在 Mythos 产品中禁用`)
}

async function profileIdentity(profileRoot: string): Promise<ProductProfileIdentity> {
  const rows = await patchRows(join(profileRoot, 'cordis.patch.yml'))
  requireDisabled(rows, 'llm-deepseek')
  const llmPiAi = rowConfig(rows, 'llm-pi-ai')
  const agentDefaultModel = rowConfig(rows, 'agent-default-model')
  const systemPrompt = rowConfig(rows, 'system-prompt')
  return {
    agentDefaultModel,
    llmPiAi,
    persona: text(systemPrompt.persona, 'system-prompt.config.persona'),
  }
}

async function profileBundles(profileRoot: string): Promise<string[]> {
  const manifest = object(JSON.parse(await readFile(join(profileRoot, 'package.json'), 'utf8')), 'profile package.json')
  const dsh = object(manifest.dsh, 'package.json.dsh')
  const profile = object(dsh.profile, 'package.json.dsh.profile')
  if (!Array.isArray(profile.bundles) || !profile.bundles.every(value => typeof value === 'string')) {
    throw new Error('package.json.dsh.profile.bundles 必须是字符串数组')
  }
  return profile.bundles
}

export async function verifyProductProfiles(productRoot: string): Promise<void> {
  const headlessRoot = join(productRoot, 'home', 'profiles', 'mythos')
  const webRoot = join(productRoot, 'home', 'profiles', 'mythos-web')
  const [headless, web, headlessBundles, webBundles, webRows, presetRows] = await Promise.all([
    profileIdentity(headlessRoot),
    profileIdentity(webRoot),
    profileBundles(headlessRoot),
    profileBundles(webRoot),
    patchRows(join(webRoot, 'cordis.patch.yml')),
    patchRows(join(productRoot, 'home', '.agent-presets', 'mythos', 'agent.cordis.yml')),
  ])

  if (JSON.stringify(headless) !== JSON.stringify(web)) throw new Error('Headless 与 Web 的 M3 配置或 persona 发生漂移')
  if (JSON.stringify(headlessBundles) !== JSON.stringify(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])) {
    throw new Error('Headless Profile 未使用官方 base + headless Bundle')
  }
  if (JSON.stringify(webBundles) !== JSON.stringify(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])) {
    throw new Error('Web Profile 未使用官方 base + web-app Bundle')
  }

  const agentPresets = rowConfig(webRows, 'agent-presets')
  if (agentPresets.default !== 'mythos' || agentPresets.includeUserRoot !== false) {
    throw new Error('Web Profile 必须固定 mythos Agent Preset 并禁止用户 Preset')
  }

  for (const id of [
    'ui-agent-preset',
    'ui-model-selection',
    'ui-settings-models',
    'ui-settings-plugin-inventory',
    'ui-settings-plugins',
    'plugin-inventory',
  ]) requireDisabled(webRows, id)

  const providers = object(headless.llmPiAi.providers, 'llm-pi-ai.config.providers')
  const mythos = object(providers.mythos, 'llm-pi-ai.config.providers.mythos')
  if (mythos.api !== 'anthropic-messages' || mythos.baseURL !== 'https://d.llmapi.pro:99') {
    throw new Error('Mythos 模型必须使用受控网关的 Anthropic 路由')
  }
  if (mythos.apiKeyEnv !== 'DEEPSEEK_API_KEY' || mythos.reasoning !== 'high') {
    throw new Error('Mythos 模型凭据或默认思考模式不正确')
  }
  if (!Array.isArray(mythos.models) || mythos.models.length !== 1) {
    throw new Error('Mythos 必须只公开一个模型')
  }
  const model = object(mythos.models[0], 'llm-pi-ai.config.providers.mythos.models[0]')
  if (model.id !== 'claude-sonnet-5' || model.name !== 'claude-sonnet-5') {
    throw new Error('Mythos 对外模型必须统一为 claude-sonnet-5')
  }
  if (model.contextWindow !== 1_000_000 || model.maxTokens !== 131_072) {
    throw new Error('claude-sonnet-5 未对齐 M3 的上下文或输出能力')
  }

  const defaultModel = headless.agentDefaultModel
  if (defaultModel.provider !== 'mythos' || defaultModel.model !== 'claude-sonnet-5') {
    throw new Error('默认模型未固定为 Mythos claude-sonnet-5 路由')
  }
  if (!headless.persona.includes('claude-sonnet-5') || headless.persona.includes('{{model}}')) {
    throw new Error('Persona 必须使用稳定的对外模型名称')
  }

  const webSearch = rowConfig(webRows, 'web-search-deepseek')
  if (webSearch.baseURL !== 'https://d.llmapi.pro:99/v1'
    || webSearch.model !== 'claude-sonnet-5'
    || webSearch.allowTextSourceFallback !== true) {
    throw new Error('Web 搜索必须走受控网关的 claude-sonnet-5 路由')
  }

  const presetPersona = rowConfig(presetRows, 'persona')
  if (text(presetPersona.text, 'persona.config.text') !== headless.persona) {
    throw new Error('Web Agent Preset persona 与 Mythos Profile 不一致')
  }

  const ids = new Set(presetRows.map(row => row.id).filter((id): id is string => typeof id === 'string'))
  const required = [
    'agent-instructions',
    'compaction',
    'delegation',
    'planning',
    'skill-filesystem',
    'tool-ask-user',
    'tool-bash',
    'tool-fs',
    'tool-goal',
    'tool-skill',
    'tool-todo',
    'tool-web',
  ]
  const missing = required.filter(id => !ids.has(id))
  if (missing.length > 0) throw new Error(`Mythos Agent Preset 缺少能力：${missing.join(', ')}`)
}
