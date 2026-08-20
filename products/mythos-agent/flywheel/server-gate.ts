import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeServerDataset, evaluateServerGate, loadLatestServerDataset } from './server-dataset.js'

const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { health, rows } = await loadLatestServerDataset(join(productRoot, 'flywheel', 'data'))
const result = evaluateServerGate(analyzeServerDataset(rows), health)
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (!result.passed) process.exitCode = 1
