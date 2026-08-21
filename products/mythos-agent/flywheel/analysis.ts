export interface CohortSummary {
  cacheReadTokensMean: number
  durationMsP50: number
  durationMsP95: number
  evidenceAfterMutationRate: number
  failedToolResultsMean: number
  inputTokensMean: number
  mutationCallsMean: number
  outputTokensMean: number
  passRate: number
  rawCoverage: number
  samples: number
  stepsMean: number
  timeoutRate: number
  toolCallsMean: number
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function quantile(values: number[], percentile: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(percentile * sorted.length) - 1] ?? 0
}

function mean(total: number, count: number): number {
  return count === 0 ? 0 : Math.round((total / count) * 100) / 100
}

export function summarizeCohort(labels: readonly Record<string, unknown>[]): CohortSummary {
  let passed = 0
  let timedOut = 0
  let withRaw = 0
  let input = 0
  let output = 0
  let cache = 0
  let evidenceAfterMutation = 0
  let failedToolResults = 0
  let mutationCalls = 0
  let mutationSamples = 0
  let steps = 0
  let toolCalls = 0
  const durations: number[] = []
  for (const label of labels) {
    const testCase = record(label.case)
    const metrics = record(testCase.metrics)
    if (testCase.passed === true) passed += 1
    if (testCase.timedOut === true) timedOut += 1
    if (label.raw !== null && label.raw !== undefined) withRaw += 1
    input += number(metrics.inputTokens)
    output += number(metrics.outputTokens)
    cache += number(metrics.cacheReadTokens)
    failedToolResults += number(metrics.failedToolResults)
    const sampleMutations = number(metrics.mutationCalls)
    mutationCalls += sampleMutations
    if (sampleMutations > 0) {
      mutationSamples += 1
      if (metrics.evidenceAfterMutation === true) evidenceAfterMutation += 1
    }
    steps += number(metrics.steps)
    toolCalls += Object.values(record(metrics.toolCalls))
      .reduce<number>((total, value) => total + number(value), 0)
    durations.push(number(testCase.durationMs))
  }
  const samples = labels.length
  return {
    cacheReadTokensMean: mean(cache, samples),
    durationMsP50: quantile(durations, 0.5),
    durationMsP95: quantile(durations, 0.95),
    evidenceAfterMutationRate: mutationSamples === 0 ? 1 : mean(evidenceAfterMutation, mutationSamples),
    failedToolResultsMean: mean(failedToolResults, samples),
    inputTokensMean: mean(input, samples),
    mutationCallsMean: mean(mutationCalls, samples),
    outputTokensMean: mean(output, samples),
    passRate: mean(passed, samples),
    rawCoverage: mean(withRaw, samples),
    samples,
    stepsMean: mean(steps, samples),
    timeoutRate: mean(timedOut, samples),
    toolCallsMean: mean(toolCalls, samples),
  }
}

export function cohortKey(label: Record<string, unknown>): string {
  const baseline = record(label.baseline)
  const testCase = record(label.case)
  return [
    String(baseline.dshVersion ?? 'unknown'),
    String(baseline.mythosVersion ?? 'unknown'),
    String(baseline.configurationSha256 ?? 'unknown'),
    String(baseline.variant ?? 'default'),
    String(testCase.id ?? 'unknown'),
  ].join(':')
}

export function summarizeByCohort(
  labels: readonly Record<string, unknown>[],
): Record<string, CohortSummary> {
  const groups = new Map<string, Record<string, unknown>[]>()
  for (const label of labels) {
    const key = cohortKey(label)
    const group = groups.get(key) ?? []
    group.push(label)
    groups.set(key, group)
  }
  return Object.fromEntries(
    [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([key, group]) => [key, summarizeCohort(group)]),
  )
}
