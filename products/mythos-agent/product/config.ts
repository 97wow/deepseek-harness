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
  llmDeepseek: RecordValue
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

function rowConfig(rows: readonly RecordValue[], id: string): RecordValue {
  const row = rows.find(candidate => candidate.id === id)
  if (row === undefined) throw new Error(`缺少 ${id} 配置`)
  return object(row.config, `${id}.config`)
}

async function profileIdentity(profileRoot: string): Promise<ProductProfileIdentity> {
  const rows = await patchRows(join(profileRoot, 'cordis.patch.yml'))
  const llmDeepseek = rowConfig(rows, 'llm-deepseek')
  const agentDefaultModel = rowConfig(rows, 'agent-default-model')
  const systemPrompt = rowConfig(rows, 'system-prompt')
  return {
    agentDefaultModel,
    llmDeepseek,
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
  if (agentPresets.default !== 'mythos' || agentPresets.includeUserRoot !== true) {
    throw new Error('Web Profile 未把 mythos 设为默认 Agent Preset')
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
