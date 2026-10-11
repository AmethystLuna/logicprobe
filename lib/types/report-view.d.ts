/** Rendering limits. Defaults are the shipped behaviour; tests pin them. */
export interface ReportViewOptions {
    /** Maximum finding lines per check. Error findings are never dropped, only warnings are capped. */
    maxFindingsPerCheck?: number;
    /** Evidence is inlined for `error` findings only, truncated to this many characters. */
    maxEvidenceChars?: number;
    /** Include passing checks' bodies (default false: a passing check carries no actionable finding). */
    includePassing?: boolean;
    /**
     * Print the whole structured report instead of the body. This is the escape hatch for a
     * caller that must hand the report to another tool verbatim — `logicprobe_report_diff`
     * matches on check + code + evidence, so a body cannot stand in for the object.
     */
    full?: boolean;
}
type Record_ = Record<string, unknown>;
/** One normalized finding. `evidence` is kept because a finding's identity depends on it. */
export interface ViewFinding {
    code: string;
    severity: string;
    message: string;
    evidence?: Record_;
    file?: string;
    line?: number;
    check?: string;
}
/** Normalize one raw finding. Unknown fields are ignored; a missing message renders as the code. */
export declare function toViewFinding(value: unknown, check?: string): ViewFinding;
/**
 * The fact a finding states, as a comparable key. The verify/datamodel families report the
 * same (state, event) fact from more than one check, so the key ignores which check said it;
 * anything else falls back to code + message.
 */
export declare function factKey(finding: ViewFinding): string;
/**
 * Render any logicprobe result as the text a model reads.
 *
 * Order of recognition: a `checks[]` report, a flat `findings[]` report, a baseline delta,
 * a payload result (`diagram`/`primary`), and finally compact JSON so an unrecognized shape
 * is still readable rather than silently empty.
 */
export declare function renderReportText(value: unknown, options?: ReportViewOptions): string;
export {};
