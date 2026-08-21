import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const evalRoot = dirname(fileURLToPath(import.meta.url))
const qwenRevision = '3e6447f082e89cc7f0bc6e5441afd38dfce760ff'
process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:18080/v1'
process.env.DEEPSEEK_API_KEY = 'mythos-loopback-only'
process.env.MYTHOS_EVAL_MODEL = `mlx-community/Qwen3.8-27B-4bit@${qwenRevision}`
process.env.MYTHOS_EVAL_PATCH = join(evalRoot, 'overlays', 'qwen-local.yml')
process.env.MYTHOS_EVAL_TIMEOUT_MS ??= '600000'
process.env.MYTHOS_EVAL_VARIANT = 'qwen3.8-27b-mlx-4bit'
process.env.MYTHOS_EVAL_ENTRY = 'qwen-local'

await import('./run.js')
