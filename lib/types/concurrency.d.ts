import { type ReportSchema, type Verdict } from './engine.js';
export interface ConcurrencyFinding {
    code: 'CONCURRENCY_KEYWORD' | 'CONCURRENCY_ABSOLUTE_CLAIM';
    severity: 'warning' | 'error';
    message: string;
    line?: number;
    snippet?: string;
    keyword: string;
    /** Route to dedicated verification tools when an absolute claim is detected (logicprobe does not prove concurrency safety). */
    suggestions?: string[];
}
export interface ConcurrencyScanReport {
    ok: boolean;
    ran: boolean;
    verdict: Verdict;
    verdictReason: string;
    /** The versioned report contract this result follows. */
    schema: ReportSchema;
    findings: ConcurrencyFinding[];
    summary: {
        lines: number;
        keywords: number;
        absoluteClaims: number;
        warnings: number;
        errors: number;
    };
    /** This scan hashes no model; the field is present so every report has the same shape. */
    hashes: Record<string, string>;
    /** What to do next, derived from the findings — never empty. */
    nextSteps: string[];
}
export declare function runConcurrencyScan(text: string): ConcurrencyScanReport;
