/**
 * Multi-granularity structure review: one architecture, several levels of detail.
 *
 * A module diagram and the repository-wide diagram it belongs to are two views of one
 * fact, and nothing keeps them in step — the child grows a dependency the parent never
 * had, or the parent keeps an arrow the child quietly stopped drawing. This module
 * checks that a child diagram is a **refinement** of its declared parent:
 *
 * - every dependency the child draws between two nodes the parent also has must exist in
 *   the parent (nothing appears out of nowhere);
 * - an edge the parent draws and the child does not must be *expanded* in the child, i.e.
 *   a child path must connect the same two ends;
 * - the declared parent relation must be a forest, not a cycle.
 *
 * Every per-diagram structural check still runs, and its findings are tagged with the
 * diagram they came from (`file`), so one report can carry several diagrams without the
 * findings becoming anonymous.
 *
 * @module logicprobe-granularity
 */
import { type Finding, type ReportSchema, type Verdict, type VerdictSummary } from './engine.js';
import { type StructureNotation } from './structure.js';
export interface GranularityDiagram {
    /** Name of this level, e.g. `L2/motion` or `repo`. Referenced by a child's `parent`. */
    name: string;
    /** Diagram source text. */
    diagram: string;
    /** Name of the diagram this one refines; absent for a root. */
    parent?: string;
}
export interface GranularityOptions {
    diagrams: GranularityDiagram[];
    notation?: 'auto' | StructureNotation;
    /** Optional dependency matrix, applied to every diagram. */
    matrix?: unknown;
}
export interface GranularityEdgeRef {
    from: string;
    to: string;
    line?: number;
}
export interface GranularityPairSummary {
    parent: string;
    child: string;
    parentNodes: number;
    childNodes: number;
    parentEdges: number;
    childEdges: number;
    /** Child edges whose endpoints both exist in the parent and which the parent also draws. */
    inheritedEdges: number;
    /** Child edges with at least one endpoint the parent does not have (the refinement's own detail). */
    newEdges: number;
    /** Parent edges with no direct child counterpart, but a child path connects the same ends. */
    expandedEdges: GranularityEdgeRef[];
    /** Parent edges with no direct counterpart and no connecting path — the refinement lost them. */
    missingEdges: GranularityEdgeRef[];
    /** Child edges between two parent nodes that the parent does not draw — invented dependencies. */
    inventedEdges: GranularityEdgeRef[];
}
export interface GranularityDiagramSummary {
    name: string;
    parent?: string;
    notation: StructureNotation;
    nodes: number;
    edges: number;
    verdict: Verdict;
    findings: number;
}
export interface GranularityReport {
    ok: boolean;
    ran: boolean;
    verdict: Verdict;
    verdictReason: string;
    schema: ReportSchema;
    diagrams: GranularityDiagramSummary[];
    pairs: GranularityPairSummary[];
    findings: Finding[];
    summary: {
        diagrams: number;
        roots: number;
        pairs: number;
        nodes: number;
        edges: number;
        inventedEdges: number;
        missingEdges: number;
        expandedEdges: number;
        errors: number;
        warnings: number;
    };
    hashes: {
        diagrams: Array<{
            name: string;
            hash: string;
        }>;
    };
    warnings: string[];
    nextSteps: string[];
}
/**
 * Review a set of structure diagrams with declared parent relations. Per-diagram
 * structural checks run first; the cross-diagram refinement checks follow.
 */
export declare function reviewGranularity(options: GranularityOptions): GranularityReport;
/** Deterministic JSON of a granularity report's pair table, for a stable summary line. */
export declare function granularityDigest(pairs: GranularityPairSummary[]): string;
export type { VerdictSummary };
