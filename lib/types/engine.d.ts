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
    /** Deadline (A14): the state must be left within this many declared tick events of entering it. */
    maxTicks?: number;
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
/**
 * Scope filter for a state-predicate invariant (see `InvariantSpec`): the range is
 * only required to hold in runtime states that satisfy the filter. Exactly one of
 * `state` / guard-node form must be present.
 */
export interface StateGuard {
    /** Only runtime states whose id is this state are checked. */
    state: string;
}
/** A `when` filter: either a single-state scope or the ordinary guard language. */
export type InvariantWhen = StateGuard | GuardNode;
export declare function isStateGuard(when: InvariantWhen): when is StateGuard;
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
    /**
     * Optional scope. `when` is evaluated against the POST-state of every transition
     * (and, for the `{ state }` form, against the initial state regardless), so a
     * `{ state }` scope is sound: for every reachable runtime state inside the scope
     * the variable is in range. A guard-node scope that references the constrained
     * variable can mask its own violation — prefer `{ state }` or an independent
     * control variable. Not offered on trace-property kinds (leads-to, sequence, ...),
     * whose scope over a path would be ambiguous.
     */
    when?: InvariantWhen;
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
    to: string | string[];
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
    /** Events that advance the discrete clock by one tick; used by A14 deadline checks. */
    tickEvents?: string[];
    /** Natural-language descriptions of states, events, and (state, event) scenarios. */
    narrative?: ModelNarrative;
}
export interface VerificationOptions {
    maxStates?: number;
    maxPermutationEvents?: number;
    beforeModel?: unknown;
    stateMapping?: Record<string, string>;
    /** Hash specification used for modelHash. Defaults to the current published spec (`v1`). */
    hashSpec?: HashSpec;
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
    /** Longer explanation: the shortest-path note, the per-machine reasons, the quoted source lines. */
    detail?: string;
    /** The artefact the finding is about (a diagram name, a file path) — set when one report covers several. */
    file?: string;
    /** 1-based line in that artefact, when the check knows it. */
    line?: number;
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
    /**
     * The engine ran and the input was well-formed enough to produce this report.
     * It does NOT mean the review passed — read `verdict` for that.
     */
    ok: boolean;
    /** The tool executed and produced a report. False only when a tool refused the request before the engine ran. */
    ran: boolean;
    /** The review outcome. `ok: true` with `verdict: "fail"` is a failing review, not a passing one. */
    verdict: Verdict;
    /** Why the verdict came out that way, e.g. `2 error finding(s) (first: S2_NO_TRANSITIONS)`. */
    verdictReason: string;
    /** The versioned report contract this result follows. */
    schema: ReportSchema;
    schemaVersion: 1;
    /** Which published specification `modelHash` follows (see references/hash-spec.md). */
    hashSpec: HashSpec;
    modelHash: string;
    /** Every hash this report carries, in one place, for a baseline diff or an archive record. */
    hashes: {
        hashSpec: HashSpec;
        modelHash: string;
        beforeModelHash?: string;
        afterModelHash?: string;
    };
    /** Paths of the `_`-prefixed metadata keys found in the input and ignored by the schema. */
    metadataKeys?: string[];
    /** How much of the model the narrative documents; absent when there is no narrative. */
    narrativeCoverage?: NarrativeCoverage;
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
    /** What to do next, derived from the findings — never empty. */
    nextSteps: string[];
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
export declare function modelHash(model: LogicModelV1, spec?: HashSpec): string;
/**
 * Deterministic JSON (sorted keys, no insignificant whitespace) — the serialization the
 * hash specification is defined over. Exported so every report hashes inputs the same way.
 */
export declare function canonicalJson(value: unknown): string;
/**
 * Published model-hash specifications. The full normalization rules, the list of
 * excluded keys and a one-line recompute command are in `references/hash-spec.md`.
 *
 * - `v1` (1.0.0) drops every `_`-prefixed metadata key at every level before hashing,
 *   so archiving `_source` / `_verified` next to a model cannot change its hash.
 * - `v0` is the pre-1.0.0 behaviour (no metadata filtering), kept so an archived hash
 *   can still be checked against the old engine.
 *
 * For a model that carries no `_` keys the two specs are byte-identical.
 */
export type HashSpec = 'v0' | 'v1';
export declare const PUBLISHED_HASH_SPECS: readonly HashSpec[];
export declare const DEFAULT_HASH_SPEC: HashSpec;
/**
 * Versioned report contracts. Every tool result carries `schema`, so a consumer can
 * branch on the contract instead of sniffing fields, and a change to a report's shape
 * is a version bump here rather than a silent break. `findings[]` keeps the same
 * stable core in every family: `{code, severity, message, detail?, evidence?, path?}`.
 */
export declare const REPORT_SCHEMAS: {
    readonly verify: 'logicprobe/verify/v1';
    readonly compose: 'logicprobe/compose/v1';
    readonly datamodel: 'logicprobe/datamodel/v1';
    readonly concurrency: 'logicprobe/concurrency/v1';
    readonly export: 'logicprobe/export/v1';
    readonly umlRender: 'logicprobe/uml/render/v1';
    readonly umlParse: 'logicprobe/uml/parse/v1';
    readonly umlReview: 'logicprobe/uml/review/v1';
    readonly structure: 'logicprobe/structure/v1';
    readonly granularity: 'logicprobe/granularity/v1';
    readonly baseline: 'logicprobe/baseline/v1';
};
export type ReportSchema = typeof REPORT_SCHEMAS[keyof typeof REPORT_SCHEMAS];
/**
 * How much of the model the `narrative` block actually documents, as `covered/total`
 * per dimension. A partial narrative is valid — writing the states first and the
 * events later is the natural order — so this is a coverage report, not a gate.
 * `scenarios` counts distinct modelled (from, event) groups: one scenario per group.
 */
export interface NarrativeCoverage {
    states: string;
    events: string;
    scenarios: string;
}
export declare function narrativeCoverageOf(model: LogicModelV1): NarrativeCoverage | undefined;
/** True when every dimension of the coverage is fully described. */
export declare function narrativeComplete(coverage: NarrativeCoverage | undefined): boolean;
/**
 * The review outcome, kept separate from `ok` (= "the tool ran"). Collapsing the two
 * is how a failed review gets read as a passing one.
 */
export type Verdict = 'pass' | 'pass_with_findings' | 'fail';
export interface VerdictSummary {
    verdict: Verdict;
    verdictReason: string;
}
/** A tool that refused the request before running anything: it neither passed nor failed a review. */
export declare function refusalVerdict(reason: string): VerdictSummary;
/**
 * Decide the verdict from finding counts. Any error-severity finding fails the review
 * even though the tool ran successfully — that gap is exactly what `verdict` closes.
 */
export declare function verdictOf(errors: number, warnings: number, firstCode?: string): VerdictSummary;
export declare function verdictOfFindings(findings: Array<{
    code: string;
    severity: string;
}>): VerdictSummary;
/**
 * Paths of every `_`-prefixed key in the input, sorted (`_source`, `_verified`,
 * `states[0]._note`; a metadata key's own children are not listed, since the subtree is
 * metadata as a whole). The schema ignores these keys as annotation metadata; echoing
 * them in the report makes the ignored metadata auditable instead of invisible.
 */
export declare function metadataKeysOf(input: unknown): string[];
/**
 * The exact payload a hash spec hashes. Exported so the specification has one
 * implementation and the documentation can be checked against it.
 */
export declare function hashPayload(model: unknown, spec?: HashSpec): unknown;
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
    /** Indices of the machines that advanced together on this step. */
    machines: number[];
}
export interface CompositionOptions {
    /** Events that require a synchronized multi-machine step (handshake). */
    rendezvous?: string[];
    maxStates?: number;
    /** Hash specification used for the per-machine modelHash. Defaults to the current published spec (`v1`). */
    hashSpec?: HashSpec;
}
export interface CompositionSummary {
    machineCount: number;
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
    /** Historical meaning: the composition has no error-severity finding. Read `verdict` for the review outcome. */
    ok: boolean;
    ran: boolean;
    verdict: Verdict;
    verdictReason: string;
    /** The versioned report contract this result follows. */
    schema: ReportSchema;
    /** Which published specification the per-machine `modelHash` values follow. */
    hashSpec: HashSpec;
    /** Every hash this report carries, in one place. */
    hashes: {
        hashSpec: HashSpec;
        machines: string[];
    };
    summary: CompositionSummary;
    checks: CheckResult[];
    /** What to do next, derived from the findings — never empty. */
    nextSteps: string[];
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
export declare function runCompositionVerification(machinesInput: unknown[], options?: CompositionOptions): CompositionReport;
