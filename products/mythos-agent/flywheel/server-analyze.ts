import { writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeServerDataset, loadLatestServerDataset } from './server-dataset.js'

const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = join(productRoot, 'flywheel', 'data')
const { health, rows } = await loadLatestServerDataset(dataRoot)
const summary = analyzeServerDataset(rows)
await writeFile(join(dataRoot, 'server', 'analysis.json'), `${JSON.stringify({ health, summary }, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
