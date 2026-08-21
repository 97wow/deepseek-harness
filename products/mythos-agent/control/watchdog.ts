import type { MythosController } from './controller.js'
import { projectReviewQuestion, type ProjectReviewSource } from './review.js'
import type { StrategicDecision } from './types.js'

export interface ProjectWatchdogOptions {
  readonly intervalMs?: number
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

/** Periodic whole-project review; it asks for decisions and never performs work. */
export class ProjectWatchdog {
  private readonly intervalMs: number
  private readonly setTimer: NonNullable<ProjectWatchdogOptions['setTimer']>
  private readonly clearTimer: NonNullable<ProjectWatchdogOptions['clearTimer']>
  private timer: ReturnType<typeof setTimeout> | undefined
  private running = false

  constructor(
    private readonly controller: MythosController,
    private readonly source: ProjectReviewSource,
    options: ProjectWatchdogOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 5 * 60_000
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1_000) {
      throw new Error('MYTHOS 总控检查周期必须是至少 1000ms 的整数')
    }
    this.setTimer = options.setTimer ?? setTimeout
    this.clearTimer = options.clearTimer ?? clearTimeout
  }

  async start(): Promise<StrategicDecision> {
    this.running = true
    return await this.checkpoint()
  }

  stop(): void {
    this.running = false
    if (this.timer !== undefined) this.clearTimer(this.timer)
    this.timer = undefined
  }

  async checkpoint(): Promise<StrategicDecision> {
    const snapshot = await this.source.snapshot()
    const decision = await this.controller.decide(projectReviewQuestion(snapshot))
    this.schedule()
    return decision
  }

  private schedule(): void {
    if (!this.running) return
    if (this.timer !== undefined) this.clearTimer(this.timer)
    this.timer = this.setTimer(() => {
      this.timer = undefined
      void this.checkpoint().catch(() => { this.schedule() })
    }, this.intervalMs)
  }
}
