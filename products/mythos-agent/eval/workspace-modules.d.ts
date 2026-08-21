declare module '@deepseek-ai/dsh-agent/src/model-selection.ts' {
  export function installModelSelection(context: unknown, selection: unknown): void
}

declare module '@deepseek-ai/dsh-llm/message' {
  export function createUserMessage(text: string): unknown
}

declare module '@deepseek-ai/dsh-session/types' {
  export function SessionId(value: string): unknown
}
