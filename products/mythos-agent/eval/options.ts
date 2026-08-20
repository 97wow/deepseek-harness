export const DEFAULT_EVALUATION_TIMEOUT_MS = 300_000

export function parseEvaluationTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_EVALUATION_TIMEOUT_MS
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 3_600_000) {
    throw new Error('MYTHOS_EVAL_TIMEOUT_MS 必须是 1000 到 3600000 之间的整数')
  }
  return value
}
