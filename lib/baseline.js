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
import { canonicalJson, REPORT_SCHEMAS, verdictOf } from './engine.js';
/**
 * The stable identity of a finding: the check + code + a canonical locator. Prose is
 * excluded so a reworded message reads as `changed`, not as a new finding.
 */
export function findingIdentity(finding) {
    const locator = canonicalJson({
        ...(finding.evidence === undefined ? {} : { evidence: finding.evidence }),
        ...(finding.path === undefined ? {} : { path: finding.path }),
    });
    const where = locator === '{}' ? 'message:' + finding.message : locator;
    return (finding.check === undefined ? '' : finding.check + '|') + finding.code + '|' + where;
}
/** Flatten a report of any family into one finding list (`checks[].findings` or `findings[]`). */
export function flattenReportFindings(report) {
    if (report === null || typeof report !== 'object')
        return [];
    const record = report;
    const flat = [];
    if (Array.isArray(record.checks)) {
        for (const check of record.checks) {
            const id = typeof check.id === 'string' ? check.id : undefined;
            for (const finding of (Array.isArray(check.findings) ? check.findings : [])) {
                flat.push(id === undefined ? finding : { ...finding, check: id });
            }
        }
    }
    if (Array.isArray(record.findings)) {
        for (const finding of record.findings)
            flat.push(finding);
    }
    return flat;
}
/** The report's own verdict, whatever family it came from. */
function verdictOfReport(report) {
    if (report === null || typeof report !== 'object')
        return 'fail';
    const value = report.verdict;
    return value === 'pass' || value === 'pass_with_findings' || value === 'fail' ? value : 'fail';
}
function diffOf(added, removed, addedErrors, firstCode) {
    if (addedErrors > 0) {
        return {
            verdict: 'fail',
            verdictReason: String(added) + ' new finding(s) (' + String(addedErrors) + ' error)' + (firstCode === undefined ? '' : ' (first: ' + firstCode + ')'),
        };
    }
    if (added > 0) {
        return { verdict: 'pass_with_findings', verdictReason: String(added) + ' new warning finding(s), no new errors' };
    }
    if (removed > 0) {
        return { verdict: 'pass', verdictReason: 'no new findings; ' + String(removed) + ' finding(s) resolved' };
    }
    return { verdict: 'pass', verdictReason: 'no new findings, nothing resolved' };
}
/**
 * Compare a baseline report with the current one. The verdict describes the *delta*
 * (a new error fails it), while `currentVerdict` keeps the absolute result visible.
 */
export function diffReports(baseline, current) {
    const before = flattenReportFindings(baseline);
    const after = flattenReportFindings(current);
    const beforeByIdentity = new Map();
    for (const finding of before)
        beforeByIdentity.set(findingIdentity(finding), finding);
    const seen = new Set();
    const added = [];
    const changed = [];
    for (const finding of after) {
        const identity = findingIdentity(finding);
        seen.add(identity);
        const previous = beforeByIdentity.get(identity);
        if (previous === undefined) {
            added.push(finding);
            continue;
        }
        if (previous.severity !== finding.severity || previous.message !== finding.message) {
            changed.push({
                identity,
                code: finding.code,
                before: { severity: previous.severity, message: previous.message },
                after: { severity: finding.severity, message: finding.message },
            });
        }
    }
    const removed = before.filter((finding) => !seen.has(findingIdentity(finding)));
    const addedErrors = added.filter((finding) => finding.severity === 'error');
    const addedWarnings = added.filter((finding) => finding.severity === 'warning');
    const delta = diffOf(added.length, removed.length, addedErrors.length, addedErrors[0]?.code);
    const nextSteps = [];
    if (addedErrors.length > 0) {
        nextSteps.push('Fix or explicitly accept the ' + String(addedErrors.length) + ' new error finding(s) before calling this slice done: the baseline is what "not worse" is measured against.');
    }
    else if (added.length > 0) {
        nextSteps.push('The new warnings are not failures, but they are new: decide per finding whether the change introduced them or the baseline was incomplete.');
    }
    else {
        nextSteps.push('No new findings: re-record the baseline with this report if the slice is accepted, so the next comparison starts from it.');
    }
    if (changed.length > 0)
        nextSteps.push('Review the ' + String(changed.length) + ' changed finding(s): the same locator now reports something different, which usually means the fix moved the problem.');
    if (removed.length > 0)
        nextSteps.push(String(removed.length) + ' finding(s) from the baseline are gone — confirm they were fixed rather than renamed out of the report (a renamed check or a reworded message changes the identity).');
    if (verdictOfReport(current) === 'fail')
        nextSteps.push('The current report still fails on its own terms; the delta being clean does not make the run clean.');
    return {
        ok: true,
        ran: true,
        ...delta,
        schema: REPORT_SCHEMAS.baseline,
        currentVerdict: verdictOfReport(current),
        added,
        removed,
        changed,
        summary: {
            baseline: before.length,
            current: after.length,
            added: added.length,
            removed: removed.length,
            changed: changed.length,
            addedErrors: addedErrors.length,
            addedWarnings: addedWarnings.length,
        },
        nextSteps,
    };
}
