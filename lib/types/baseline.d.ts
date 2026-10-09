/**
 * Report diffing: "did this slice add findings, or remove them?"
 *
 * The acceptance criterion of a refactoring slice is usually *not* "zero findings" —
 * it is "no NEW findings, and none of the old ones got worse". Comparing two JSON
 * reports by hand is how that gets fudged, so the comparison is code.
 *
 * A finding's identity is its machine-readable locator, never its prose:
 * `check|code|<canonical evidence + path>`. Findings that carry neither evidence nor a
 * path fall back to their message, because an engine that reports nothing structured
 * has nothing stabler to match on. Two runs over the same input must produce zero
 * added and zero removed findings.
 *
 * @module logicprobe-baseline
 */
import { type Finding, type Verdict, type VerdictSummary } from './engine.js';
/** A finding as it appears in any report family, after flattening. */
export interface ReportFinding extends Finding {
    /** The check that emitted it (verify/datamodel: `S2`, `C1`, …); absent for flat families. */
    check?: string;
}
export interface BaselineChange {
    identity: string;
    code: string;
    before: {
        severity: string;
        message: string;
    };
    after: {
        severity: string;
        message: string;
    };
}
export interface BaselineReport {
    ok: boolean;
    ran: boolean;
    verdict: Verdict;
    verdictReason: string;
    /** The versioned report contract this result follows. */
    schema: string;
    /** The current report's own verdict, echoed so "no new findings" cannot hide a failing run. */
    currentVerdict: Verdict;
    added: ReportFinding[];
    removed: ReportFinding[];
    changed: BaselineChange[];
    summary: {
        baseline: number;
        current: number;
        added: number;
        removed: number;
        changed: number;
        addedErrors: number;
        addedWarnings: number;
    };
    nextSteps: string[];
}
/**
 * The stable identity of a finding: the check + code + a canonical locator. Prose is
 * excluded so a reworded message reads as `changed`, not as a new finding.
 */
export declare function findingIdentity(finding: ReportFinding): string;
/** Flatten a report of any family into one finding list (`checks[].findings` or `findings[]`). */
export declare function flattenReportFindings(report: unknown): ReportFinding[];
/**
 * Compare a baseline report with the current one. The verdict describes the *delta*
 * (a new error fails it), while `currentVerdict` keeps the absolute result visible.
 */
export declare function diffReports(baseline: unknown, current: unknown): BaselineReport;
export type { VerdictSummary };
