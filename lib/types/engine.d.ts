export declare const ENGINE_SCHEMA_VERSION = 1;
export type VarValue = number | boolean;
export type GuardOp = '==' | '!=' | '<' | '<=' | '>' | '>=';
export interface LeafGuard {
    variable: string;
    op: GuardOp;
    value: VarValue;
}
export interface AllGuard {
    all: GuardNode[];
}
export interface AnyGuard {
    any: GuardNode[];
}
export interface NotGuard {
    not: GuardNode;
}
export type GuardNode = LeafGuard | AllGuard | AnyGuard | NotGuard;
export interface StateSpec {
    id: string;
    terminal?: boolean;
    /** Actions fired automatically when the state is entered. They do not change state or variables; checks such as A4 Pair Symmetry treat them as implicit acquire/release events so lock/unlock hidden inside entry actions is verified. */
    onEntry?: string[];
    /** Actions fired automatically when the state is left. Same semantics as onEntry. */
    onExit?: string[];
}
export interface UpdateSpec {
    variable: string;
    op: 'set' | 'inc' | 'dec';
    value?: number;
}
export interface TransitionSpec {
    from: string;
    event: string;
    to: string;
    /** Absent guard is the else/default branch for the same (from, event) group. */
    guard?: GuardNode;
    updates?: UpdateSpec[];
    /** Execution cost of firing this transition (e.g. cycles, microseconds). Absent cost defaults to 1, so an unannotated machine keeps step-count semantics. Checked by A12 against budget invariants. */
    cost?: number;
    /** Relative probability weight when a probability invariant is declared (DTMC interpretation). Absent weight = 1; weight 0 means the branch never fires probabilistically. */
    weight?: number;
}
export interface TransitionScenarioSpec {
    from: string;
    event: string;
    /** Natural language: what this (state, event) combination represents in the real scenario. */
    scenario: string;
}
export interface ModelNarrative {
    /** Natural-language meaning of each state id. */
    states?: Record<string, string>;
    /** Natural-language meaning of each event id. */
    events?: Record<string, string>;
    /** Natural-language scenario for each distinct (from, event) combination. */
    scenarios?: TransitionScenarioSpec[];
}
export interface VariableSpec {
    name: string;
    kind: 'integer' | 'boolean';
    init: number | boolean;
    min?: number;
    max?: number;
    monotonic?: 'inc' | 'dec';
}
export type InvariantSpec = {
    id: string;
    description: string;
    kind: 'never-states';
    states: string[];
} | {
    id: string;
    description: string;
    kind: 'var-in-range';
    variable: string;
    min?: number;
    max?: number;
} | {
    id: string;
    description: string;
    kind: 'event-before-state';
    event: string;
    state: string;
} | {
    id: string;
    description: string;
    kind: 'leads-to';
    from: string;
    to: string;
} | {
    id: string;
    description: string;
    kind: 'sequence';
    events: string[];
} | {
    id: string;
    description: string;
    kind: 'atomicity';
    events: string[];
    commit: string;
    rollback?: string;
} | {
    id: string;
    description: string;
    kind: 'budget';
    budget: number;
} | {
    id: string;
    description: string;
    kind: 'probability';
    target: string;
    op: '>=' | '<=' | '>' | '<';
    p: number;
};
export interface ResourcePairSpec {
    resource: string;
    acquireEvent: string;
    releaseEvent: string;
    failEvent?: string;
}
export interface BoundaryCheckSpec {
    variable: string;
    values: number[];
}
export interface LogicModelV1 {
    schemaVersion: 1;
    init: string;
    states: StateSpec[];
    transitions: TransitionSpec[];
    variables?: VariableSpec[];
    invariants?: InvariantSpec[];
    concurrentPairs?: [string, string][];
    boundaryChecks?: BoundaryCheckSpec[];
    resourcePairs?: ResourcePairSpec[];
    idempotentEvents?: string[];
    /** Natural-language descriptions of states, events, and (state, event) scenarios. */
    narrative?: ModelNarrative;
}
export interface VerificationOptions {
    maxStates?: number;
    maxPermutationEvents?: number;
    beforeModel?: unknown;
    stateMapping?: Record<string, string>;
}
export interface PathStep {
    from: string;
    event: string;
    to: string;
}
export interface Finding {
    code: string;
    severity: 'error' | 'warning';
    message: string;
    path?: PathStep[];
    evidence?: Record<string, unknown>;
}
export interface CheckResult {
    id: string;
    name: string;
    status: 'pass' | 'fail' | 'skip';
    detail: string;
    findings: Finding[];
}
export interface VerificationReport {
    ok: boolean;
    schemaVersion: 1;
    modelHash: string;
    /** Echo of the model's natural-language narrative, when present. */
    narrative?: ModelNarrative;
    summary: {
        states: number;
        transitions: number;
        errors: number;
        warnings: number;
        checksRun: number;
        truncated?: boolean;
    };
    checks: CheckResult[];
    comparison?: ComparisonSummary;
    /** Informational notes about semantic dimensions this model references (timing, preemption)
     * that this engine does not verify. Heuristic, vocabulary-based — never a substitute for the checks. */
    coverageNotes?: string[];
}
export interface ComparisonSummary {
    beforeModelHash: string;
    afterModelHash: string;
    stateMapping: Record<string, string>;
    beforeStates: number;
    beforeTransitions: number;
    afterStates: number;
    afterTransitions: number;
    addedStates: string[];
    removedStates: string[];
    addedEvents: string[];
    removedEvents: string[];
    addedTransitions: TransitionSpec[];
    removedTransitions: TransitionSpec[];
}
export interface RuntimeState {
    state: string;
    vars: Record<string, VarValue>;
}
export declare function modelHash(model: LogicModelV1): string;
export declare function validateModel(input: unknown): {
    ok: true;
    model: LogicModelV1;
} | {
    ok: false;
    errors: string[];
};
export declare function guardVariables(guard: GuardNode | undefined): string[];
export declare function runVerification(input: unknown, options?: VerificationOptions): VerificationReport;
export interface CompositionStep {
    event: string;
    by: 'a' | 'b' | 'both';
}
export interface CompositionOptions {
    /** Events that require BOTH machines to fire together (rendezvous / handshake). */
    rendezvous?: string[];
    maxStates?: number;
}
export interface CompositionSummary {
    machines: Array<{
        modelHash: string;
        states: number;
        transitions: number;
    }>;
    compositeStates: number;
    errors: number;
    warnings: number;
    truncated: boolean;
}
export interface CompositionReport {
    ok: boolean;
    summary: CompositionSummary;
    checks: CheckResult[];
}
/**
 * Two-machine composition under a choice of semantics:
 * - a non-rendezvous event advances only the machine that fires it;
 * - a rendezvous event (handshake) fires only when BOTH machines have it enabled
 *   (guards satisfied) and advances both simultaneously;
 * - a terminal machine is stopped: it takes no further part, so a rendezvous with a
 *   terminal machine can never fire.
 * Checks: C1 composition deadlock (a reachable pair where no machine can advance while
 * at least one is not terminal) and C2 rendezvous that can never synchronize.
 */
export declare function runCompositionVerification(machinesInput: unknown[], options?: CompositionOptions): CompositionReport;
