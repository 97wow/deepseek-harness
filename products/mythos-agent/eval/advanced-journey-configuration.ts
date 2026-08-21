import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function advancedJourneyConfigurationSha256(productRoot: string): Promise<string> {
  const hash = createHash('sha256')
  for (const file of ['cordis.yml', 'cordis.patch.yml', 'package.json']) {
    hash.update(file)
    hash.update(await readFile(join(productRoot, 'home', 'profiles', 'mythos', file)))
  }
  for (const file of [
    'eval/journey-turn-runner.ts',
    'eval/advanced-journeys.ts',
    'eval/overlays/journey.yml',
    'eval/overlays/journey-compaction.yml',
    'eval/overlays/journey-subagent.yml',
    'eval/run-advanced-journeys.ts',
  ]) {
    hash.update(file)
    hash.update(await readFile(join(productRoot, file)))
  }
  return hash.digest('hex')
}
