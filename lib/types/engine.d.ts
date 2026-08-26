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
}
export interface VariableSpec {
    name: string;
    kind: 'integer' | 'boolean';
    init: number | boolean;
    min?: number;
    max?: number;
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
