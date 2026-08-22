import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface EvaluationRuntimePaths {
  productRoot: string
  repoRoot: string
}

/** Resolves source and compiled evaluation modules to the same product and repository roots. */
export function evaluationRuntimePaths(moduleUrl: string): EvaluationRuntimePaths {
  const moduleParent = resolve(dirname(fileURLToPath(moduleUrl)), '..')
  const productRoot = basename(moduleParent) === '.mythos-eval-runtime'
    ? resolve(moduleParent, '..')
    : moduleParent
  return { productRoot, repoRoot: resolve(productRoot, '..', '..') }
}
