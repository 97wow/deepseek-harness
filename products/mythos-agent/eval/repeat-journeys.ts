import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEvaluationRepetitions } from './options.js'

const evalRoot = dirname(fileURLToPath(import.meta.url))
const repetitions = parseEvaluationRepetitions(process.env.MYTHOS_EVAL_REPETITIONS)
let failures = 0
for (let iteration = 1; iteration <= repetitions; iteration += 1) {
  process.stdout.write(`\n[Mythos Journey Replay] ${iteration}/${repetitions}\n`)
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', join(evalRoot, 'run-journeys.ts')], {
      env: process.env,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
  if (exitCode !== 0) failures += 1
}
process.stdout.write(`\n[Mythos Journey Replay] ${repetitions - failures}/${repetitions} 次运行通过\n`)
if (failures > 0) process.exitCode = 1
