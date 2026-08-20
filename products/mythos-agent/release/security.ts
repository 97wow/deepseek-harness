const secretPatterns = [
  /\bsk-(?:relay-)?[A-Za-z0-9_-]{20,}\b/u,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9_./+-]{20,}/iu,
] as const

/**
 * Find credential-like values in release text without returning the values.
 * @param text - Tracked file contents.
 * @returns matched policy names only.
 */
export function exposedSecretPolicies(text: string): string[] {
  return secretPatterns.flatMap((pattern, index) => pattern.test(text) ? [`secret-pattern-${String(index + 1)}`] : [])
}
