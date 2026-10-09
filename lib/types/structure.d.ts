/**
 * Structure-diagram review: a dependency graph is not a state machine.
 *
 * The state-machine front end (`uml.ts`) reads a component, package, class or
 * deployment diagram as a *by-product* and says so (`UML_NOT_A_STATE_DIAGRAM`).
 * This module reads the same text as what it actually is — a directed graph of
 * nodes and dependency edges — and audits it against a declared dependency matrix.
 *
 * The checks are the structural ones a reader performs by eye and gets wrong:
 * an isolated node nobody notices, an arrow whose endpoint was never declared, a
 * dependency cycle, an edge that violates the allowed-dependency matrix, a child
 * depending on its parent, and an edge the matrix says must exist but the diagram
 * does not draw. Every finding names the rule id it hit, so the diagram and the
 * source-side checker can be reconciled rule by rule.
 *
 * @module logicprobe-structure
 */
import { type Finding, type ReportSchema, type Verdict, type VerdictSummary } from './engine.js';
export type StructureNotation = 'plantuml' | 'mermaid';
/** What a node declares itself to be. Containers hold other nodes; they are not dependencies. */
export type StructureNodeKind = 'component' | 'class' | 'interface' | 'actor' | 'database' | 'node' | 'package' | 'rectangle' | 'cloud' | 'queue' | 'unknown';
export interface StructureNode {
    id: string;
    /** Display label when the declaration carried one (`component "Order Service" as SVC`). */
    label?: string;
    kind: StructureNodeKind;
    /** True when the node is a container (package/rectangle/frame): it owns members and carries no dependency of its own. */
    container: boolean;
    /** 1-based line of the declaration. Absent when the node was only ever named by an edge. */
    line?: number;
    declared: boolean;
    /** Container id this node was declared inside, if any. */
    parent?: string;
}
export interface StructureEdge {
    from: string;
    to: string;
    /** Arrow label, e.g. `read` in `PAY --> DRV : read`. */
    label?: string;
    line: number;
}
export interface StructureGraph {
    notation: StructureNotation;
    nodes: StructureNode[];
    edges: StructureEdge[];
    warnings: string[];
}
/** One dependency rule from the matrix document. */
export interface StructureRule {
    id: string;
    /** Node id or glob the rule applies to; absent = applies to every source. */
    source?: string;
    /** Permitted targets (glob or node id). Winning an allow match permits the edge. */
    allow?: string[];
    /** Forbidden targets. Deny always wins over allow. */
    deny?: string[];
    /** When true, at least one edge matching source→targets must exist (UML025). */
    require?: boolean;
}
export interface StructureLayer {
    name: string;
    /** Node ids or globs that belong to this layer. */
    members: string[];
}
/**
 * The dependency matrix: the single source of truth a diagram is checked against.
 * `default` decides the fate of an edge no rule mentions (`allow` = only explicit
 * rules judge, `deny` = anything unlisted is a violation).
 */
export interface DependencyMatrix {
    rules?: StructureRule[];
    layers?: StructureLayer[];
    default?: 'allow' | 'deny';
}
export interface StructureEdgeVerdict {
    from: string;
    to: string;
    line: number;
    /** Rule ids whose `source` matched this edge, whether they allowed or denied it. */
    matchedRules: string[];
    allowed: boolean;
    /** `allow` (a rule permitted it), `default` (nothing judged it), `deny` (a rule forbade it), `unlisted` (default=deny and no rule matched). */
    basis: 'allow' | 'default' | 'deny' | 'unlisted';
}
export interface StructureSummary {
    nodes: number;
    edges: number;
    containers: number;
    isolated: number;
    dangling: number;
    cycles: number;
    disallowedEdges: number;
    layerViolations: number;
    missingExpectedEdges: number;
    errors: number;
    warnings: number;
    rules: number;
}
export interface StructureReport {
    /** The tool ran and produced this report; read `verdict` for the outcome. */
    ok: boolean;
    ran: boolean;
    verdict: Verdict;
    verdictReason: string;
    /** The versioned report contract this result follows. */
    schema: ReportSchema;
    notation: StructureNotation;
    graph: StructureGraph;
    /** Per-edge matrix verdict, present only when a matrix was supplied. */
    edgeVerdicts?: StructureEdgeVerdict[];
    findings: Finding[];
    summary: StructureSummary;
    /** Hashes of the inputs this report is about: the diagram text, and the matrix when one was supplied. */
    hashes: {
        diagram: string;
        matrix?: string;
    };
    warnings: string[];
    nextSteps: string[];
}
/** A finding code in the structure family; the numbers continue the UML0xx series after UML019. */
export type StructureFindingCode = 'UML020_ISOLATED_NODE' | 'UML021_DANGLING_REFERENCE' | 'UML022_CYCLE' | 'UML023_DISALLOWED_EDGE' | 'UML024_LAYER_VIOLATION' | 'UML025_MISSING_EXPECTED_EDGE' | 'UML026_NO_NODES';
/**
 * Parse a structure diagram (PlantUML component/package/class/deployment, Mermaid
 * class diagram) into nodes and dependency edges.
 *
 * A structure diagram is *not* refused here: refusing is the state-machine front
 * end's job (`parseUml`). This parser is the honest reading of the same text.
 */
export declare function parseStructure(text: string, notation?: 'auto' | StructureNotation): StructureGraph;
/** `*` matches any run of characters, `?` exactly one. Ids keep their own punctuation. */
export declare function globMatches(pattern: string, value: string): boolean;
export declare function validateMatrix(input: unknown): {
    ok: true;
    matrix: DependencyMatrix;
} | {
    ok: false;
    errors: string[];
};
/** Shortest directed cycle through the graph, as a node path with the start repeated. */
export declare function shortestCycle(nodes: string[], edges: StructureEdge[]): string[] | undefined;
export interface StructureReviewOptions {
    /** Diagram text to review. */
    diagram: string;
    notation?: 'auto' | StructureNotation;
    /** Dependency matrix: allowed/denied edges, layers, required edges. */
    matrix?: unknown;
}
/**
 * Audit a structure diagram. Every check is structural: it reads the drawn graph and
 * the declared matrix, and never claims anything about the code behind them.
 */
export declare function reviewStructure(options: StructureReviewOptions): StructureReport;
/** The finding codes this module can emit, for documentation and tests. */
export declare const STRUCTURE_FINDING_CODES: readonly StructureFindingCode[];
export type { VerdictSummary };
