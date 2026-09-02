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
    findings: ConcurrencyFinding[];
    summary: {
        lines: number;
        keywords: number;
        absoluteClaims: number;
        warnings: number;
        errors: number;
    };
}
export declare function runConcurrencyScan(text: string): ConcurrencyScanReport;
