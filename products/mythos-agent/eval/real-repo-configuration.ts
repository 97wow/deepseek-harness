import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function realRepoConfigurationSha256(productRoot: string, overlay?: string): Promise<string> {
  const hash = createHash('sha256')
  for (const file of ['cordis.yml', 'cordis.patch.yml', 'package.json']) {
    hash.update(file)
    hash.update(await readFile(join(productRoot, 'home', 'profiles', 'mythos', file)))
  }
  for (const file of ['eval/real-repo-cases.ts', 'eval/real-repo-configuration.ts', 'eval/run-real-repo.ts']) {
    hash.update(file)
    hash.update(await readFile(join(productRoot, file)))
  }
  if (overlay) {
    hash.update('real-repo-overlay')
    hash.update(await readFile(overlay))
  }
  return hash.digest('hex')
}
