import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function journeyConfigurationSha256(productRoot: string): Promise<string> {
  const hash = createHash('sha256')
  for (const file of ['cordis.yml', 'cordis.patch.yml', 'package.json']) {
    hash.update(file)
    hash.update(await readFile(join(productRoot, 'home', 'profiles', 'mythos', file)))
  }
  for (const file of [
    'eval/journey-turn-runner.ts',
    'eval/journeys.ts',
    'eval/overlays/journey.yml',
    'eval/run-journeys.ts',
  ]) {
    hash.update(file)
    hash.update(await readFile(join(productRoot, file)))
  }
  return hash.digest('hex')
}
