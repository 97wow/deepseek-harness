import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importServerDataset } from './server-dataset.js'

const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const datasetPath = process.env.MYTHOS_SERVER_FLYWHEEL
const healthPath = process.env.MYTHOS_SERVER_HEALTH
if (datasetPath === undefined || healthPath === undefined) {
  throw new Error('必须设置 MYTHOS_SERVER_FLYWHEEL 和 MYTHOS_SERVER_HEALTH')
}
const result = await importServerDataset({
  dataRoot: join(productRoot, 'flywheel', 'data'),
  datasetPath,
  healthPath,
})
process.stdout.write(`Mythos server flywheel: ${String(result.manifest.rows)} 条，SHA-256 ${result.manifest.datasetSha256}\n`)
