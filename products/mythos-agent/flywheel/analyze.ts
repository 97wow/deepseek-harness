import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { summarizeByCohort } from './analysis.js'

const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = join(productRoot, 'flywheel', 'data')
const index = (await readFile(join(dataRoot, 'index.jsonl'), 'utf8'))
  .split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
const labels = await Promise.all(index.map(async (row) => {
  if (typeof row.label !== 'string') throw new Error('飞轮索引缺少 label 路径')
  const path = resolve(dataRoot, row.label)
  if (!path.startsWith(`${dataRoot}${sep}`)) throw new Error('飞轮 label 路径越界')
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}))
const report = {
  cohorts: summarizeByCohort(labels),
  generatedAt: new Date().toISOString(),
  samples: labels.length,
}
await mkdir(dataRoot, { recursive: true })
const target = join(dataRoot, 'comparison.json')
const temporary = `${target}.${process.pid}.tmp`
await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
await rename(temporary, target)
process.stdout.write(`Mythos flywheel: 已分析 ${labels.length} 条样本、${Object.keys(report.cohorts).length} 个 cohort\n`)
