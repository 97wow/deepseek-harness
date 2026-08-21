import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  resolve: {
    alias: {
      '@deepseek-ai/dsh-agent/src/model-selection.ts': fileURLToPath(
        new URL('../../packages/core/agent/src/model-selection.ts', import.meta.url)),
      '@deepseek-ai/dsh-llm/message': fileURLToPath(new URL('../../packages/llm/llm/src/message.ts', import.meta.url)),
      '@deepseek-ai/dsh-session/types': fileURLToPath(new URL('../../packages/core/session/src/types.ts', import.meta.url)),
    },
  },
  test: {
    include: ['control/**/*.spec.ts', 'eval/**/*.spec.ts', 'flywheel/**/*.spec.ts', 'product/**/*.spec.ts', 'release/**/*.spec.ts'],
  },
})
