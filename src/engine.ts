import { createHash } from 'node:crypto'

export const ENGINE_SCHEMA_VERSION = 1

export type VarValue = number | boolean

export type GuardOp = '==' | '!=' | '<' | '<=' | '>' | '>='

export interface LeafGuard {
  variable: string
  op: GuardOp
  value: VarValue
}

export interface AllGuard {
  all: GuardNode[]
}

export interface AnyGuard {
  any: GuardNode[]
}

export interface NotGuard {
  not: GuardNode
}

export type GuardNode = LeafGuard | AllGuard | AnyGuard | NotGuard

export interface StateSpec {
  id: string
  terminal?: boolean
  /** Actions fired automatically when the state is entered. They do not change state or variables; checks such as A4 Pair Symmetry treat them as implicit acquire/release events so lock/unlock hidden inside entry actions is verified. */
  onEntry?: string[]
  /** Actions fired automatically when the state is left. Same semantics as onEntry. */
  onExit?: string[]
}

export interface UpdateSpec {
  variable: string
  op: 'set' | 'inc' | 'dec'
  value?: number
}

export interface TransitionSpec {
  from: string
  event: string
  to: string
  /** Absent guard is the else/default branch for the same (from, event) group. */
  guard?: GuardNode
  updates?: UpdateSpec[]
  /** Execution cost of firing this transition (e.g. cycles, microseconds). Absent cost defaults to 1, so an unannotated machine keeps step-count semantics. Checked by A12 against budget invariants. */
  cost?: number
  /** Relative probability weight when a probability invariant is declared (DTMC interpretation). Absent weight = 1; weight 0 means the branch never fires probabilistically. */
  weight?: number
}

export interface TransitionScenarioSpec {
  from: string
  event: string
  /** Natural language: what this (state, event) combination represents in the real scenario. */
  scenario: string
}

export interface ModelNarrative {
  /** Natural-language meaning of each state id. */
  states?: Record<string, string>
  /** Natural-language meaning of each event id. */
  events?: Record<string, string>
  /** Natural-language scenario for each distinct (from, event) combination. */
  scenarios?: TransitionScenarioSpec[]
}

export interface VariableSpec {
  name: string
  kind: 'integer' | 'boolean'
  init: number | boolean
  min?: number
  max?: number
  monotonic?: 'inc' | 'dec'
}

export type InvariantSpec =
  | { id: string; description: string; kind: 'never-states'; states: string[] }
  | { id: string; description: string; kind: 'var-in-range'; variable: string; min?: number; max?: number }
  | { id: string; description: string; kind: 'event-before-state'; event: string; state: string }
  | { id: string; description: string; kind: 'leads-to'; from: string; to: string }
  | { id: string; description: string; kind: 'sequence'; events: string[] }
  | { id: string; description: string; kind: 'atomicity'; events: string[]; commit: string; rollback?: string }
  | { id: string; description: string; kind: 'budget'; budget: number }
  | { id: string; description: string; kind: 'probability'; target: string; op: '>=' | '<=' | '>' | '<'; p: number }

export interface ResourcePairSpec {
  resource: string
  acquireEvent: string
  releaseEvent: string
  failEvent?: string
}

export interface BoundaryCheckSpec {
  variable: string
  values: number[]
}

export interface LogicModelV1 {
  schemaVersion: 1
  init: string
  states: StateSpec[]
  transitions: TransitionSpec[]
  variables?: VariableSpec[]
  invariants?: InvariantSpec[]
  concurrentPairs?: [string, string][]
  boundaryChecks?: BoundaryCheckSpec[]
  resourcePairs?: ResourcePairSpec[]
  idempotentEvents?: string[]
  /** Natural-language descriptions of states, events, and (state, event) scenarios. */
  narrative?: ModelNarrative
}

export interface VerificationOptions {
  maxStates?: number
  maxPermutationEvents?: number
  beforeModel?: unknown
  stateMapping?: Record<string, string>
}

export interface PathStep {
  from: string
  event: string
  to: string
}

export interface Finding {
  code: string
  severity: 'error' | 'warning'
  message: string
  path?: PathStep[]
  evidence?: Record<string, unknown>
}

export interface CheckResult {
  id: string
  name: string
  status: 'pass' | 'fail' | 'skip'
  detail: string
  findings: Finding[]
}

export interface VerificationReport {
  ok: boolean
  schemaVersion: 1
  modelHash: string
  /** Echo of the model's natural-language narrative, when present. */
  narrative?: ModelNarrative
  summary: {
    states: number
    transitions: number
    errors: number
    warnings: number
    checksRun: number
    truncated?: boolean
  }
  checks: CheckResult[]
  comparison?: ComparisonSummary
  /** Informational notes about semantic dimensions this model references (timing, preemption)
   * that this engine does not verify. Heuristic, vocabulary-based — never a substitute for the checks. */
  coverageNotes?: string[]
}

export interface ComparisonSummary {
  beforeModelHash: string
  afterModelHash: string
  stateMapping: Record<string, string>
  beforeStates: number
  beforeTransitions: number
  afterStates: number
  afterTransitions: number
  addedStates: string[]
  removedStates: string[]
  addedEvents: string[]
  removedEvents: string[]
  addedTransitions: TransitionSpec[]
  removedTransitions: TransitionSpec[]
}

export interface RuntimeState {
  state: string
  vars: Record<string, VarValue>
}

type NormalizedOptions = Required<Pick<VerificationOptions, 'maxStates' | 'maxPermutationEvents'>>

const DEFAULT_MAX_STATES = 10_000
const DEFAULT_MAX_PERMUTATION_EVENTS = 5

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']'
  const record = value as Record<string, unknown>
  return '{' + Object.keys(record).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(record[key])).join(',') + '}'
}

export function modelHash(model: LogicModelV1): string {
  return createHash('sha256').update(stableStringify(model)).digest('hex')
}

export function validateModel(input: unknown): { ok: true; model: LogicModelV1 } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const bad = (path: string, message: string): void => {
    errors.push(path + ': ' + message)
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['model: must be an object'] }
  }
  const root = input as Record<string, unknown>
  if (root.schemaVersion !== 1) bad('schemaVersion', 'must be 1')
  if (typeof root.init !== 'string' || root.init.length === 0) bad('init', 'must be a non-empty string')
  if (!Array.isArray(root.states) || root.states.length === 0) {
    bad('states', 'must be a non-empty array')
  } else {
    const seen = new Set<string>()
    root.states.forEach((entry, index) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        bad('states[' + index + ']', 'must be an object')
        return
      }
      const state = entry as Record<string, unknown>
      if (typeof state.id !== 'string' || state.id.length === 0) bad('states[' + index + '].id', 'must be a non-empty string')
      else if (seen.has(state.id)) bad('states[' + index + '].id', 'duplicate state id ' + state.id)
      else seen.add(state.id)
      if (state.terminal !== undefined && typeof state.terminal !== 'boolean') bad('states[' + index + '].terminal', 'must be a boolean')
      for (const kind of ['onEntry', 'onExit'] as const) {
        const actions = state[kind]
        if (actions !== undefined) {
          if (!Array.isArray(actions)) bad('states[' + index + '].' + kind, 'must be an array of action names')
          else if (actions.length > 64) bad('states[' + index + '].' + kind, 'must not exceed 64 actions')
          else actions.forEach((action, actionIndex) => {
            if (typeof action !== 'string' || action.length === 0) bad('states[' + index + '].' + kind + '[' + actionIndex + ']', 'must be a non-empty string')
          })
        }
      }
    })
    if (typeof root.init === 'string' && root.init.length > 0 && !seen.has(root.init)) bad('init', 'must name a declared state')
  }
  if (!Array.isArray(root.transitions)) {
    bad('transitions', 'must be an array')
  } else {
    const stateIds = new Set<string>(Array.isArray(root.states) ? (root.states as StateSpec[]).map((state) => state.id) : [])
    root.transitions.forEach((entry, index) => {
      const path = 'transitions[' + index + ']'
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        bad(path, 'must be an object')
        return
      }
      const transition = entry as Record<string, unknown>
      if (typeof transition.from !== 'string' || transition.from.length === 0) bad(path + '.from', 'must be a non-empty string')
      else if (!stateIds.has(transition.from)) bad(path + '.from', 'unknown state ' + transition.from)
      if (typeof transition.event !== 'string' || transition.event.length === 0) bad(path + '.event', 'must be a non-empty string')
      if (typeof transition.to !== 'string' || transition.to.length === 0) bad(path + '.to', 'must be a non-empty string')
      else if (!stateIds.has(transition.to)) bad(path + '.to', 'unknown state ' + transition.to)
      if (transition.guard !== undefined) validateGuard(transition.guard, path + '.guard', errors, bad)
      if (transition.updates !== undefined) {
        if (!Array.isArray(transition.updates)) bad(path + '.updates', 'must be an array')
        else transition.updates.forEach((update, updateIndex) => {
          const updatePath = path + '.updates[' + updateIndex + ']'
          if (typeof update !== 'object' || update === null || Array.isArray(update)) {
            bad(updatePath, 'must be an object')
            return
          }
          const record = update as Record<string, unknown>
          if (typeof record.variable !== 'string' || record.variable.length === 0) bad(updatePath + '.variable', 'must be a non-empty string')
          if (record.op !== 'set' && record.op !== 'inc' && record.op !== 'dec') bad(updatePath + '.op', "must be 'set', 'inc', or 'dec'")
          if (record.value !== undefined && typeof record.value !== 'number') bad(updatePath + '.value', 'must be a number')
        })
      }
      if (transition.cost !== undefined) {
        if (typeof transition.cost !== 'number' || !Number.isFinite(transition.cost) || transition.cost < 0) bad(path + '.cost', 'must be a non-negative finite number')
      }
      if (transition.weight !== undefined) {
        if (typeof transition.weight !== 'number' || !Number.isFinite(transition.weight) || transition.weight < 0) bad(path + '.weight', 'must be a non-negative finite number')
      }
    })
  }
  const variableNames = new Set<string>()
  if (root.variables !== undefined) {
    if (!Array.isArray(root.variables)) bad('variables', 'must be an array')
    else root.variables.forEach((entry, index) => {
      const path = 'variables[' + index + ']'
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        bad(path, 'must be an object')
        return
      }
      const variable = entry as Record<string, unknown>
      if (typeof variable.name !== 'string' || variable.name.length === 0) bad(path + '.name', 'must be a non-empty string')
      else if (variableNames.has(variable.name)) bad(path + '.name', 'duplicate variable ' + variable.name)
      else variableNames.add(variable.name)
      if (variable.kind !== 'integer' && variable.kind !== 'boolean') bad(path + '.kind', "must be 'integer' or 'boolean'")
      const expected = variable.kind === 'boolean' ? 'boolean' : 'number'
      if (typeof variable.init !== expected) bad(path + '.init', 'must be a ' + expected)
      if (variable.min !== undefined && typeof variable.min !== 'number') bad(path + '.min', 'must be a number')
      if (variable.max !== undefined && typeof variable.max !== 'number') bad(path + '.max', 'must be a number')
      if (typeof variable.min === 'number' && typeof variable.max === 'number' && variable.min > variable.max) bad(path + '.max', 'must be >= min')
      if (variable.monotonic !== undefined && variable.monotonic !== 'inc' && variable.monotonic !== 'dec') bad(path + '.monotonic', "must be 'inc' or 'dec'")
      if (variable.kind === 'integer' && typeof variable.init === 'number') {
        if (typeof variable.min === 'number' && variable.init < variable.min) bad(path + '.init', 'must be >= min')
        if (typeof variable.max === 'number' && variable.init > variable.max) bad(path + '.init', 'must be <= max')
      }
    })
  }
  const validateVariableRef = (name: unknown, path: string): void => {
    if (typeof name !== 'string' || name.length === 0) bad(path, 'must be a non-empty string')
    else if (!variableNames.has(name)) bad(path, 'references unknown variable ' + name)
  }
  if (root.invariants !== undefined) {
    if (!Array.isArray(root.invariants)) bad('invariants', 'must be an array')
    else root.invariants.forEach((entry, index) => {
      const path = 'invariants[' + index + ']'
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        bad(path, 'must be an object')
        return
      }
      const invariant = entry as Record<string, unknown>
      if (typeof invariant.id !== 'string' || invariant.id.length === 0) bad(path + '.id', 'must be a non-empty string')
      if (typeof invariant.description !== 'string') bad(path + '.description', 'must be a string')
      if (invariant.kind === 'never-states') {
        if (!Array.isArray(invariant.states) || invariant.states.length === 0) bad(path + '.states', 'must be a non-empty array')
        else invariant.states.forEach((state, stateIndex) => {
          if (typeof state !== 'string' || state.length === 0) bad(path + '.states[' + stateIndex + ']', 'must be a non-empty string')
        })
      } else if (invariant.kind === 'var-in-range') {
        validateVariableRef(invariant.variable, path + '.variable')
        if (invariant.min !== undefined && typeof invariant.min !== 'number') bad(path + '.min', 'must be a number')
        if (invariant.max !== undefined && typeof invariant.max !== 'number') bad(path + '.max', 'must be a number')
      } else if (invariant.kind === 'event-before-state') {
        if (typeof invariant.event !== 'string' || invariant.event.length === 0) bad(path + '.event', 'must be a non-empty string')
        if (typeof invariant.state !== 'string' || invariant.state.length === 0) bad(path + '.state', 'must be a non-empty string')
      } else if (invariant.kind === 'leads-to') {
        if (typeof invariant.from !== 'string' || invariant.from.length === 0) bad(path + '.from', 'must be a non-empty string')
        if (typeof invariant.to !== 'string' || invariant.to.length === 0) bad(path + '.to', 'must be a non-empty string')
      } else if (invariant.kind === 'sequence') {
        if (!Array.isArray(invariant.events) || invariant.events.length === 0) bad(path + '.events', 'must be a non-empty array')
        else invariant.events.forEach((event, eventIndex) => {
          if (typeof event !== 'string' || event.length === 0) bad(path + '.events[' + eventIndex + ']', 'must be a non-empty string')
        })
      } else if (invariant.kind === 'atomicity') {
        if (!Array.isArray(invariant.events) || invariant.events.length === 0) bad(path + '.events', 'must be a non-empty array')
        else invariant.events.forEach((event, eventIndex) => {
          if (typeof event !== 'string' || event.length === 0) bad(path + '.events[' + eventIndex + ']', 'must be a non-empty string')
        })
        if (typeof invariant.commit !== 'string' || invariant.commit.length === 0) bad(path + '.commit', 'must be a non-empty string')
        if (invariant.rollback !== undefined && typeof invariant.rollback !== 'string') bad(path + '.rollback', 'must be a string')
      } else if (invariant.kind === 'budget') {
        if (typeof invariant.budget !== 'number' || !Number.isFinite(invariant.budget) || invariant.budget < 0) bad(path + '.budget', 'must be a non-negative finite number')
      } else if (invariant.kind === 'probability') {
        if (typeof invariant.target !== 'string' || invariant.target.length === 0) bad(path + '.target', 'must be a non-empty string')
        if (invariant.op !== '>=' && invariant.op !== '<=' && invariant.op !== '>' && invariant.op !== '<') bad(path + '.op', "must be one of '>=', '<=', '>', '<'")
        if (typeof invariant.p !== 'number' || !Number.isFinite(invariant.p) || invariant.p < 0 || invariant.p > 1) bad(path + '.p', 'must be a number in [0, 1]')
      } else {
        bad(path + '.kind', 'unknown invariant kind')
      }
    })
  }
  if (root.concurrentPairs !== undefined) {
    if (!Array.isArray(root.concurrentPairs)) bad('concurrentPairs', 'must be an array')
    else root.concurrentPairs.forEach((entry, index) => {
      const path = 'concurrentPairs[' + index + ']'
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') {
        bad(path, 'must be a [event, event] string pair')
      }
    })
  }
  if (root.boundaryChecks !== undefined) {
    if (!Array.isArray(root.boundaryChecks)) bad('boundaryChecks', 'must be an array')
    else root.boundaryChecks.forEach((entry, index) => {
      const path = 'boundaryChecks[' + index + ']'
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        bad(path, 'must be an object')
        return
      }
      const check = entry as Record<string, unknown>
      validateVariableRef(check.variable, path + '.variable')
      if (!Array.isArray(check.values) || check.values.some((value) => typeof value !== 'number')) bad(path + '.values', 'must be an array of numbers')
    })
  }
  if (root.idempotentEvents !== undefined) {
    if (!Array.isArray(root.idempotentEvents)) bad('idempotentEvents', 'must be an array')
    else root.idempotentEvents.forEach((entry, index) => {
      if (typeof entry !== 'string' || entry.length === 0) bad('idempotentEvents[' + index + ']', 'must be a non-empty string')
    })
  }
  if (root.resourcePairs !== undefined) {
    if (!Array.isArray(root.resourcePairs)) bad('resourcePairs', 'must be an array')
    else root.resourcePairs.forEach((entry, index) => {
      const path = 'resourcePairs[' + index + ']'
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        bad(path, 'must be an object')
        return
      }
      const pair = entry as Record<string, unknown>
      if (typeof pair.resource !== 'string' || pair.resource.length === 0) bad(path + '.resource', 'must be a non-empty string')
      if (typeof pair.acquireEvent !== 'string' || pair.acquireEvent.length === 0) bad(path + '.acquireEvent', 'must be a non-empty string')
      if (typeof pair.releaseEvent !== 'string' || pair.releaseEvent.length === 0) bad(path + '.releaseEvent', 'must be a non-empty string')
      if (pair.failEvent !== undefined && typeof pair.failEvent !== 'string') bad(path + '.failEvent', 'must be a string')
    })
  }
  if (root.narrative !== undefined) {
    const narrativePath = 'narrative'
    if (typeof root.narrative !== 'object' || root.narrative === null || Array.isArray(root.narrative)) {
      bad(narrativePath, 'must be an object')
    } else {
      const narrative = root.narrative as Record<string, unknown>
      const stateIds = new Set<string>(Array.isArray(root.states) ? (root.states as StateSpec[]).map((state) => state.id) : [])
      const eventIds = new Set<string>(Array.isArray(root.transitions) ? (root.transitions as TransitionSpec[]).map((transition) => transition.event) : [])
      const fromEventGroups = new Set<string>(Array.isArray(root.transitions) ? (root.transitions as TransitionSpec[]).map((transition) => transition.from + '|' + transition.event) : [])
      if (typeof narrative.states !== 'object' || narrative.states === null || Array.isArray(narrative.states)) {
        bad(narrativePath + '.states', 'must be an object mapping state id -> natural-language description')
      } else {
        for (const [id, description] of Object.entries(narrative.states as Record<string, unknown>)) {
          if (!stateIds.has(id)) bad(narrativePath + '.states', 'references unknown state ' + id)
          if (typeof description !== 'string' || description.length === 0) bad(narrativePath + '.states.' + id, 'must be a non-empty string')
        }
        for (const id of stateIds) {
          if (typeof (narrative.states as Record<string, unknown>)[id] !== 'string') bad(narrativePath + '.states', 'missing description for state ' + id)
        }
      }
      if (typeof narrative.events !== 'object' || narrative.events === null || Array.isArray(narrative.events)) {
        bad(narrativePath + '.events', 'must be an object mapping event id -> natural-language description')
      } else {
        for (const [id, description] of Object.entries(narrative.events as Record<string, unknown>)) {
          if (!eventIds.has(id)) bad(narrativePath + '.events', 'references unknown event ' + id)
          if (typeof description !== 'string' || description.length === 0) bad(narrativePath + '.events.' + id, 'must be a non-empty string')
        }
        for (const id of eventIds) {
          if (typeof (narrative.events as Record<string, unknown>)[id] !== 'string') bad(narrativePath + '.events', 'missing description for event ' + id)
        }
      }
      if (!Array.isArray(narrative.scenarios)) {
        bad(narrativePath + '.scenarios', 'must be an array of { from, event, scenario }')
      } else {
        const seen = new Set<string>()
        narrative.scenarios.forEach((entry, index) => {
          const scenarioPath = narrativePath + '.scenarios[' + index + ']'
          if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            bad(scenarioPath, 'must be an object')
            return
          }
          const scenario = entry as Record<string, unknown>
          if (typeof scenario.from !== 'string' || scenario.from.length === 0) bad(scenarioPath + '.from', 'must be a non-empty string')
          else if (!stateIds.has(scenario.from)) bad(scenarioPath + '.from', 'unknown state ' + scenario.from)
          if (typeof scenario.event !== 'string' || scenario.event.length === 0) bad(scenarioPath + '.event', 'must be a non-empty string')
          else if (!eventIds.has(scenario.event)) bad(scenarioPath + '.event', 'unknown event ' + scenario.event)
          if (typeof scenario.scenario !== 'string' || scenario.scenario.length === 0) bad(scenarioPath + '.scenario', 'must be a non-empty string')
          const key = String(scenario.from) + '|' + String(scenario.event)
          if (seen.has(key)) bad(scenarioPath, 'duplicate scenario for (' + scenario.from + ', ' + scenario.event + ')')
          seen.add(key)
        })
        for (const key of fromEventGroups) {
          if (!seen.has(key)) {
            const sep = key.indexOf('|')
            bad(narrativePath + '.scenarios', 'missing scenario for (' + key.slice(0, sep) + ', ' + key.slice(sep + 1) + ')')
          }
        }
      }
    }
  }
  // Guard/update variable references were validated structurally; re-walk for references.
  if (Array.isArray(root.transitions)) {
    for (const entry of root.transitions as TransitionSpec[]) {
      walkGuardReferences(entry.guard, variableNames, errors, bad)
      for (const update of entry.updates ?? []) {
        if (!variableNames.has(update.variable)) bad('transitions.updates', 'references unknown variable ' + update.variable)
        if (update.op !== 'set' && update.value !== undefined && update.value === 0) {
          // zero delta is harmless; no finding
        }
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, model: root as unknown as LogicModelV1 }
}

function validateGuard(input: unknown, path: string, errors: string[], bad: (path: string, message: string) => void): void {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    bad(path, 'must be an object')
    return
  }
  const guard = input as Record<string, unknown>
  if (guard.variable !== undefined) {
    if (typeof guard.variable !== 'string' || guard.variable.length === 0) bad(path + '.variable', 'must be a non-empty string')
    if (guard.op !== '==' && guard.op !== '!=' && guard.op !== '<' && guard.op !== '<=' && guard.op !== '>' && guard.op !== '>=') bad(path + '.op', 'must be a comparison operator')
    if (typeof guard.value !== 'number' && typeof guard.value !== 'boolean') bad(path + '.value', 'must be a number or boolean')
    return
  }
  if (guard.all !== undefined) {
    if (!Array.isArray(guard.all)) bad(path + '.all', 'must be an array')
    else guard.all.forEach((child, index) => validateGuard(child, path + '.all[' + index + ']', errors, bad))
    return
  }
  if (guard.any !== undefined) {
    if (!Array.isArray(guard.any)) bad(path + '.any', 'must be an array')
    else guard.any.forEach((child, index) => validateGuard(child, path + '.any[' + index + ']', errors, bad))
    return
  }
  if (guard.not !== undefined) {
    validateGuard(guard.not, path + '.not', errors, bad)
    return
  }
  bad(path, 'must be a leaf ({ variable, op, value }), { all }, { any }, or { not }')
}

function walkGuardReferences(guard: GuardNode | undefined, variableNames: Set<string>, errors: string[], bad: (path: string, message: string) => void): void {
  if (guard === undefined) return
  if ('variable' in guard) {
    if (!variableNames.has(guard.variable)) bad('guard', 'references unknown variable ' + guard.variable)
    return
  }
  if ('all' in guard) {
    for (const child of guard.all) walkGuardReferences(child, variableNames, errors, bad)
    return
  }
  if ('any' in guard) {
    for (const child of guard.any) walkGuardReferences(child, variableNames, errors, bad)
    return
  }
  if ('not' in guard) walkGuardReferences(guard.not, variableNames, errors, bad)
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

function isLeafGuard(guard: GuardNode): guard is LeafGuard {
  return 'variable' in guard
}

export function guardVariables(guard: GuardNode | undefined): string[] {
  if (guard === undefined) return []
  if (isLeafGuard(guard)) return [guard.variable]
  if ('all' in guard) return guard.all.flatMap((child) => guardVariables(child))
  if ('any' in guard) return guard.any.flatMap((child) => guardVariables(child))
  if ('not' in guard) return guardVariables(guard.not)
  return []
}

function evalGuard(guard: GuardNode, vars: Record<string, VarValue>): boolean {
  if (isLeafGuard(guard)) {
    const actual = vars[guard.variable]
    switch (guard.op) {
      case '==': return actual === guard.value
      case '!=': return actual !== guard.value
      case '<': return (actual as number) < (guard.value as number)
      case '<=': return (actual as number) <= (guard.value as number)
      case '>': return (actual as number) > (guard.value as number)
      case '>=': return (actual as number) >= (guard.value as number)
    }
  }
  if ('all' in guard) return guard.all.every((child) => evalGuard(child, vars))
  if ('any' in guard) return guard.any.some((child) => evalGuard(child, vars))
  if ('not' in guard) return !evalGuard(guard.not, vars)
  return false
}

function initialState(model: LogicModelV1): RuntimeState {
  const vars: Record<string, VarValue> = {}
  for (const variable of model.variables ?? []) vars[variable.name] = variable.init
  return { state: model.init, vars }
}

function runtimeKey(runtime: RuntimeState): string {
  return runtime.state + '|' + stableStringify(runtime.vars)
}

function applyUpdates(model: LogicModelV1, transition: TransitionSpec, runtime: RuntimeState): RuntimeState {
  const vars = { ...runtime.vars }
  for (const update of transition.updates ?? []) {
    const current = vars[update.variable]
    if (update.op === 'set') vars[update.variable] = update.value ?? 0
    else if (update.op === 'inc') vars[update.variable] = ((typeof current === 'number' ? current : 0) + (update.value ?? 1))
    else vars[update.variable] = ((typeof current === 'number' ? current : 0) - (update.value ?? 1))
  }
  return { state: transition.to, vars }
}

function groupTransitions(model: LogicModelV1): Map<string, TransitionSpec[]> {
  const groups = new Map<string, TransitionSpec[]>()
  for (const transition of model.transitions) {
    const key = transition.from + '|' + transition.event
    const list = groups.get(key) ?? []
    list.push(transition)
    groups.set(key, list)
  }
  return groups
}

function applicableTransitions(group: TransitionSpec[], runtime: RuntimeState): TransitionSpec[] {
  const guarded: TransitionSpec[] = []
  const unguarded: TransitionSpec[] = []
  for (const transition of group) {
    if (transition.guard === undefined) unguarded.push(transition)
    else guarded.push(transition)
  }
  const matched = guarded.filter((transition) => evalGuard(transition.guard!, runtime.vars))
  if (matched.length > 0) return matched
  return unguarded
}

function stepRuntime(model: LogicModelV1, runtime: RuntimeState, event: string): RuntimeState[] {
  const group = groupTransitions(model).get(runtime.state + '|' + event)
  if (group === undefined || group.length === 0) return []
  const seen = new Set<string>()
  const outcomes: RuntimeState[] = []
  for (const transition of applicableTransitions(group, runtime)) {
    const next = applyUpdates(model, transition, runtime)
    const key = runtimeKey(next)
    if (!seen.has(key)) {
      seen.add(key)
      outcomes.push(next)
    }
  }
  return outcomes
}

interface Exploration {
  reachable: RuntimeState[]
  reachableKeys: Set<string>
  truncated: boolean
  initialState: RuntimeState
}

function explore(model: LogicModelV1, options: NormalizedOptions): Exploration {
  const init = initialState(model)
  const reachable: RuntimeState[] = []
  const reachableKeys = new Set<string>()
  const queue: RuntimeState[] = [init]
  let truncated = false
  while (queue.length > 0) {
    const runtime = queue.shift()!
    const key = runtimeKey(runtime)
    if (reachableKeys.has(key)) continue
    reachableKeys.add(key)
    reachable.push(runtime)
    if (reachable.length > options.maxStates) {
      truncated = true
      break
    }
    for (const event of allEvents(model)) {
      for (const next of stepRuntime(model, runtime, event)) {
        if (!reachableKeys.has(runtimeKey(next))) queue.push(next)
      }
    }
  }
  return { reachable, reachableKeys, truncated, initialState: init }
}

function allEvents(model: LogicModelV1): string[] {
  return [...new Set(model.transitions.map((transition) => transition.event))].sort()
}

function stateById(model: LogicModelV1, id: string): StateSpec | undefined {
  return model.states.find((state) => state.id === id)
}

function isTerminal(model: LogicModelV1, state: string): boolean {
  return stateById(model, state)?.terminal === true
}

function uniqueTargets(transitions: TransitionSpec[]): string[] {
  return [...new Set(transitions.map((transition) => transition.to))]
}

function checkResult(id: string, name: string, findings: Finding[], detail: string): CheckResult {
  const errors = findings.filter((finding) => finding.severity === 'error').length
  const warnings = findings.filter((finding) => finding.severity === 'warning').length
  return {
    id,
    name,
    status: findings.length === 0 ? 'pass' : 'fail',
    detail: detail + (errors > 0 ? ' (' + errors + ' errors' + (warnings > 0 ? ', ' + warnings + ' warnings' : '') + ')' : warnings > 0 ? ' (' + warnings + ' warnings)' : ''),
    findings,
  }
}

// ---------------------------------------------------------------------------
// S1-S7
// ---------------------------------------------------------------------------

function S1_reachability(model: LogicModelV1, exploration: Exploration): CheckResult {
  const reached = new Set(exploration.reachable.map((runtime) => runtime.state))
  const unreachable = model.states.filter((state) => !reached.has(state.id)).map((state) => state.id)
  const findings: Finding[] = unreachable.map((state) => ({
    code: 'S1_UNREACHABLE_STATE',
    severity: 'warning',
    message: 'State ' + state + ' is not reachable from init.',
  }))
  return checkResult('S1', 'Reachability', findings, unreachable.length === 0 ? 'All states reachable' : 'Unreachable states: ' + unreachable.join(', '))
}

function S2_deadlock(model: LogicModelV1): CheckResult {
  const outgoing = new Set(model.transitions.map((transition) => transition.from))
  const findings: Finding[] = []
  for (const state of model.states) {
    if (state.terminal === true) continue
    if (!outgoing.has(state.id)) {
      findings.push({
        code: 'S2_NO_TRANSITIONS',
        severity: 'error',
        message: 'Non-terminal state ' + state.id + ' has no outgoing transitions.',
      })
    }
  }
  return checkResult('S2', 'Deadlock', findings, findings.length === 0 ? 'No deadlocks' : 'Deadlocks: ' + findings.map((finding) => finding.message).join('; '))
}

function sccs(model: LogicModelV1): string[][] {
  const states = model.states.map((state) => state.id)
  const edges = new Map<string, string[]>()
  for (const state of states) edges.set(state, [])
  for (const transition of model.transitions) {
    const list = edges.get(transition.from)
    if (list !== undefined) list.push(transition.to)
  }
  let index = 0
  const indices = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  const visit = (node: string): void => {
    indices.set(node, index)
    low.set(node, index)
    index += 1
    stack.push(node)
    onStack.add(node)
    for (const next of edges.get(node) ?? []) {
      if (!indices.has(next)) {
        visit(next)
        low.set(node, Math.min(low.get(node)!, low.get(next)!))
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node)!, indices.get(next)!))
      }
    }
    if (low.get(node) === indices.get(node)) {
      const component: string[] = []
      while (stack.length > 0) {
        const member = stack.pop()!
        onStack.delete(member)
        component.push(member)
        if (member === node) break
      }
      components.push(component)
    }
  }
  for (const state of states) {
    if (!indices.has(state)) visit(state)
  }
  return components
}

function S3_liveness(model: LogicModelV1): CheckResult {
  const components = sccs(model)
  const findings: Finding[] = []
  for (const component of components) {
    const componentSet = new Set(component)
    const internalEdges = model.transitions.filter((transition) => componentSet.has(transition.from) && componentSet.has(transition.to))
    const escapingEdges = model.transitions.filter((transition) => componentSet.has(transition.from) && !componentSet.has(transition.to))
    if (internalEdges.length === 0 || escapingEdges.length > 0) continue
    if (component.some((state) => isTerminal(model, state))) continue
    findings.push({
      code: 'S3_CLOSED_SCC',
      severity: 'error',
      message: 'Closed SCC has no exit and contains no terminal state: ' + component.sort().join(', '),
      evidence: { states: component.sort(), transitions: internalEdges.length },
    })
  }
  return checkResult('S3', 'Liveness', findings, findings.length === 0 ? 'No harmful closed SCCs' : 'Closed SCCs: ' + findings.length)
}

function assignmentsFor(model: LogicModelV1, variables: string[]): Array<Record<string, VarValue>> | null {
  const specs = (model.variables ?? []).filter((variable) => variables.includes(variable.name))
  let combinations: Array<Record<string, VarValue>> = [{}]
  for (const spec of specs) {
    let values: VarValue[]
    if (spec.kind === 'boolean') values = [false, true]
    else {
      const constants = collectGuardConstants(model).filter((value) => guardLeaves(model).some((leaf) => leaf.variable === spec.name && typeof leaf.value === 'number' && leaf.value === value))
      if (spec.min !== undefined && spec.max !== undefined) {
        values = []
        for (let value = spec.min; value <= spec.max && value <= spec.min + 200; value++) values.push(value)
      } else {
        const set = new Set<number>([-1, 0, 1, ...constants])
        values = [...set].sort((a, b) => a - b)
      }
    }
    const next: Array<Record<string, VarValue>> = []
    for (const assignment of combinations) {
      for (const value of values) {
        next.push({ ...assignment, [spec.name]: value })
        if (next.length > 10_000) return null
      }
    }
    combinations = next
  }
  return combinations
}

function guardLeaves(model: LogicModelV1): LeafGuard[] {
  const leaves: LeafGuard[] = []
  const visit = (guard: GuardNode): void => {
    if ('variable' in guard) leaves.push(guard)
    else if ('all' in guard) guard.all.forEach(visit)
    else if ('any' in guard) guard.any.forEach(visit)
    else if ('not' in guard) visit(guard.not)
  }
  for (const transition of model.transitions) if (transition.guard !== undefined) visit(transition.guard)
  return leaves
}

function collectGuardConstants(model: LogicModelV1): number[] {
  return guardLeaves(model).filter((leaf) => typeof leaf.value === 'number').map((leaf) => leaf.value as number)
}

interface GuardAnalysis {
  determinism: Finding[]
  completeness: Finding[]
  truncated: boolean
}

function analyzeGuards(model: LogicModelV1): GuardAnalysis {
  const determinism: Finding[] = []
  const completeness: Finding[] = []
  let truncated = false
  const groups = groupTransitions(model)
  for (const [key, group] of groups) {
    const [from, event] = key.split('|')
    const unguarded = group.filter((transition) => transition.guard === undefined)
    const guarded = group.filter((transition) => transition.guard !== undefined)
    if (unguarded.length > 1) {
      determinism.push({
        code: 'S4_AMBIGUOUS_DEFAULT',
        severity: 'error',
        message: from + ' + ' + event + ' has multiple unconditional transitions: ' + uniqueTargets(unguarded).join(', '),
      })
    }
    if (guarded.length === 0) continue
    const variables = [...new Set(group.flatMap((transition) => guardVariables(transition.guard)))]
    const assignments = assignmentsFor(model, variables)
    if (assignments === null) {
      completeness.push({ code: 'S6_UNBOUNDED_DOMAIN', severity: 'warning', message: from + ' + ' + event + ': guard domain too large to enumerate; exhaustive check skipped.' })
      truncated = true
      continue
    }
    const targets = uniqueTargets(group)
    for (const assignment of assignments) {
      const trueBranches = guarded.filter((transition) => evalGuard(transition.guard!, assignment))
      if (trueBranches.length > 1) {
        determinism.push({
          code: 'S4_NONDETERMINISTIC_GUARDS',
          severity: 'error',
          message: from + ' + ' + event + ' has ' + trueBranches.length + ' simultaneously true guards for assignment ' + stableStringify(assignment) + ': ' + uniqueTargets(trueBranches).join(', '),
          evidence: { assignment },
        })
      }
      if (trueBranches.length === 0 && unguarded.length === 0) {
        completeness.push({
          code: 'S6_INCOMPLETE_GUARD',
          severity: 'error',
          message: from + ' + ' + event + ' has no true guard and no default branch for assignment ' + stableStringify(assignment),
          evidence: { assignment, branches: targets },
        })
      }
      if (determinism.length + completeness.length > 200) {
        truncated = true
        break
      }
    }
    if (truncated) break
  }
  return { determinism, completeness, truncated }
}

function S4_determinism(model: LogicModelV1): CheckResult {
  const analysis = analyzeGuards(model)
  return checkResult('S4', 'Determinism', analysis.determinism, analysis.determinism.length === 0 ? 'Deterministic' : 'Nondeterminism findings: ' + analysis.determinism.length)
}

function S6_guardCompleteness(model: LogicModelV1): CheckResult {
  const analysis = analyzeGuards(model)
  return checkResult('S6', 'Guard Completeness', analysis.completeness, analysis.completeness.length === 0 ? 'All guard branches defined' : 'Guard findings: ' + analysis.completeness.length)
}

function S5_eventCompleteness(model: LogicModelV1): CheckResult {
  const events = allEvents(model)
  const findings: Finding[] = []
  for (const state of model.states) {
    if (state.terminal === true) continue
    const handled = new Set(model.transitions.filter((transition) => transition.from === state.id).map((transition) => transition.event))
    for (const event of events) {
      if (!handled.has(event)) {
        findings.push({
          code: 'S5_UNHANDLED_EVENT',
          severity: 'warning',
          message: state.id + ' silently ignores event ' + event,
        })
      }
    }
  }
  return checkResult('S5', 'Event Completeness', findings, findings.length === 0 ? 'All states handle all relevant events' : findings.length + ' unhandled (state, event) pairs')
}

interface InvariantViolation {
  invariant: InvariantSpec
  path: PathStep[]
  reason: string
}

function invariantHolds(invariant: InvariantSpec, runtime: RuntimeState): boolean {
  if (invariant.kind === 'never-states') return !invariant.states.includes(runtime.state)
  if (invariant.kind === 'var-in-range') {
    const value = runtime.vars[invariant.variable]
    if (typeof value !== 'number') return false
    if (invariant.min !== undefined && value < invariant.min) return false
    if (invariant.max !== undefined && value > invariant.max) return false
    return true
  }
  return true
}

function shortestViolationForInvariant(model: LogicModelV1, options: NormalizedOptions, invariant: InvariantSpec): InvariantViolation | undefined {
  if (invariant.kind === 'event-before-state') {
    return shortestEventBeforeStateViolation(model, options, invariant)
  }
  const init = initialState(model)
  if (!invariantHolds(invariant, init)) {
    return { invariant, path: [], reason: 'Initial state violates the invariant.' }
  }
  const visited = new Set<string>([runtimeKey(init)])
  const queue: Array<{ runtime: RuntimeState; path: PathStep[] }> = [{ runtime: init, path: [] }]
  let steps = 0
  while (queue.length > 0) {
    const entry = queue.shift()!
    if (++steps > options.maxStates) break
    for (const event of allEvents(model)) {
      for (const next of stepRuntime(model, entry.runtime, event)) {
        const key = runtimeKey(next)
        if (visited.has(key)) continue
        const path = [...entry.path, { from: entry.runtime.state, event, to: next.state }]
        if (!invariantHolds(invariant, next)) {
          return { invariant, path, reason: 'Invariant violated after ' + path.length + ' events.' }
        }
        visited.add(key)
        queue.push({ runtime: next, path })
      }
    }
  }
  return undefined
}

function shortestEventBeforeStateViolation(model: LogicModelV1, options: NormalizedOptions, invariant: Extract<InvariantSpec, { kind: 'event-before-state' }>): InvariantViolation | undefined {
  const init = initialState(model)
  const seenInitially = false
  if (init.state === invariant.state && !seenInitially) {
    return { invariant, path: [], reason: 'Target state ' + invariant.state + ' is initial and the required event ' + invariant.event + ' has not occurred.' }
  }
  const key = (runtime: RuntimeState, seen: boolean): string => runtimeKey(runtime) + '|' + (seen ? '1' : '0')
  const visited = new Set<string>([key(init, false)])
  const queue: Array<{ runtime: RuntimeState; seen: boolean; path: PathStep[] }> = [{ runtime: init, seen: false, path: [] }]
  let steps = 0
  while (queue.length > 0) {
    const entry = queue.shift()!
    if (++steps > options.maxStates) break
    for (const event of allEvents(model)) {
      for (const next of stepRuntime(model, entry.runtime, event)) {
        const seen = entry.seen || event === invariant.event
        const nextKey = key(next, seen)
        if (visited.has(nextKey)) continue
        const path = [...entry.path, { from: entry.runtime.state, event, to: next.state }]
        if (next.state === invariant.state && !seen) {
          return { invariant, path, reason: 'Target state ' + invariant.state + ' is reachable without event ' + invariant.event + ' in ' + path.length + ' steps.' }
        }
        visited.add(nextKey)
        queue.push({ runtime: next, seen, path })
      }
    }
  }
  return undefined
}

function runInvariants(model: LogicModelV1, options: NormalizedOptions): InvariantViolation[] {
  const violations: InvariantViolation[] = []
  for (const invariant of model.invariants ?? []) {
    const violation = shortestViolationForInvariant(model, options, invariant)
    if (violation !== undefined) violations.push(violation)
  }
  return violations
}

function S7_invariants(model: LogicModelV1, options: NormalizedOptions): CheckResult {
  const violations = runInvariants(model, options)
  const findings: Finding[] = violations.map((violation) => ({
    code: 'S7_INVARIANT_VIOLATION',
    severity: 'error',
    message: 'Invariant "' + violation.invariant.id + '" (' + violation.invariant.description + ') violated: ' + violation.reason,
    path: violation.path,
    evidence: { invariant: violation.invariant },
  }))
  return checkResult('S7', 'Invariant Validity', findings, violations.length === 0 ? 'All invariants hold' : 'Invariant violations: ' + violations.length)
}

// ---------------------------------------------------------------------------
// A1-A7
// ---------------------------------------------------------------------------

function A1_unexpectedEvents(model: LogicModelV1): CheckResult {
  const events = allEvents(model)
  const findings: Finding[] = []
  for (const state of model.states) {
    if (state.terminal === true) continue
    const handled = new Set(model.transitions.filter((transition) => transition.from === state.id).map((transition) => transition.event))
    for (const event of events) {
      if (!handled.has(event)) {
        findings.push({
          code: 'A1_UNHANDLED_EVENT',
          severity: 'warning',
          message: 'Event ' + event + ' in state ' + state.id + ' has no defined transition (silent ignore).',
        })
      }
    }
  }
  return checkResult('A1', 'Unexpected Event Injection', findings, findings.length === 0 ? 'All event/state combinations defined' : findings.length + ' unhandled combinations')
}

function firstOutcome(runtime: RuntimeState, outcomes: RuntimeState[]): RuntimeState | undefined {
  return outcomes[0]
}

function A2_raceInterleaving(model: LogicModelV1, exploration: Exploration): CheckResult {
  const findings: Finding[] = []
  for (const [e1, e2] of model.concurrentPairs ?? []) {
    for (const runtime of exploration.reachable) {
      const first = firstOutcome(runtime, stepRuntime(model, runtime, e1))
      const second = firstOutcome(runtime, stepRuntime(model, runtime, e2))
      if (first === undefined && second === undefined) continue
      const final12 = first === undefined ? runtime : firstOutcome(first, stepRuntime(model, first, e2)) ?? first
      const final21 = second === undefined ? runtime : firstOutcome(second, stepRuntime(model, second, e1)) ?? second
      if (runtimeKey(final12) !== runtimeKey(final21)) {
        findings.push({
          code: 'A2_ORDER_DEPENDENT',
          severity: 'warning',
          message: 'Events ' + e1 + ' and ' + e2 + ' produce order-dependent outcomes from state ' + runtime.state,
          evidence: { e1ThenE2: final12, e2ThenE1: final21 },
        })
      }
    }
  }
  return checkResult('A2', 'Race Interleaving', findings, findings.length === 0 ? 'No race conditions detected' : 'Order-dependent outcomes: ' + findings.length)
}

function stepSequence(model: LogicModelV1, init: RuntimeState, events: string[]): RuntimeState {
  let runtime = init
  for (const event of events) {
    const next = firstOutcome(runtime, stepRuntime(model, runtime, event))
    if (next === undefined) continue
    runtime = next
  }
  return runtime
}

function permutations<T>(items: T[]): T[][] {
  if (items.length === 0) return [[]]
  const result: T[][] = []
  for (let index = 0; index < items.length; index++) {
    const rest = items.slice(0, index).concat(items.slice(index + 1))
    for (const suffix of permutations(rest)) result.push([items[index], ...suffix])
  }
  return result
}

function A3_orderPermutation(model: LogicModelV1, options: NormalizedOptions): CheckResult {
  const events = allEvents(model).slice(0, options.maxPermutationEvents)
  if (events.length < 2) return checkResult('A3', 'Order Permutation', [], 'Fewer than 2 events — skipped')
  const init = initialState(model)
  const outcomes = new Map<string, string[]>()
  for (const permutation of permutations(events)) {
    const final = stepSequence(model, init, permutation)
    const key = runtimeKey(final)
    const list = outcomes.get(key) ?? []
    if (list.length < 3) list.push(permutation.join(','))
    outcomes.set(key, list)
  }
  if (outcomes.size > 1) {
    const examples = [...outcomes.entries()].map(([key, sequences]) => ({ final: key.split('|')[0], example: sequences[0] }))
    return checkResult('A3', 'Order Permutation', [{
      code: 'A3_ORDER_DEPENDENT',
      severity: 'warning',
      message: 'Same event set produces ' + outcomes.size + ' different outcomes depending on order.',
      evidence: { examples },
    }], 'Order-dependent outcomes: ' + outcomes.size)
  }
  return checkResult('A3', 'Order Permutation', [], 'Order-independent (sampled first ' + events.length + ' events)')
}

function stateActionList(model: LogicModelV1, stateId: string, kind: 'onEntry' | 'onExit'): string[] {
  const state = model.states.find((entry) => entry.id === stateId)
  const list = state === undefined ? undefined : state[kind]
  return list ?? []
}

function actionsDeclared(model: LogicModelV1): boolean {
  return model.states.some((state) => (state.onEntry ?? []).length > 0 || (state.onExit ?? []).length > 0)
}

/** Apply an ordered action list to the held flag. Actions never change state or variables; they only matter to pairing checks. */
function applyActionList(list: string[], acquireEvent: string, releaseEvent: string, held: boolean): { held: boolean; reacquired: boolean } {
  let next = held
  let reacquired = false
  for (const action of list) {
    if (action === acquireEvent) {
      if (next) reacquired = true
      next = true
    } else if (action === releaseEvent) {
      next = false
    }
  }
  return { held: next, reacquired }
}

function A4_pairSymmetry(model: LogicModelV1): CheckResult {
  const findings: Finding[] = []
  const hasActions = actionsDeclared(model)
  const transitionEvents = new Set(model.transitions.map((transition) => transition.event))
  const actionEvents = new Set<string>()
  if (hasActions) {
    for (const state of model.states) {
      for (const action of stateActionList(model, state.id, 'onEntry')) actionEvents.add(action)
      for (const action of stateActionList(model, state.id, 'onExit')) actionEvents.add(action)
    }
  }
  const pairHasEvent = (event: string): boolean => transitionEvents.has(event) || actionEvents.has(event)
  const releaseReachableFrom = (stateId: string, releaseEvent: string): boolean => {
    const reachable = stateGraphReachable(model, stateId)
    return [...reachable].some((state) =>
      model.transitions.some((transition) => transition.from === state && transition.event === releaseEvent)
      || (hasActions && (stateActionList(model, state, 'onEntry').includes(releaseEvent) || stateActionList(model, state, 'onExit').includes(releaseEvent))))
  }
  const edges = stateGraphEdges(model)
  for (const pair of model.resourcePairs ?? []) {
    const acquireTransitions = model.transitions.filter((transition) => transition.event === pair.acquireEvent)
    const actionAcquire = hasActions && model.states.some((state) =>
      stateActionList(model, state.id, 'onEntry').includes(pair.acquireEvent) || stateActionList(model, state.id, 'onExit').includes(pair.acquireEvent))
    const releaseExists = pairHasEvent(pair.releaseEvent)
    if (acquireTransitions.length === 0 && !actionAcquire && !releaseExists) continue
    if ((acquireTransitions.length > 0 || actionAcquire) && !releaseExists) {
      findings.push({
        code: 'A4_NO_RELEASE_EVENT',
        severity: 'error',
        message: 'Resource "' + pair.resource + '": acquire event ' + pair.acquireEvent + ' exists but release event ' + pair.releaseEvent + ' is never defined.',
      })
      continue
    }
    // Collect acquire sites: transitions whose event acquires, and state entry/exit actions that end holding the resource.
    const seeds: Array<{ state: string; held: boolean; path: PathStep[] }> = []
    for (const acquire of acquireTransitions) {
      if (!releaseReachableFrom(acquire.to, pair.releaseEvent)) {
        findings.push({
          code: 'A4_NO_RELEASE_REACHABLE',
          severity: 'error',
          message: 'Resource "' + pair.resource + '": after ' + pair.acquireEvent + ' into ' + acquire.to + ', no ' + pair.releaseEvent + ' is reachable.',
          evidence: { acquireTransition: acquire },
        })
        continue
      }
      seeds.push({ state: acquire.to, held: true, path: [] })
    }
    if (hasActions) {
      for (const state of model.states) {
        // acquire fired by onEntry: resource is held for the whole stay in the state
        const entry = stateActionList(model, state.id, 'onEntry')
        if (entry.includes(pair.acquireEvent)) {
          const sim = applyActionList(entry, pair.acquireEvent, pair.releaseEvent, false)
          if (sim.reacquired) {
            findings.push({
              code: 'A4_REACQUIRE_WITHOUT_RELEASE',
              severity: 'warning',
              message: 'Resource "' + pair.resource + '" is acquired more than once inside onEntry of ' + state.id + ' before ' + pair.releaseEvent + '.',
            })
          }
          if (sim.held) seeds.push({ state: state.id, held: true, path: [] })
        }
        // acquire fired by onExit: happens on every outgoing edge, never on a terminal state
        const exit = stateActionList(model, state.id, 'onExit')
        if (exit.includes(pair.acquireEvent) && !state.terminal) {
          const sim = applyActionList(exit, pair.acquireEvent, pair.releaseEvent, false)
          if (sim.reacquired) {
            findings.push({
              code: 'A4_REACQUIRE_WITHOUT_RELEASE',
              severity: 'warning',
              message: 'Resource "' + pair.resource + '" is acquired more than once inside onExit of ' + state.id + ' before ' + pair.releaseEvent + '.',
            })
          }
          if (sim.held) seeds.push({ state: state.id, held: false, path: [] })
        }
      }
    }
    // Path-sensitive probe: track the held flag along state-graph paths, firing
    // onExit of the source state before each transition and onEntry of the target after it.
    for (const seed of seeds) {
      const visited = new Set<string>()
      const queue: Array<{ state: string; held: boolean; path: PathStep[] }> = [seed]
      let steps = 0
      while (queue.length > 0) {
        const entry = queue.shift()!
        if (++steps > 1000) break
        const key = entry.state + '|' + (entry.held ? '1' : '0')
        if (visited.has(key)) continue
        visited.add(key)
        if (entry.held && isTerminal(model, entry.state)) {
          findings.push({
            code: 'A4_TERMINAL_WITH_RESOURCE',
            severity: 'error',
            message: 'Resource "' + pair.resource + '" is still held when entering terminal state ' + entry.state + '.',
            path: entry.path,
          })
          continue
        }
        for (const transition of edges.get(entry.state) ?? []) {
          let held = entry.held
          if (hasActions) {
            const sim = applyActionList(stateActionList(model, entry.state, 'onExit'), pair.acquireEvent, pair.releaseEvent, held)
            if (sim.reacquired) {
              findings.push({
                code: 'A4_REACQUIRE_WITHOUT_RELEASE',
                severity: 'warning',
                message: 'Resource "' + pair.resource + '" is acquired again in onExit of ' + entry.state + ' before ' + pair.releaseEvent + '.',
                path: entry.path,
              })
              continue
            }
            held = sim.held
          }
          if (transition.event === pair.releaseEvent) held = false
          else if (transition.event === pair.acquireEvent) {
            if (held) {
              findings.push({
                code: 'A4_REACQUIRE_WITHOUT_RELEASE',
                severity: 'warning',
                message: 'Resource "' + pair.resource + '" is acquired again in state ' + entry.state + ' before ' + pair.releaseEvent + '.',
                path: [...entry.path, { from: entry.state, event: transition.event, to: transition.to }],
              })
              continue
            }
            held = true
          }
          if (hasActions) {
            const sim = applyActionList(stateActionList(model, transition.to, 'onEntry'), pair.acquireEvent, pair.releaseEvent, held)
            if (sim.reacquired) {
              findings.push({
                code: 'A4_REACQUIRE_WITHOUT_RELEASE',
                severity: 'warning',
                message: 'Resource "' + pair.resource + '" is acquired again inside onEntry of ' + transition.to + ' before ' + pair.releaseEvent + '.',
                path: [...entry.path, { from: entry.state, event: transition.event, to: transition.to }],
              })
              continue
            }
            held = sim.held
          }
          queue.push({ state: transition.to, held, path: [...entry.path, { from: entry.state, event: transition.event, to: transition.to }] })
        }
      }
    }
  }
  return checkResult('A4', 'Pair Symmetry', findings, findings.length === 0 ? 'All pairs balanced' : 'Asymmetric pairs: ' + findings.length)
}

function stateGraphEdges(model: LogicModelV1): Map<string, TransitionSpec[]> {
  const edges = new Map<string, TransitionSpec[]>()
  for (const state of model.states) edges.set(state.id, [])
  for (const transition of model.transitions) edges.get(transition.from)?.push(transition)
  return edges
}

function stateGraphReachable(model: LogicModelV1, start: string): Set<string> {
  const edges = new Map<string, string[]>()
  for (const state of model.states) edges.set(state.id, [])
  for (const transition of model.transitions) edges.get(transition.from)?.push(transition.to)
  const visited = new Set<string>()
  const queue = [start]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (visited.has(current)) continue
    visited.add(current)
    for (const next of edges.get(current) ?? []) queue.push(next)
  }
  return visited
}

function A5_boundaryBlast(model: LogicModelV1): CheckResult {
  const findings: Finding[] = []
  for (const check of model.boundaryChecks ?? []) {
    const variable = (model.variables ?? []).find((entry) => entry.name === check.variable)
    if (variable === undefined) continue
    for (const value of check.values) {
      if (variable.min !== undefined && value < variable.min) {
        findings.push({ code: 'A5_OUT_OF_DOMAIN', severity: 'warning', message: 'Boundary value ' + value + ' for ' + check.variable + ' is below min ' + variable.min })
      }
      if (variable.max !== undefined && value > variable.max) {
        findings.push({ code: 'A5_OUT_OF_DOMAIN', severity: 'warning', message: 'Boundary value ' + value + ' for ' + check.variable + ' is above max ' + variable.max })
      }
      const assignment = { ...(model.variables ?? []).reduce<Record<string, VarValue>>((result, entry) => { result[entry.name] = entry.init; return result }, {}), [check.variable]: value }
      for (const [key, group] of groupTransitions(model)) {
        const [from, event] = key.split('|')
        if (!group.some((transition) => guardVariables(transition.guard).includes(check.variable))) continue
        const guarded = group.filter((transition) => transition.guard !== undefined)
        const unguarded = group.filter((transition) => transition.guard === undefined)
        const matched = guarded.filter((transition) => evalGuard(transition.guard!, assignment))
        if (matched.length === 0 && unguarded.length === 0) {
          findings.push({
            code: 'A5_GUARD_HOLE',
            severity: 'warning',
            message: from + ' + ' + event + ' has no branch for ' + check.variable + '=' + value,
            evidence: { assignment },
          })
        }
        if (matched.length > 1) {
          findings.push({
            code: 'A5_GUARD_OVERLAP',
            severity: 'warning',
            message: from + ' + ' + event + ' has ' + matched.length + ' true branches for ' + check.variable + '=' + value,
            evidence: { assignment },
          })
        }
      }
    }
  }
  return checkResult('A5', 'Boundary Blast', findings, findings.length === 0 ? 'Boundary checks passed' : 'Boundary findings: ' + findings.length)
}

function A6_resourceInjection(model: LogicModelV1): CheckResult {
  const findings: Finding[] = []
  for (const pair of model.resourcePairs ?? []) {
    if (pair.failEvent === undefined) continue
    const acquireStates = new Set(model.transitions.filter((transition) => transition.event === pair.acquireEvent).map((transition) => transition.from))
    for (const state of acquireStates) {
      const handled = model.transitions.some((transition) => transition.from === state && transition.event === pair.failEvent)
      if (!handled) {
        findings.push({
          code: 'A6_NO_FAILURE_HANDLER',
          severity: 'warning',
          message: 'State ' + state + ' can ' + pair.acquireEvent + ' for "' + pair.resource + '" but has no ' + pair.failEvent + ' transition.',
        })
      }
    }
  }
  return checkResult('A6', 'Resource Injection', findings, findings.length === 0 ? 'No resource vulnerabilities detected' : 'Resource failure paths missing: ' + findings.length)
}

function A7_shortestViolations(model: LogicModelV1, options: NormalizedOptions): CheckResult {
  const violations = runInvariants(model, options)
  const findings: Finding[] = violations.map((violation) => ({
    code: 'A7_SHORTEST_COUNTEREXAMPLE',
    severity: 'warning',
    message: 'Invariant "' + violation.invariant.id + '" shortest violating path length: ' + violation.path.length + (violation.path.length === 0 ? ' (initial state)' : ''),
    path: violation.path,
    evidence: { invariant: violation.invariant.id },
  }))
  return checkResult('A7', 'Minimal Counter-Example', findings, violations.length === 0 ? 'All invariants hold for all reachable paths' : 'Violated invariants: ' + findings.length)
}

function mapStateId(mapping: Record<string, string>, state: string): string {
  return mapping[state] ?? state
}

function D1_behavioralPreservation(before: LogicModelV1, after: LogicModelV1, mapping: Record<string, string>): CheckResult {
  const findings: Finding[] = []
  const afterStates = new Set(after.states.map((state) => state.id))
  const afterByFromEvent = new Map<string, Set<string>>()
  for (const transition of after.transitions) {
    const key = transition.from + '|' + transition.event
    const set = afterByFromEvent.get(key) ?? new Set<string>()
    set.add(transition.to)
    afterByFromEvent.set(key, set)
  }
  const beforeInitMapped = mapStateId(mapping, before.init)
  if (beforeInitMapped !== after.init) {
    findings.push({
      code: 'D1_INIT_MISMATCH',
      severity: 'warning',
      message: 'Mapped BEFORE init ' + beforeInitMapped + ' does not match AFTER init ' + after.init + '.',
      evidence: { beforeInit: before.init, mappedInit: beforeInitMapped, afterInit: after.init },
    })
  }
  for (const state of before.states) {
    const mapped = mapStateId(mapping, state.id)
    if (!afterStates.has(mapped)) {
      findings.push({
        code: 'D1_MAPPED_STATE_MISSING',
        severity: 'error',
        message: 'BEFORE state ' + state.id + ' maps to ' + mapped + ', which is not declared in AFTER.',
        evidence: { beforeState: state.id, mappedState: mapped },
      })
      continue
    }
    for (const transition of before.transitions.filter((entry) => entry.from === state.id)) {
      const key = mapped + '|' + transition.event
      const targets = afterByFromEvent.get(key)
      if (targets === undefined || targets.size === 0) {
        findings.push({
          code: 'D1_EVENT_DISABLED',
          severity: 'error',
          message: 'BEFORE can fire event ' + transition.event + ' from ' + state.id + ' (mapped to ' + mapped + '), but AFTER has no transition for that (state, event).',
          path: [{ from: state.id, event: transition.event, to: transition.to }],
          evidence: { beforeState: state.id, mappedState: mapped, event: transition.event },
        })
      }
    }
  }
  return checkResult('D1', 'Behavioral Preservation', findings, findings.length === 0 ? 'BEFORE event behavior is preserved in AFTER' : 'Behavioral preservation findings: ' + findings.length)
}

function mapInvariantForComparison(invariant: InvariantSpec, mapping: Record<string, string>): InvariantSpec {
  if (invariant.kind === 'never-states') {
    return {
      ...invariant,
      id: invariant.id + ':before',
      description: invariant.description + ' (from BEFORE)',
      states: invariant.states.map((state) => mapStateId(mapping, state)),
    }
  }
  if (invariant.kind === 'event-before-state') {
    return {
      ...invariant,
      id: invariant.id + ':before',
      description: invariant.description + ' (from BEFORE)',
      state: mapStateId(mapping, invariant.state),
    }
  }
  return { ...invariant, id: invariant.id + ':before', description: invariant.description + ' (from BEFORE)' }
}

function D2_invariantContinuity(before: LogicModelV1, after: LogicModelV1, options: NormalizedOptions, mapping: Record<string, string>): CheckResult {
  const findings: Finding[] = []
  const afterStates = new Set(after.states.map((state) => state.id))
  const afterVariables = new Set((after.variables ?? []).map((variable) => variable.name))
  for (const invariant of before.invariants ?? []) {
    const mapped = mapInvariantForComparison(invariant, mapping)
    if (mapped.kind === 'never-states') {
      for (const state of mapped.states) {
        if (!afterStates.has(state)) {
          findings.push({
            code: 'D2_MAPPED_STATE_MISSING',
            severity: 'warning',
            message: 'BEFORE invariant "' + invariant.id + '" maps to state ' + state + ', which is not declared in AFTER.',
            evidence: { invariant: invariant.id, state },
          })
        }
      }
    } else if (mapped.kind === 'event-before-state') {
      if (!afterStates.has(mapped.state)) {
        findings.push({
          code: 'D2_MAPPED_STATE_MISSING',
          severity: 'warning',
          message: 'BEFORE invariant "' + invariant.id + '" maps to state ' + mapped.state + ', which is not declared in AFTER.',
          evidence: { invariant: invariant.id, state: mapped.state },
        })
      }
    } else if (mapped.kind === 'var-in-range') {
      if (!afterVariables.has(mapped.variable)) {
        findings.push({
          code: 'D2_VARIABLE_MISSING',
          severity: 'warning',
          message: 'BEFORE invariant "' + invariant.id + '" references variable ' + mapped.variable + ', which is not declared in AFTER.',
          evidence: { invariant: invariant.id, variable: mapped.variable },
        })
        continue
      }
    }
    const violation = shortestViolationForInvariant(after, options, mapped)
    if (violation !== undefined) {
      findings.push({
        code: 'D2_INVARIANT_REGRESSION',
        severity: 'error',
        message: 'BEFORE invariant "' + invariant.id + '" no longer holds in AFTER: ' + violation.reason,
        path: violation.path,
        evidence: { beforeInvariant: invariant, afterInvariant: mapped },
      })
    }
  }
  return checkResult('D2', 'Invariant Continuity', findings, findings.length === 0 ? 'All BEFORE invariants continue to hold' : 'Invariant continuity findings: ' + findings.length)
}

function D3_regressionDelta(before: LogicModelV1, after: LogicModelV1, mapping: Record<string, string>): CheckResult {
  const afterStateIds = new Set(after.states.map((state) => state.id))
  const beforeMappedIds = new Set(before.states.map((state) => mapStateId(mapping, state.id)))
  const addedStates = after.states.filter((state) => !beforeMappedIds.has(state.id)).map((state) => state.id).sort()
  const removedStates = before.states.filter((state) => !afterStateIds.has(mapStateId(mapping, state.id))).map((state) => state.id).sort()
  const beforeEvents = new Set(before.transitions.map((transition) => transition.event))
  const afterEvents = new Set(after.transitions.map((transition) => transition.event))
  const addedEvents = [...afterEvents].filter((event) => !beforeEvents.has(event)).sort()
  const removedEvents = [...beforeEvents].filter((event) => !afterEvents.has(event)).sort()
  const removedTransitions = before.transitions.filter((transition) => !after.transitions.some((candidate) =>
    candidate.from === mapStateId(mapping, transition.from) &&
    candidate.event === transition.event &&
    candidate.to === mapStateId(mapping, transition.to)
  ))
  const addedTransitions = after.transitions.filter((transition) => !before.transitions.some((candidate) =>
    mapStateId(mapping, candidate.from) === transition.from &&
    candidate.event === transition.event &&
    mapStateId(mapping, candidate.to) === transition.to
  ))
  const findings: Finding[] = []
  for (const state of removedStates) {
    findings.push({ code: 'D3_REMOVED_STATE', severity: 'warning', message: 'BEFORE state ' + state + ' is not present in AFTER under the given mapping.', evidence: { state } })
  }
  for (const event of removedEvents) {
    findings.push({ code: 'D3_REMOVED_EVENT', severity: 'warning', message: 'BEFORE event ' + event + ' is not present in AFTER.', evidence: { event } })
  }
  for (const transition of removedTransitions) {
    findings.push({
      code: 'D3_REMOVED_TRANSITION',
      severity: 'warning',
      message: 'BEFORE transition ' + transition.from + ' -' + transition.event + '-> ' + transition.to + ' has no exact AFTER counterpart.',
      evidence: { transition },
    })
  }
  const detail = 'Delta: +' + addedStates.length + ' states, -' + removedStates.length + ' states, +' + addedEvents.length + ' events, -' + removedEvents.length + ' events, +' + addedTransitions.length + ' transitions, -' + removedTransitions.length + ' transitions'
  return checkResult('D3', 'Regression Delta', findings, detail)
}

function deadlockStateIds(model: LogicModelV1): string[] {
  const outgoing = new Set(model.transitions.map((transition) => transition.from))
  return model.states.filter((state) => state.terminal !== true && !outgoing.has(state.id)).map((state) => state.id)
}

function closedSccStateSets(model: LogicModelV1): string[][] {
  return sccs(model)
    .filter((component) => {
      const componentSet = new Set(component)
      const internalEdges = model.transitions.some((transition) => componentSet.has(transition.from) && componentSet.has(transition.to))
      const escapingEdges = model.transitions.some((transition) => componentSet.has(transition.from) && !componentSet.has(transition.to))
      return internalEdges && !escapingEdges && !component.some((state) => isTerminal(model, state))
    })
    .map((component) => component.sort())
}

function D4_deadlockLivenessRegression(before: LogicModelV1, after: LogicModelV1, mapping: Record<string, string>): CheckResult {
  const findings: Finding[] = []
  const beforeDeadlock = new Set(deadlockStateIds(before).map((state) => mapStateId(mapping, state)))
  const afterDeadlock = deadlockStateIds(after)
  for (const state of afterDeadlock) {
    if (!beforeDeadlock.has(state)) {
      findings.push({
        code: 'D4_DEADLOCK_REGRESSION',
        severity: 'error',
        message: 'AFTER introduces deadlock in state ' + state + ' that was not deadlocked in BEFORE.',
        evidence: { state },
      })
    }
  }
  const beforeScc = new Set(closedSccStateSets(before).map((component) => component.map((state) => mapStateId(mapping, state)).sort().join(',')))
  const afterScc = closedSccStateSets(after)
  for (const component of afterScc) {
    const key = component.join(',')
    if (!beforeScc.has(key)) {
      findings.push({
        code: 'D4_LIVENESS_REGRESSION',
        severity: 'error',
        message: 'AFTER introduces a closed SCC with no exit and no terminal state: ' + key,
        evidence: { states: component },
      })
    }
  }
  return checkResult('D4', 'Deadlock/Liveness Regression', findings, findings.length === 0 ? 'No new deadlock or liveness regressions' : 'Regression findings: ' + findings.length)
}

function buildComparisonSummary(before: LogicModelV1, after: LogicModelV1, mapping: Record<string, string>): ComparisonSummary {
  const afterStateIds = new Set(after.states.map((state) => state.id))
  const beforeMappedIds = new Set(before.states.map((state) => mapStateId(mapping, state.id)))
  const addedStates = after.states.filter((state) => !beforeMappedIds.has(state.id)).map((state) => state.id).sort()
  const removedStates = before.states.filter((state) => !afterStateIds.has(mapStateId(mapping, state.id))).map((state) => state.id).sort()
  const beforeEvents = new Set(before.transitions.map((transition) => transition.event))
  const afterEvents = new Set(after.transitions.map((transition) => transition.event))
  const addedEvents = [...afterEvents].filter((event) => !beforeEvents.has(event)).sort()
  const removedEvents = [...beforeEvents].filter((event) => !afterEvents.has(event)).sort()
  const removedTransitions = before.transitions.filter((transition) => !after.transitions.some((candidate) =>
    candidate.from === mapStateId(mapping, transition.from) &&
    candidate.event === transition.event &&
    candidate.to === mapStateId(mapping, transition.to)
  ))
  const addedTransitions = after.transitions.filter((transition) => !before.transitions.some((candidate) =>
    mapStateId(mapping, candidate.from) === transition.from &&
    candidate.event === transition.event &&
    mapStateId(mapping, candidate.to) === transition.to
  ))
  return {
    beforeModelHash: modelHash(before),
    afterModelHash: modelHash(after),
    stateMapping: mapping,
    beforeStates: before.states.length,
    beforeTransitions: before.transitions.length,
    afterStates: after.states.length,
    afterTransitions: after.transitions.length,
    addedStates,
    removedStates,
    addedEvents,
    removedEvents,
    addedTransitions,
    removedTransitions,
  }
}
function A8_idempotentReplay(model: LogicModelV1, exploration: Exploration): CheckResult {
  const events = model.idempotentEvents ?? []
  const findings: Finding[] = []
  for (const event of events) {
    for (const runtime of exploration.reachable) {
      const onceOptions = stepRuntime(model, runtime, event)
      if (onceOptions.length === 0) continue
      for (const once of onceOptions) {
        const twiceOptions = stepRuntime(model, once, event)
        if (twiceOptions.length === 0) {
          findings.push({
            code: 'A8_NOT_REPLAYABLE',
            severity: 'warning',
            message: 'Idempotent event ' + event + ' is not replayable after first application from ' + runtime.state + '.',
            path: [{ from: runtime.state, event, to: once.state }],
            evidence: { state: runtime.state, event },
          })
          continue
        }
        for (const twice of twiceOptions) {
          if (runtimeKey(twice) !== runtimeKey(once)) {
            findings.push({
              code: 'A8_NOT_IDEMPOTENT',
              severity: 'error',
              message: 'Idempotent event ' + event + ' changes state when applied twice from ' + runtime.state + '.',
              path: [{ from: runtime.state, event, to: once.state }, { from: once.state, event, to: twice.state }],
              evidence: { state: runtime.state, event, afterOnce: once, afterTwice: twice },
            })
            break
          }
        }
      }
    }
  }
  return checkResult('A8', 'Idempotent Replay', findings, findings.length === 0 ? 'Idempotent events are replay-safe' : 'Idempotent replay findings: ' + findings.length)
}
function S8_monotonicVariables(model: LogicModelV1): CheckResult {
  const findings: Finding[] = []
  for (const variable of model.variables ?? []) {
    if (variable.monotonic === undefined) continue
    for (const transition of model.transitions) {
      for (const update of transition.updates ?? []) {
        if (update.variable !== variable.name) continue
        if (variable.monotonic === 'inc' && update.op === 'dec') {
          findings.push({ code: 'S8_MONOTONIC_DECREASE', severity: 'error', message: 'Monotonic (inc) variable ' + variable.name + ' is decreased by ' + transition.event + '.', evidence: { variable: variable.name, transition } })
        } else if (variable.monotonic === 'dec' && update.op === 'inc') {
          findings.push({ code: 'S8_MONOTONIC_INCREASE', severity: 'error', message: 'Monotonic (dec) variable ' + variable.name + ' is increased by ' + transition.event + '.', evidence: { variable: variable.name, transition } })
        } else if (update.op === 'set') {
          findings.push({ code: 'S8_MONOTONIC_SET_REVIEW', severity: 'warning', message: 'Monotonic variable ' + variable.name + ' uses set in ' + transition.event + '; verify it cannot move backwards.', evidence: { variable: variable.name, transition } })
        }
      }
    }
  }
  return checkResult('S8', 'Monotonic Variables', findings, findings.length === 0 ? 'Monotonic variables are respected' : 'Monotonic findings: ' + findings.length)
}

function findLeadsToBadPath(model: LogicModelV1, start: RuntimeState, target: string): { path: PathStep[]; reason: string } | undefined {
  if (start.state === target) return undefined
  const visited = new Set<string>()
  const queue: Array<{ runtime: RuntimeState; path: PathStep[] }> = [{ runtime: start, path: [] }]
  while (queue.length > 0) {
    const entry = queue.shift()!
    const key = runtimeKey(entry.runtime)
    if (entry.runtime.state === target) continue
    if (visited.has(key)) return { path: entry.path, reason: 'Cycle avoids target ' + target }
    visited.add(key)
    const nexts: Array<{ next: RuntimeState; event: string }> = []
    for (const event of allEvents(model)) {
      for (const next of stepRuntime(model, entry.runtime, event)) nexts.push({ next, event })
    }
    if (nexts.length === 0) return { path: entry.path, reason: 'Dead end before target ' + target }
    for (const { next, event } of nexts) {
      queue.push({ runtime: next, path: [...entry.path, { from: entry.runtime.state, event, to: next.state }] })
    }
  }
  return { path: [], reason: 'No path reaches target ' + target }
}

function A9_leadsTo(model: LogicModelV1, exploration: Exploration): CheckResult {
  const findings: Finding[] = []
  for (const invariant of model.invariants ?? []) {
    if (invariant.kind !== 'leads-to') continue
    for (const runtime of exploration.reachable) {
      if (runtime.state !== invariant.from) continue
      const bad = findLeadsToBadPath(model, runtime, invariant.to)
      if (bad !== undefined) {
        findings.push({
          code: 'A9_LEADS_TO_VIOLATION',
          severity: 'error',
          message: 'Leads-to invariant "' + invariant.id + '" violated from ' + invariant.from + ': ' + bad.reason,
          path: bad.path,
          evidence: { invariant },
        })
        break
      }
    }
  }
  return checkResult('A9', 'Leads-To', findings, findings.length === 0 ? 'All leads-to invariants hold' : 'Leads-to findings: ' + findings.length)
}

function findSequenceViolation(model: LogicModelV1, options: NormalizedOptions, invariant: Extract<InvariantSpec, { kind: 'sequence' }>): InvariantViolation | undefined {
  const events = invariant.events
  const init = initialState(model)
  const key = (runtime: RuntimeState, progress: number): string => runtimeKey(runtime) + '|' + progress
  const visited = new Set<string>([key(init, 0)])
  const queue: Array<{ runtime: RuntimeState; progress: number; path: PathStep[] }> = [{ runtime: init, progress: 0, path: [] }]
  let steps = 0
  while (queue.length > 0) {
    const entry = queue.shift()!
    if (++steps > options.maxStates) break
    for (const event of allEvents(model)) {
      for (const next of stepRuntime(model, entry.runtime, event)) {
        let progress = entry.progress
        let violation = false
        if (progress < events.length && event === events[progress]) {
          progress += 1
        } else {
          const index = events.indexOf(event)
          if (index > progress) violation = true
        }
        const path = [...entry.path, { from: entry.runtime.state, event, to: next.state }]
        if (violation) {
          return { invariant, path, reason: 'Event ' + event + ' occurred before ' + events[progress] }
        }
        const nextKey = key(next, progress)
        if (!visited.has(nextKey)) {
          visited.add(nextKey)
          queue.push({ runtime: next, progress, path })
        }
      }
    }
  }
  return undefined
}

function A10_sequenceOrder(model: LogicModelV1, options: NormalizedOptions): CheckResult {
  const findings: Finding[] = []
  for (const invariant of model.invariants ?? []) {
    if (invariant.kind !== 'sequence') continue
    const violation = findSequenceViolation(model, options, invariant)
    if (violation !== undefined) {
      findings.push({
        code: 'A10_SEQUENCE_VIOLATION',
        severity: 'error',
        message: 'Sequence invariant "' + invariant.id + '" violated: ' + violation.reason,
        path: violation.path,
        evidence: { invariant },
      })
    }
  }
  return checkResult('A10', 'Sequence Order', findings, findings.length === 0 ? 'All sequence invariants hold' : 'Sequence findings: ' + findings.length)
}

function findAtomicityViolation(model: LogicModelV1, options: NormalizedOptions, invariant: Extract<InvariantSpec, { kind: 'atomicity' }>): InvariantViolation | undefined {
  const atomic = new Set(invariant.events)
  const init = initialState(model)
  const key = (runtime: RuntimeState, started: boolean, closed: boolean): string => runtimeKey(runtime) + '|' + (started ? '1' : '0') + '|' + (closed ? '1' : '0')
  const visited = new Set<string>([key(init, false, false)])
  const queue: Array<{ runtime: RuntimeState; started: boolean; closed: boolean; path: PathStep[] }> = [{ runtime: init, started: false, closed: false, path: [] }]
  let steps = 0
  while (queue.length > 0) {
    const entry = queue.shift()!
    if (++steps > options.maxStates) break
    for (const event of allEvents(model)) {
      for (const next of stepRuntime(model, entry.runtime, event)) {
        const started = entry.started || atomic.has(event)
        const closed = entry.closed || event === invariant.commit || (invariant.rollback !== undefined && event === invariant.rollback)
        const path = [...entry.path, { from: entry.runtime.state, event, to: next.state }]
        if (entry.started && !entry.closed && !atomic.has(event) && event !== invariant.commit && event !== invariant.rollback) {
          return { invariant, path, reason: 'Left atomic scope via ' + event + ' without commit/rollback' }
        }
        if (started && !closed && isTerminal(model, next.state)) {
          return { invariant, path, reason: 'Terminal state reached with incomplete atomic group' }
        }
        const nextKey = key(next, started, closed)
        if (!visited.has(nextKey)) {
          visited.add(nextKey)
          queue.push({ runtime: next, started, closed, path })
        }
      }
    }
  }
  return undefined
}

function A11_atomicity(model: LogicModelV1, options: NormalizedOptions): CheckResult {
  const findings: Finding[] = []
  for (const invariant of model.invariants ?? []) {
    if (invariant.kind !== 'atomicity') continue
    const violation = findAtomicityViolation(model, options, invariant)
    if (violation !== undefined) {
      findings.push({
        code: 'A11_ATOMICITY_VIOLATION',
        severity: 'error',
        message: 'Atomicity invariant "' + invariant.id + '" violated: ' + violation.reason,
        path: violation.path,
        evidence: { invariant },
      })
    }
  }
  return checkResult('A11', 'Atomicity', findings, findings.length === 0 ? 'All atomicity invariants hold' : 'Atomicity findings: ' + findings.length)
}

// ---------------------------------------------------------------------------
// A12 — Budget (worst-case path cost)
// ---------------------------------------------------------------------------

function transitionCost(transition: TransitionSpec): number {
  return transition.cost ?? 1
}

interface BudgetViolation {
  path: PathStep[]
  /** Accumulated cost when the violation was detected (unbounded-cycle witnesses carry no total). */
  cost?: number
  /** True when the witness is a repeatable positive-cost runtime cycle: cost can grow without bound. */
  unbounded: boolean
}

interface RuntimeEdge {
  to: string
  step: PathStep
  cost: number
}

interface RuntimeGraph {
  edges: Map<string, RuntimeEdge[]>
  keys: string[]
  initKey: string
}

function runtimeGraph(model: LogicModelV1, options: NormalizedOptions): RuntimeGraph {
  const groupMap = groupTransitions(model)
  const exploration = explore(model, options)
  const edges = new Map<string, RuntimeEdge[]>()
  for (const runtime of exploration.reachable) {
    const out: RuntimeEdge[] = []
    for (const event of allEvents(model)) {
      const group = groupMap.get(runtime.state + '|' + event)
      if (group === undefined || group.length === 0) continue
      for (const transition of applicableTransitions(group, runtime)) {
        const next = applyUpdates(model, transition, runtime)
        out.push({
          to: runtimeKey(next),
          step: { from: runtime.state, event: transition.event, to: next.state },
          cost: transitionCost(transition),
        })
      }
    }
    edges.set(runtimeKey(runtime), out)
  }
  return {
    edges,
    keys: exploration.reachable.map((runtime) => runtimeKey(runtime)),
    initKey: runtimeKey(exploration.initialState),
  }
}

/** Shortest path from init to targetKey over the runtime graph, or undefined when unreachable. */
function runtimePathToKey(graph: RuntimeGraph, targetKey: string): PathStep[] | undefined {
  const parent = new Map<string, PathStep>()
  const visited = new Set<string>([graph.initKey])
  const queue: string[] = [graph.initKey]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (current === targetKey) {
      const steps: PathStep[] = []
      let key = targetKey
      while (key !== graph.initKey) {
        const step = parent.get(key)
        if (step === undefined) break
        steps.unshift(step)
        key = step.from === undefined ? graph.initKey : keyOfFromStep(graph, step, key)
      }
      return steps
    }
    for (const edge of graph.edges.get(current) ?? []) {
      if (visited.has(edge.to)) continue
      visited.add(edge.to)
      parent.set(edge.to, edge.step)
      queue.push(edge.to)
    }
  }
  return undefined
}

function keyOfFromStep(graph: RuntimeGraph, step: PathStep, targetKey: string): string {
  // Reconstruct the source key by scanning predecessors of targetKey whose step matches.
  for (const [from, edges] of graph.edges) {
    for (const edge of edges) {
      if (edge.to === targetKey && edge.step.event === step.event && edge.step.from === step.from && edge.step.to === step.to) {
        return from
      }
    }
  }
  return graph.initKey
}

/** Find a reachable cycle whose total cost is positive; return a witness path init -> one full round. */
function findUnboundedCycle(model: LogicModelV1, options: NormalizedOptions): PathStep[] | undefined {
  const graph = runtimeGraph(model, options)
  const color = new Map<string, number>()
  for (const start of graph.keys) {
    if (color.has(start)) continue
    const nodeStack: string[] = [start]
    const idxStack: number[] = [0]
    const depthOf = new Map<string, number>([[start, 0]])
    const costAt = new Map<string, number>([[start, 0]])
    const prevKey = new Map<string, string>()
    const prevStep = new Map<string, PathStep>()
    color.set(start, 1)
    while (nodeStack.length > 0) {
      const node = nodeStack[nodeStack.length - 1]
      const outs = graph.edges.get(node) ?? []
      if (idxStack[idxStack.length - 1] < outs.length) {
        const edge = outs[idxStack[idxStack.length - 1]++]
        const seen = color.get(edge.to)
        if (seen === undefined) {
          color.set(edge.to, 1)
          depthOf.set(edge.to, depthOf.get(node)! + 1)
          costAt.set(edge.to, costAt.get(node)! + edge.cost)
          prevKey.set(edge.to, node)
          prevStep.set(edge.to, edge.step)
          nodeStack.push(edge.to)
          idxStack.push(0)
        } else if (seen === 1) {
          // Back edge on the current path: this is a true cycle.
          const cycleCost = costAt.get(node)! + edge.cost - costAt.get(edge.to)!
          if (cycleCost > 0) {
            const entry = runtimePathToKey(graph, edge.to) ?? []
            const round: PathStep[] = []
            let cursor = node
            while (cursor !== edge.to && prevStep.has(cursor)) {
              round.unshift(prevStep.get(cursor)!)
              cursor = prevKey.get(cursor)!
            }
            round.push(edge.step)
            return [...entry, ...round]
          }
        }
      } else {
        color.set(node, 2)
        nodeStack.pop()
        idxStack.pop()
        depthOf.delete(node)
        costAt.delete(node)
        prevKey.delete(node)
        prevStep.delete(node)
      }
    }
  }
  return undefined
}

function findBudgetViolation(
  model: LogicModelV1,
  options: NormalizedOptions,
  invariant: Extract<InvariantSpec, { kind: 'budget' }>,
): BudgetViolation | undefined {
  const groupMap = groupTransitions(model)
  const init = initialState(model)
  const bestCost = new Map<string, number>([[runtimeKey(init), 0]])
  const queue: Array<{ runtime: RuntimeState; cost: number; path: PathStep[] }> = [{ runtime: init, cost: 0, path: [] }]
  let steps = 0
  while (queue.length > 0) {
    const entry = queue.shift()!
    if (++steps > options.maxStates) break
    for (const event of allEvents(model)) {
      const group = groupMap.get(entry.runtime.state + '|' + event)
      if (group === undefined || group.length === 0) continue
      for (const transition of applicableTransitions(group, entry.runtime)) {
        const next = applyUpdates(model, transition, entry.runtime)
        const cost = entry.cost + transitionCost(transition)
        const path = [...entry.path, { from: entry.runtime.state, event: transition.event, to: next.state }]
        // Costs are non-negative, so the first step that pushes the accumulated cost
        // over the budget is already a witness.
        if (cost > invariant.budget) return { path, cost, unbounded: false }
        const key = runtimeKey(next)
        const best = bestCost.get(key)
        if (best === undefined || cost < best) {
          bestCost.set(key, cost)
          queue.push({ runtime: next, cost, path })
        }
      }
    }
  }
  // No finite path exceeds the budget within reachable space; a reachable positive-cost
  // cycle still makes the worst-case unbounded. Plain DAG merges are not cycles.
  const cycle = findUnboundedCycle(model, options)
  if (cycle !== undefined) return { path: cycle, unbounded: true }
  return undefined
}

function A12_budget(model: LogicModelV1, options: NormalizedOptions): CheckResult {
  const budgets = (model.invariants ?? []).filter((invariant) => invariant.kind === 'budget') as Array<Extract<InvariantSpec, { kind: 'budget' }>>
  const usesCost = model.transitions.some((transition) => transition.cost !== undefined)
  const findings: Finding[] = []
  if (usesCost && budgets.length === 0) {
    findings.push({
      code: 'A12_COST_WITHOUT_BUDGET',
      severity: 'warning',
      message: 'Transitions declare cost, but no budget invariant is declared, so worst-case path cost is not verified. Add an invariant of kind budget to check it.',
    })
  }
  for (const invariant of budgets) {
    const violation = findBudgetViolation(model, options, invariant)
    if (violation !== undefined) {
      findings.push({
        code: 'A12_BUDGET_OVER',
        severity: 'error',
        message: violation.unbounded
          ? 'Budget invariant "' + invariant.id + '" (' + invariant.description + ') exceeded: a reachable positive-cost cycle lets path cost grow without bound, so no finite budget ' + invariant.budget + ' holds.'
          : 'Budget invariant "' + invariant.id + '" (' + invariant.description + ') exceeded: worst-case path cost ' + violation.cost + ' is over budget ' + invariant.budget + '.',
        path: violation.path,
        evidence: violation.unbounded ? { invariant, unbounded: true } : { invariant, totalCost: violation.cost, unbounded: false },
      })
    }
  }
  return checkResult('A12', 'Budget', findings, findings.length === 0 ? (budgets.length === 0 ? 'No budget invariants declared' : 'All budget invariants hold') : 'Budget findings: ' + findings.length)
}
// ---------------------------------------------------------------------------
// A13 — Probability reachability (DTMC)
// ---------------------------------------------------------------------------

function probabilityOutcomes(model: LogicModelV1, runtime: RuntimeState): Map<string, { state: string; weight: number }> {
  const groupMap = groupTransitions(model)
  const outcomes = new Map<string, { state: string; weight: number }>()
  for (const event of allEvents(model)) {
    const group = groupMap.get(runtime.state + '|' + event)
    if (group === undefined || group.length === 0) continue
    for (const transition of applicableTransitions(group, runtime)) {
      const weight = transition.weight ?? 1
      if (!(weight > 0)) continue
      const next = applyUpdates(model, transition, runtime)
      const key = runtimeKey(next)
      const current = outcomes.get(key)
      if (current === undefined) outcomes.set(key, { state: next.state, weight })
      else current.weight += weight
    }
  }
  return outcomes
}

/**
 * Probability of ever reaching targetState from the initial state under the DTMC
 * interpretation: at each runtime state every applicable transition with weight > 0 is an
 * outcome chosen proportionally to its weight. Solved by value iteration (least fixed
 * point of the absorbing chain).
 */
function computeHitProbability(model: LogicModelV1, options: NormalizedOptions, targetState: string): { probability: number; converged: boolean } {
  const exploration = explore(model, options)
  const reachable = exploration.reachable
  const n = reachable.length
  const keyIndex = new Map<string, number>()
  reachable.forEach((runtime, i) => keyIndex.set(runtimeKey(runtime), i))
  const fixedValue = new Array<number | null>(n).fill(null)
  const chains: Array<Array<{ j: number; w: number }>> = []
  for (let i = 0; i < n; i++) {
    const runtime = reachable[i]
    if (runtime.state === targetState) {
      fixedValue[i] = 1
      chains.push([])
      continue
    }
    const outs = probabilityOutcomes(model, runtime)
    let sum = 0
    const list: Array<{ j: number; w: number }> = []
    for (const [key, entry] of outs) {
      const j = keyIndex.get(key)
      if (j === undefined) continue
      list.push({ j, w: entry.weight })
      sum += entry.weight
    }
    if (sum <= 0) {
      fixedValue[i] = 0
      chains.push([])
      continue
    }
    chains.push(list.map((item) => ({ j: item.j, w: item.w / sum })))
  }
  const p = new Array<number>(n).fill(0)
  let converged = false
  for (let iter = 0; iter < 20000; iter++) {
    let maxDelta = 0
    for (let i = 0; i < n; i++) {
      if (fixedValue[i] !== null) continue
      const list = chains[i]
      let acc = 0
      for (const item of list) {
        const fixed = fixedValue[item.j]
        acc += item.w * (fixed === null ? p[item.j] : fixed)
      }
      const delta = Math.abs(acc - p[i])
      if (delta > maxDelta) maxDelta = delta
      p[i] = acc
    }
    if (maxDelta < 1e-9) {
      converged = true
      break
    }
  }
  const initIndex = keyIndex.get(runtimeKey(exploration.initialState)) ?? 0
  const fixed = fixedValue[initIndex]
  return { probability: fixed === null ? p[initIndex] : fixed, converged }
}

function A13_probability(model: LogicModelV1, options: NormalizedOptions): CheckResult {
  const findings: Finding[] = []
  const eps = 1e-9
  for (const invariant of model.invariants ?? []) {
    if (invariant.kind !== 'probability') continue
    const { probability, converged } = computeHitProbability(model, options, invariant.target)
    let violated = false
    if (invariant.op === '>=') violated = probability < invariant.p - eps
    else if (invariant.op === '>') violated = probability <= invariant.p + eps
    else if (invariant.op === '<=') violated = probability > invariant.p + eps
    else violated = probability >= invariant.p - eps
    if (violated) {
      findings.push({
        code: 'A13_PROBABILITY_VIOLATION',
        severity: 'error',
        message: 'Probability invariant "' + invariant.id + '" (' + invariant.description + ') violated: P(hit ' + invariant.target + ') = ' + probability.toFixed(6) + ' does not satisfy ' + invariant.op + ' ' + invariant.p + '.',
        evidence: { invariant, computed: probability, converged },
      })
    } else if (!converged) {
      findings.push({
        code: 'A13_NO_CONVERGENCE',
        severity: 'warning',
        message: 'Probability invariant "' + invariant.id + '" passes, but value iteration did not fully converge within the iteration cap.',
        evidence: { invariant, computed: probability, converged },
      })
    }
  }
  return checkResult('A13', 'Probability Reachability', findings, findings.length === 0 ? 'No probability invariants declared or all hold' : 'Probability findings: ' + findings.length)
}

// ---------------------------------------------------------------------------
// Coverage notes (informational gap notices)
// ---------------------------------------------------------------------------

// Underscore-separated identifiers like watchdog_timeout or isr_cmd are common in
// state machines, so boundaries must treat '_' as a separator rather than a word char.
const TIMING_VOCABULARY = /(?<![a-z0-9])(timeout|watchdog|timer|tick|deadline|period|delay|elapsed|latency)(?![a-z0-9])/i
const PREEMPTION_VOCABULARY = /(?<![a-z0-9])(isr|irq|interrupt|task|thread|preempt|rtos)(?![a-z0-9])/i
const HYBRID_VOCABULARY = /(?<![a-z0-9])(pid|plant|feedback|control.?loop|stability|stable|settling|damping|oscillat|chatter|kalman|foc|field.?weaken|motor|torque)(?![a-z0-9])/i
const PROBABILISTIC_VOCABULARY = /(?<![a-z0-9])(mtbf|mttf|failure.?rate|reliability|probability|probabilistic|markov|stochastic|fault.?tree|fmea)(?![a-z0-9])/i

function computeCoverageNotes(model: LogicModelV1): string[] {
  const names: string[] = []
  for (const state of model.states) {
    names.push(state.id)
    for (const action of state.onEntry ?? []) names.push(action)
    for (const action of state.onExit ?? []) names.push(action)
  }
  for (const transition of model.transitions) names.push(transition.event)
  const corpus = names.join(' ')
  const notes: string[] = []
  if (TIMING_VOCABULARY.test(corpus)) {
    notes.push('The model references time-like vocabulary (timeout/watchdog/timer/deadline...). logicprobe verifies ordering, counts, and path budgets (A12) but not hard real-time semantics: deadlines, periods, and clock invariants need a timed model checker (e.g. UPPAAL).')
  }
  if (PREEMPTION_VOCABULARY.test(corpus)) {
    notes.push('The model references preemption/concurrency vocabulary (ISR/IRQ/task/interrupt...). logicprobe models event-order interleavings (A2/A3) but not preemptive concurrency; absolute claims such as thread-safe or interrupt-safe need dedicated verification (TSan, CBMC, or a model checker such as TLA+).')
  }
  if (HYBRID_VOCABULARY.test(corpus)) {
    notes.push('The model references control/hybrid vocabulary (pid/plant/feedback/stability/motor...). logicprobe verifies discrete transitions only; stability, settling time, and mode-switch dynamics over a continuous plant need hybrid verification (SpaceEx, Flow*, or Simulink/Stateflow analysis).')
  }
  if (PROBABILISTIC_VOCABULARY.test(corpus)) {
    notes.push('The model references probabilistic/reliability vocabulary (mtbf/failure rate/probability...). logicprobe is a qualitative model checker; reliability or probability claims need a stochastic model checker (PRISM, Storm) or fault-tree analysis.')
  }
  return notes
}

// ---------------------------------------------------------------------------
// main entry
// ---------------------------------------------------------------------------

export function runVerification(input: unknown, options: VerificationOptions = {}): VerificationReport {
  const normalized: NormalizedOptions = {
    maxStates: options.maxStates ?? DEFAULT_MAX_STATES,
    maxPermutationEvents: options.maxPermutationEvents ?? DEFAULT_MAX_PERMUTATION_EVENTS,
  }
  const validation = validateModel(input)
  if (!validation.ok) {
    return {
      ok: false,
      schemaVersion: 1,
      modelHash: '',
      summary: { states: 0, transitions: 0, errors: validation.errors.length, warnings: 0, checksRun: 0 },
      checks: [{
        id: 'MODEL',
        name: 'Model Validation',
        status: 'fail',
        detail: 'Model schema validation failed: ' + validation.errors.length + ' errors',
        findings: validation.errors.map((message) => ({ code: 'MODEL_INVALID', severity: 'error', message })),
      }],
    }
  }
  const model = validation.model
  const exploration = explore(model, normalized)
  const checks: CheckResult[] = [
    S1_reachability(model, exploration),
    S2_deadlock(model),
    S3_liveness(model),
    S4_determinism(model),
    S5_eventCompleteness(model),
    S6_guardCompleteness(model),
    S7_invariants(model, normalized),
    S8_monotonicVariables(model),
    A1_unexpectedEvents(model),
    A2_raceInterleaving(model, exploration),
    A3_orderPermutation(model, normalized),
    A4_pairSymmetry(model),
    A5_boundaryBlast(model),
    A6_resourceInjection(model),
    A7_shortestViolations(model, normalized),
    A8_idempotentReplay(model, exploration),
    A9_leadsTo(model, exploration),
    A10_sequenceOrder(model, normalized),
    A11_atomicity(model, normalized),
    A12_budget(model, normalized),
    A13_probability(model, normalized),
  ]
  let comparison: ComparisonSummary | undefined
  if (options.beforeModel !== undefined) {
    const beforeValidation = validateModel(options.beforeModel)
    if (!beforeValidation.ok) {
      return {
        ok: false,
        schemaVersion: 1,
        modelHash: modelHash(model),
        summary: {
          states: model.states.length,
          transitions: model.transitions.length,
          errors: beforeValidation.errors.length,
          warnings: 0,
          checksRun: checks.length + 1,
          truncated: exploration.truncated,
        },
        checks: [
          ...checks,
          {
            id: 'BEFORE_MODEL',
            name: 'Before Model Validation',
            status: 'fail',
            detail: 'Before model schema validation failed: ' + beforeValidation.errors.length + ' errors',
            findings: beforeValidation.errors.map((message) => ({ code: 'BEFORE_MODEL_INVALID', severity: 'error', message })),
          },
        ],
      }
    }
    const before = beforeValidation.model
    const mapping = options.stateMapping ?? {}
    checks.push(
      D1_behavioralPreservation(before, model, mapping),
      D2_invariantContinuity(before, model, normalized, mapping),
      D3_regressionDelta(before, model, mapping),
      D4_deadlockLivenessRegression(before, model, mapping),
    )
    comparison = buildComparisonSummary(before, model, mapping)
  }
  const errors = checks.reduce((sum, check) => sum + check.findings.filter((finding) => finding.severity === 'error').length, 0)
  const warnings = checks.reduce((sum, check) => sum + check.findings.filter((finding) => finding.severity === 'warning').length, 0)
  const coverageNotes = computeCoverageNotes(model)
  return {
    ok: true,
    schemaVersion: 1,
    modelHash: modelHash(model),
    summary: {
      states: model.states.length,
      transitions: model.transitions.length,
      errors,
      warnings,
      checksRun: checks.length,
      truncated: exploration.truncated,
    },
    checks,
    ...(model.narrative === undefined ? {} : { narrative: model.narrative }),
    ...(comparison === undefined ? {} : { comparison }),
    ...(coverageNotes.length === 0 ? {} : { coverageNotes }),
  }
}

// ---------------------------------------------------------------------------
// Composition verification (N machines, D6)
// ---------------------------------------------------------------------------

export interface CompositionStep {
  event: string
  /** Indices of the machines that advanced together on this step. */
  machines: number[]
}

export interface CompositionOptions {
  /** Events that require a synchronized multi-machine step (handshake). */
  rendezvous?: string[]
  maxStates?: number
}

export interface CompositionSummary {
  machineCount: number
  machines: Array<{ modelHash: string; states: number; transitions: number }>
  compositeStates: number
  errors: number
  warnings: number
  truncated: boolean
}

export interface CompositionReport {
  ok: boolean
  summary: CompositionSummary
  checks: CheckResult[]
}

interface CompositionNode {
  runtimes: RuntimeState[]
  path: CompositionStep[]
}

interface CompositionMove {
  next: CompositionNode
  event: string
  machines: number[]
}

/**
 * N-machine composition semantics (documented in dsh-model-schema.md):
 * - a non-rendezvous event advances exactly ONE non-terminal machine that fires it;
 * - a rendezvous event (handshake) fires only when AT LEAST TWO machines declare it in
 *   their alphabet and EVERY such non-terminal machine has it enabled (guards held);
 *   all participants then advance simultaneously. A machine that is terminal, or whose
 *   alphabet does not include the event, does not participate;
 * - a terminal machine is stopped and takes no further part.
 * Checks: C1 composition deadlock (reachable node where no machine can advance while at
 * least one is not terminal) and C2 rendezvous that can never fire.
 */
export function runCompositionVerification(machinesInput: unknown[], options: CompositionOptions = {}): CompositionReport {
  const models: LogicModelV1[] = []
  const hashes: string[] = []
  const modelFindings: Finding[] = []
  machinesInput.forEach((input, index) => {
    const validation = validateModel(input)
    if (!validation.ok) {
      modelFindings.push({ code: 'MODEL_INVALID', severity: 'error', message: 'machine ' + index + ' invalid: ' + validation.errors.join('; ') })
    } else {
      models.push(validation.model)
      hashes.push(modelHash(validation.model))
    }
  })
  const machineSummary = models.map((m, i) => ({ modelHash: hashes[i] ?? '', states: m.states.length, transitions: m.transitions.length }))
  if (modelFindings.length > 0 || models.length < 2) {
    if (models.length < 2 && modelFindings.length === 0) {
      modelFindings.push({ code: 'MODEL_INVALID', severity: 'error', message: 'composition requires at least two machines' })
    }
    return {
      ok: false,
      summary: { machineCount: models.length, machines: machineSummary, compositeStates: 0, errors: modelFindings.length, warnings: 0, truncated: false },
      checks: [{ id: 'MODEL', name: 'Machine Validation', status: 'fail', detail: 'composition input validation failed', findings: modelFindings }],
    }
  }
  const rendezvous = new Set(options.rendezvous ?? [])
  const maxStates = options.maxStates ?? DEFAULT_MAX_STATES
  const machineEventSets = models.map((model) => new Set(model.transitions.map((transition) => transition.event)))

  const compositionMoves = (node: CompositionNode): CompositionMove[] => {
    const moves: CompositionMove[] = []
    // single-machine (non-rendezvous) steps
    for (let i = 0; i < models.length; i++) {
      if (isTerminal(models[i], node.runtimes[i].state)) continue
      for (const event of allEvents(models[i])) {
        if (rendezvous.has(event)) continue
        for (const next of stepRuntime(models[i], node.runtimes[i], event)) {
          const runtimes = node.runtimes.slice()
          runtimes[i] = next
          moves.push({ next: { runtimes, path: [] }, event, machines: [i] })
        }
      }
    }
    // synchronized rendezvous steps (>= 2 participants, all enabled)
    for (const event of rendezvous) {
      const participants: number[] = []
      for (let i = 0; i < models.length; i++) {
        if (isTerminal(models[i], node.runtimes[i].state)) continue
        if (!machineEventSets[i].has(event)) continue
        participants.push(i)
      }
      if (participants.length < 2) continue // handshake needs a partner
      const outcomes = participants.map((i) => stepRuntime(models[i], node.runtimes[i], event))
      if (outcomes.some((list) => list.length === 0)) continue // not all participants ready
      let combos: Array<RuntimeState[]> = [node.runtimes.slice()]
      participants.forEach((i, slot) => {
        const nextCombos: Array<RuntimeState[]> = []
        for (const combo of combos) {
          for (const outcome of outcomes[slot]) {
            const copy = combo.slice()
            copy[i] = outcome
            nextCombos.push(copy)
          }
        }
        combos = nextCombos
      })
      for (const runtimes of combos) {
        moves.push({ next: { runtimes, path: [] }, event, machines: participants })
      }
    }
    return moves
  }

  const keyOf = (node: CompositionNode): string => node.runtimes.map((runtime) => runtimeKey(runtime)).join('|')
  const init: CompositionNode = { runtimes: models.map((model) => initialState(model)), path: [] }
  const visited = new Set<string>()
  const queue: CompositionNode[] = [init]
  let compositeStates = 0
  let truncated = false
  const firedCount = new Map<string, number>()
  for (const event of rendezvous) firedCount.set(event, 0)
  const c1Findings: Finding[] = []
  while (queue.length > 0) {
    const node = queue.shift()!
    const key = keyOf(node)
    if (visited.has(key)) continue
    visited.add(key)
    compositeStates += 1
    if (compositeStates > maxStates) {
      truncated = true
      break
    }
    const moves = compositionMoves(node)
    const allTerminal = node.runtimes.every((runtime, i) => isTerminal(models[i], runtime.state))
    if (moves.length === 0 && !allTerminal) {
      c1Findings.push({
        code: 'C1_COMPOSITION_DEADLOCK',
        severity: 'error',
        message: 'Composition deadlock: no machine can advance from (' + node.runtimes.map((runtime) => runtime.state).join(', ') + ') while at least one is not terminal.',
        evidence: { steps: node.path, states: node.runtimes.map((runtime) => runtime.state) },
      })
      continue
    }
    for (const move of moves) {
      if (move.machines.length > 1) firedCount.set(move.event, (firedCount.get(move.event) ?? 0) + 1)
      const nextKey = keyOf(move.next)
      if (visited.has(nextKey)) continue
      queue.push({ runtimes: move.next.runtimes, path: [...node.path, { event: move.event, machines: move.machines }] })
    }
  }
  const c2Findings: Finding[] = []
  const allEventsSet = new Set<string>()
  for (const set of machineEventSets) for (const event of set) allEventsSet.add(event)
  for (const event of rendezvous) {
    if (!allEventsSet.has(event)) continue
    if ((firedCount.get(event) ?? 0) === 0) {
      c2Findings.push({
        code: 'C2_RENDEZVOUS_NEVER_FIRES',
        severity: 'warning',
        message: 'Rendezvous event ' + event + ' can never fire: fewer than two machines ever jointly enable it.',
      })
    }
  }
  const errors = c1Findings.length
  const warnings = c2Findings.length
  const checks: CheckResult[] = [
    checkResult('C1', 'Composition Deadlock', c1Findings, c1Findings.length === 0 ? 'No composition deadlock reachable' : 'Composition deadlocks: ' + c1Findings.length),
    checkResult('C2', 'Rendezvous Sync', c2Findings, c2Findings.length === 0 ? 'All rendezvous events can fire' : 'Rendezvous warnings: ' + c2Findings.length),
  ]
  return {
    ok: errors === 0,
    summary: { machineCount: models.length, machines: machineSummary, compositeStates, errors, warnings, truncated },
    checks,
  }
}
