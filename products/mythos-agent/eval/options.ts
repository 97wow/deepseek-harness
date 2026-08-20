export const DEFAULT_EVALUATION_TIMEOUT_MS = 300_000
export const DEFAULT_EVALUATION_REPETITIONS = 3

export function parseEvaluationTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_EVALUATION_TIMEOUT_MS
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 3_600_000) {
    throw new Error('MYTHOS_EVAL_TIMEOUT_MS 必须是 1000 到 3600000 之间的整数')
  }
  return value
}

export function parseEvaluationRepetitions(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_EVALUATION_REPETITIONS
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > 20) {
    throw new Error('MYTHOS_EVAL_REPETITIONS 必须是 1 到 20 之间的整数')
  }
  return value
}

export function parseReplayMetadata(
  iterationRaw: string | undefined,
  totalRaw: string | undefined,
): { iteration: number, total: number } | undefined {
  if (iterationRaw === undefined && totalRaw === undefined) return undefined
  if (iterationRaw === undefined || totalRaw === undefined) {
    throw new Error('回放 iteration 与 total 必须同时提供')
  }
  const iteration = Number(iterationRaw)
  const total = Number(totalRaw)
  if (!Number.isSafeInteger(iteration) || !Number.isSafeInteger(total)
    || iteration < 1 || total < 1 || iteration > total || total > 20) {
    throw new Error('回放 iteration/total 无效')
  }
  return { iteration, total }
}
