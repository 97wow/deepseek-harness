import type { MythosProjectModel, StrategicDomain } from './project-model.js'

export const MYTHOS_CONTROLLER_ID = 'mythos-controller' as const

export type StrategicAction =
  | 'approve'
  | 'reject'
  | 'request-replan'
  | 'request-evidence'
  | 'pause'
  | 'stop'
  | 'accept-stage'
  | 'escalate-owner'

export interface DecisionOption {
  readonly id: string
  readonly action: StrategicAction
  readonly summary: string
  readonly expectedOutcomes: readonly string[]
  readonly risks: readonly string[]
  readonly principleImpacts: readonly string[]
}

export interface StrategicQuestion {
  readonly id: string
  readonly runId: string
  readonly domain: StrategicDomain
  readonly subject: string
  readonly context: readonly string[]
  readonly options: readonly DecisionOption[]
  readonly recommendedOptionId?: string
  readonly requiresExternalAuthority: boolean
  readonly irreversible: boolean
  readonly evidence: readonly string[]
  readonly submittedAtMs: number
}

export interface ProjectState {
  readonly revision: number
  readonly phase: string
  readonly objectives: readonly string[]
  readonly activeInitiatives: readonly string[]
  readonly knownRisks: readonly string[]
  readonly validatedFacts: readonly string[]
  readonly openQuestions: readonly string[]
  readonly updatedAtMs: number
}

export interface StrategicDecision {
  readonly controller: typeof MYTHOS_CONTROLLER_ID
  readonly sequence: number
  readonly questionId: string
  readonly projectRevision: number
  readonly action: StrategicAction
  readonly selectedOptionId?: string
  readonly rationale: string
  readonly governingPrinciples: readonly string[]
  readonly requiredEvidence: readonly string[]
  readonly directivesForLead: readonly string[]
  readonly decidedAtMs: number
}

export interface ControllerMemory {
  readonly revision: number
  readonly project: ProjectState
  readonly decisions: readonly StrategicDecision[]
}

export interface ControllerMemoryStore {
  load(): Promise<ControllerMemory>
  commit(expectedRevision: number, next: ControllerMemory): Promise<void>
}

/** Optional model arbitration receives decisions but has no tool or task API. */
export interface StrategicArbiter {
  decide(input: {
    readonly projectModel: MythosProjectModel
    readonly projectState: ProjectState
    readonly recentDecisions: readonly StrategicDecision[]
    readonly question: StrategicQuestion
    readonly allowedActions: readonly StrategicAction[]
  }): Promise<Omit<StrategicDecision, 'controller' | 'sequence' | 'projectRevision' | 'decidedAtMs'>>
}

/** This is the controller's entire outward authority surface. */
export interface ControllerPort {
  record(decision: StrategicDecision): Promise<void>
  directLead(decision: StrategicDecision): Promise<void>
  setProjectRunState(state: 'running' | 'paused' | 'stopped', decision: StrategicDecision): Promise<void>
}
