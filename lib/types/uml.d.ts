/**
 * UML front end for LogicModelV1 — model a code flow as a UML diagram, then
 * review the modelling itself.
 *
 * Two halves, one data flow:
 *
 *   1. `renderUml` turns a validated LogicModelV1 into Mermaid or PlantUML text
 *      (state machine, activity/flow, or sequence trace). The diagram is a
 *      *view*: it never invents structure the model does not have, and anything
 *      the notation cannot express is reported as a warning instead of being
 *      dropped silently.
 *   2. `parseUml` reads that text back into a LogicModelV1, and `reviewUml`
 *      compares the two. That comparison is the point of the feature: a UML
 *      diagram of a code flow is itself a model, and a model can be wrong —
 *      ambiguous branches, dead ends, flows nobody can enter, symbols the
 *      source never names. A diagram that does not round-trip to the model it
 *      was drawn from is mis-modelled, and the review says so.
 *
 * Why the round trip is the fidelity check: rendering and parsing are inverse
 * only if every construct survives the notation. The generated text carries
 * `logicprobe:` directives (ignored by Mermaid/PlantUML renderers) that pin the
 * initial state, the terminal states and any state id the notation cannot spell
 * verbatim, so an exact comparison is possible rather than a fuzzy one.
 *
 * The review deliberately does NOT replace `logicprobe_verify`: it checks the
 * modelling (structure the diagram claims, documentation coverage, notation
 * fidelity), while S1-S8/A1-A14 check the machine's behaviour (guard
 * exhaustiveness under real valuations, invariant paths, deadlock/liveness in
 * the runtime state space). Findings name the engine check to run next.
 *
 * @module logicprobe-uml
 */
import type { GuardNode, LogicModelV1, UpdateSpec } from './engine.js';
export type UmlNotation = 'mermaid' | 'plantuml';
export type UmlDiagram = 'state' | 'activity' | 'sequence';
export declare const UML_NOTATIONS: readonly UmlNotation[];
export declare const UML_DIAGRAMS: readonly UmlDiagram[];
export interface UmlRenderResult {
    notation: UmlNotation;
    diagram: UmlDiagram;
    /** The diagram source; hand this to the user or a renderer as-is. */
    primary: string;
    warnings: string[];
}
export interface UmlParseResult {
    notation: UmlNotation;
    diagram: UmlDiagram;
    model: LogicModelV1;
    /**
     * Display labels found in the diagram, keyed by state id. They are how a
     * reader learns what a symbol means; a missing entry is an undocumented
     * symbol, which the review reports.
     */
    labels: Record<string, string>;
    warnings: string[];
}
export interface UmlFinding {
    code: string;
    severity: 'error' | 'warning' | 'info';
    message: string;
    states?: string[];
    events?: string[];
    transitions?: Array<{
        from: string;
        event: string;
        to: string;
    }>;
    detail?: string;
}
export interface UmlRoundTripReport {
    notation: UmlNotation;
    diagram: UmlDiagram;
    ok: boolean;
    modelHash: string;
    parsedHash: string;
    diffs: string[];
    warnings: string[];
}
export interface UmlReviewReport {
    ok: boolean;
    source: 'model' | 'diagram' | 'model+diagram';
    summary: {
        errors: number;
        warnings: number;
        info: number;
        states: number;
        events: number;
        transitions: number;
        terminalStates: number;
        reachableStates: number;
        documentedStates: number;
    };
    findings: UmlFinding[];
    roundTrip: UmlRoundTripReport | null;
    /** Diagram display labels, when a diagram took part in the review. */
    labels?: Record<string, string>;
    /** Model parsed from the diagram, when a diagram was given (feed it to `logicprobe_verify`). */
    model?: LogicModelV1;
    /** Diagram rendered from the model, when only a model was given. */
    primary?: string;
    warnings: string[];
    nextSteps: string[];
}
export declare class UmlError extends Error {
}
/** Canonical guard text. Rendering wraps every composite node in parentheses, and the parser flattens same-operator chains, so render∘parse is the identity. */
export declare function guardText(node: GuardNode): string;
/**
 * Render a LogicModelV1 as UML.
 *
 * PlantUML has no faithful activity view here: its activity syntax is a
 * structured flowchart language, so a graph with merges or cycles needs a
 * while/if reconstruction this module does not perform. Refusing is the honest
 * outcome — quietly emitting a state diagram under an "activity" request would
 * mislabel the model. Mermaid covers all three views.
 *
 * @param input - candidate LogicModelV1.
 * @param notation - `mermaid` (default) or `plantuml`.
 * @param diagram - `state` (default), `activity`, or `sequence`.
 * @param maxSteps - cap on the sequence trace length.
 */
export declare function renderUml(input: unknown, notation?: UmlNotation, diagram?: UmlDiagram, maxSteps?: number): UmlRenderResult;
/** Parse a guard expression such as `(retry < 3 && armed == true)`. */
export declare function parseGuardText(text: string): GuardNode;
/** Parse a UML action clause such as `retry := retry + 1, armed := true`. */
export declare function parseUpdatesText(text: string, warnings: string[]): UpdateSpec[];
/**
 * Parse a Mermaid or PlantUML diagram back into a LogicModelV1.
 *
 * State and activity diagrams carry the whole machine, so they parse into a
 * complete model. Sequence diagrams do not: a trace shows the paths that were
 * walked, not the branches that were not, so parsing one would silently prune
 * the machine. That case is refused rather than approximated.
 *
 * @param text - diagram source.
 * @param notation - `auto` (default) detects Mermaid vs PlantUML from the text.
 */
export declare function parseUml(text: string, notation?: UmlNotation | 'auto'): UmlParseResult;
/** Compare two machines by structure — the fidelity measure behind the round-trip check. */
export declare function diffModels(left: LogicModelV1, right: LogicModelV1): string[];
export interface UmlReviewOptions {
    /** LogicModelV1 to review. Provide it, `diagram`, or both. */
    model?: unknown;
    /** Diagram text: reviewed on its own, or compared against `model` when both are given. */
    diagram?: string;
    notation?: UmlNotation | 'auto';
    diagramKind?: UmlDiagram;
    /** Render-and-reparse fidelity check (default true; only meaningful with a model). */
    roundTrip?: boolean;
    /** Cap on the sequence trace used for the fidelity check. */
    maxSteps?: number;
}
/**
 * Review a UML model of a code flow.
 *
 * Three inputs are possible and each answers a different question:
 *
 * - `model` only — "is this machine well-modelled?" The review checks the
 *   structure the diagram would draw, then renders and re-parses it to prove the
 *   diagram carries the machine faithfully (round trip).
 * - `diagram` only — "what does this diagram actually say?" The diagram is parsed
 *   into a model, and that model is reviewed; nothing can be said about fidelity
 *   to a machine the caller did not provide.
 * - both — "does this diagram match this model?" Any structural difference is a
 *   modelling defect and is reported both as round-trip diffs and as a finding.
 */
export declare function reviewUml(options: UmlReviewOptions): UmlReviewReport;
