import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { archiveFlywheel } from './archive.js'

const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const result = await archiveFlywheel({
  outputRoot: join(productRoot, 'flywheel', 'data'),
  productRoot,
  runsRoot: join(productRoot, 'runs'),
  sessionsRoot: join(productRoot, 'home', 'sessions'),
})
process.stdout.write(`Mythos flywheel: ${result.samples} 条标签，${result.rawSessions} 个原始会话已归档\n`)
