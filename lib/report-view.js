const DEFAULTS = { maxFindingsPerCheck: 24, maxEvidenceChars: 160, includePassing: false, full: false };
const record = (value) => typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
const array = (value) => (Array.isArray(value) ? value : []);
const text = (value) => (typeof value === 'string' ? value : undefined);
const count = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
/** Normalize one raw finding. Unknown fields are ignored; a missing message renders as the code. */
export function toViewFinding(value, check) {
    const raw = record(value) ?? {};
    const code = text(raw.code) ?? 'FINDING';
    const file = text(raw.file);
    const line = count(raw.line);
    return {
        code,
        severity: text(raw.severity) ?? 'warning',
        message: text(raw.message) ?? code,
        ...(record(raw.evidence) === undefined ? {} : { evidence: record(raw.evidence) }),
        ...(file === undefined ? {} : { file }),
        ...(line === undefined ? {} : { line }),
        ...(check === undefined ? {} : { check }),
    };
}
/**
 * The fact a finding states, as a comparable key. The verify/datamodel families report the
 * same (state, event) fact from more than one check, so the key ignores which check said it;
 * anything else falls back to code + message.
 */
export function factKey(finding) {
    const stateEvent = /^(\S+) silently ignores event (\S+)/.exec(finding.message);
    if (stateEvent !== null)
        return `event-in-state|${stateEvent[1] ?? ''}|${stateEvent[2] ?? ''}`;
    const eventState = /^Event (\S+) in state (\S+) /.exec(finding.message);
    if (eventState !== null)
        return `event-in-state|${eventState[2] ?? ''}|${eventState[1] ?? ''}`;
    return `message|${finding.code}|${finding.message}`;
}
/** `[severity/CODE] message` plus, for errors, a compact evidence tail. */
function findingLine(finding, options) {
    const where = finding.file === undefined ? '' : ` (${finding.file}${finding.line === undefined ? '' : ':' + String(finding.line)})`;
    const evidence = finding.evidence === undefined || finding.severity !== 'error'
        ? ''
        : ' evidence=' + truncate(JSON.stringify(finding.evidence), options.maxEvidenceChars);
    return `  [${finding.severity}/${finding.code}] ${finding.message}${where}${evidence}`;
}
function truncate(value, limit) {
    return value.length <= limit ? value : value.slice(0, limit - 1) + '…';
}
/** Collapse identical lines into `line (xN)`, keeping first-seen order. */
function collapse(lines) {
    const order = [];
    const seen = new Map();
    for (const line of lines) {
        if (!seen.has(line))
            order.push(line);
        seen.set(line, (seen.get(line) ?? 0) + 1);
    }
    return order.map((line) => (seen.get(line) === 1 ? line : `${line} (x${String(seen.get(line))})`));
}
/**
 * Body lines for one group of findings. Findings that restate a fact an earlier check already
 * reported are dropped (only their count survives), because re-reading them is pure cost;
 * `error` findings are never dropped.
 */
function findingLines(findings, options, seenFacts) {
    const lines = [];
    let repeats = 0;
    const fresh = [];
    const addedHere = new Set();
    for (const finding of findings) {
        const key = factKey(finding);
        // A fact another check already reported is dropped here (only its count survives), but a
        // fact repeated inside this same group is not a cross-check repeat: it collapses below
        // into one line with a multiplier, which keeps the count visible where it belongs.
        if (finding.severity !== 'error' && seenFacts.has(key) && !addedHere.has(key)) {
            repeats += 1;
            continue;
        }
        addedHere.add(key);
        seenFacts.add(key);
        fresh.push(finding);
    }
    const stateGroups = new Map();
    const singles = [];
    for (const finding of fresh) {
        const match = /^(\S+) silently ignores event (\S+)/.exec(finding.message) ?? /^Event (\S+) in state (\S+) /.exec(finding.message);
        if (match === null) {
            singles.push(finding);
            continue;
        }
        // `event in state` puts the state second; `state ignores event` puts it first.
        const state = / silently ignores event /.test(finding.message) ? match[1] ?? '' : match[2] ?? '';
        const event = / silently ignores event /.test(finding.message) ? match[2] ?? '' : match[1] ?? '';
        const group = stateGroups.get(state) ?? { severity: finding.severity, code: finding.code, events: [] };
        group.events.push(event);
        stateGroups.set(state, group);
    }
    for (const [state, group] of stateGroups) {
        lines.push(`  ${state} (${String(group.events.length)}) [${group.severity}/${group.code}]: ${group.events.join(', ')}`);
    }
    const rendered = collapse(singles.map((finding) => findingLine(finding, options)));
    const budget = options.maxFindingsPerCheck;
    const kept = [];
    let dropped = 0;
    for (const line of [...lines, ...rendered]) {
        if (kept.length < budget || line.includes('/error]'))
            kept.push(line);
        else
            dropped += 1;
    }
    if (dropped > 0)
        kept.push(`  +${String(dropped)} more warning line(s) — ask for this check by id to see them all`);
    if (repeats > 0)
        kept.push(`  (${String(repeats)} finding(s) here repeat facts already reported above)`);
    return kept;
}
/** `ok`/`verdict` header fields, shared by every report family. */
function headerLines(report, options) {
    const schema = text(report.schema) ?? 'logicprobe/report';
    const verdict = text(report.verdict);
    const ok = report.ok;
    const summary = record(report.summary) ?? {};
    const lines = [];
    const bits = [
        `${schema}`,
        verdict === undefined ? `ok=${String(ok)}` : `verdict=${verdict}`,
        text(report.verdictReason) ?? '',
        ok === undefined || verdict === undefined ? '' : `ok=${String(ok)}`,
    ].filter((bit) => bit !== '');
    lines.push(bits.join('  '));
    const hash = text(report.modelHash) ?? text(record(report.hashes)?.modelHash);
    const counts = ['states', 'transitions', 'errors', 'warnings', 'checksRun']
        .map((key) => (count(summary[key]) === undefined ? '' : `${key}=${String(count(summary[key]))}`))
        .filter((bit) => bit !== '');
    if (counts.length > 0 || hash !== undefined)
        lines[0] += '  ' + [...(hash === undefined ? [] : [`modelHash=${hash.slice(0, 12)}…`]), ...counts].join(' ');
    if (report.ran === false)
        lines.push('note: the tool did not run (the engine refused the input) — the fields below describe the refusal.');
    const coverage = record(report.narrativeCoverage);
    if (coverage !== undefined) {
        const parts = Object.entries(coverage)
            .filter(([, value]) => count(value) !== undefined)
            .map(([key, value]) => `${key} ${String(count(value))}`);
        if (parts.length > 0)
            lines.push(`NARRATIVE  ${parts.join(' / ')} documented`);
    }
    void options;
    return lines;
}
/** Trailing lines: notes about what was not checked, then the next steps. */
function footerLines(report) {
    const lines = [];
    const notes = array(report.coverageNotes).map(String).filter((note) => note !== '');
    if (notes.length > 0)
        lines.push(`COVERAGE  ${notes.join(' ')}`);
    const steps = array(report.nextSteps).map(String).filter((step) => step !== '');
    for (const step of steps)
        lines.push(`NEXT  ${step}`);
    const comparison = record(report.comparison);
    if (comparison !== undefined) {
        const parts = Object.entries(comparison)
            .filter(([, value]) => count(value) !== undefined || typeof value === 'string')
            .map(([key, value]) => `${key}=${String(value)}`);
        if (parts.length > 0)
            lines.push(`COMPARISON  ${parts.join(' ')}`);
    }
    return lines;
}
/** A `checks[]` report (verify, compose, datamodel): silence pass, expand the rest. */
function renderChecksReport(report, options) {
    const checks = array(report.checks).map((value) => record(value) ?? {});
    const byStatus = (status) => checks.filter((check) => text(check.status) === status).map((check) => text(check.id) ?? '?');
    const inventory = [
        ['pass', byStatus('pass')],
        ['fail', byStatus('fail')],
        ['skip', byStatus('skip')],
    ]
        .filter(([, ids]) => ids.length > 0)
        .map(([status, ids]) => `${String(status)} ${ids.join(' ')}`)
        .join(' | ');
    const lines = [...headerLines(report, options), `CHECKS  ${inventory}`];
    const seenFacts = new Set();
    for (const check of checks) {
        const status = text(check.status) ?? 'skip';
        const findings = array(check.findings).map((finding) => toViewFinding(finding, text(check.id)));
        if (status === 'pass' && !options.includePassing)
            continue;
        const body = findingLines(findings, options, seenFacts);
        if (status !== 'fail' && body.length === 0)
            continue;
        lines.push('');
        lines.push(`${status.toUpperCase()} ${text(check.id) ?? '?'} ${text(check.name) ?? ''} — ${text(check.detail) ?? ''} (${String(findings.length)} finding(s))`.replace(/ +— +$/, ''));
        lines.push(...body);
    }
    return [...lines, ...wrapFooter(report)];
}
/** A flat `findings[]` report (uml review, structure, granularity, concurrency). */
function renderFindingsReport(report, options) {
    const findings = array(report.findings).map((finding) => toViewFinding(finding));
    const errors = findings.filter((finding) => finding.severity === 'error').length;
    const warnings = findings.length - errors;
    const byCode = new Map();
    for (const finding of findings)
        byCode.set(finding.code, (byCode.get(finding.code) ?? 0) + 1);
    const lines = [
        ...headerLines(report, options),
        `FINDINGS  ${String(findings.length)} total (${String(errors)} error, ${String(warnings)} warning): ${[...byCode].map(([code, n]) => `${code} x${String(n)}`).join(' | ')}`,
    ];
    const body = findingLines(findings, options, new Set());
    if (body.length > 0)
        lines.push('', ...body);
    return [...lines, ...wrapFooter(report)];
}
/** A baseline diff report: what a change added, removed or changed. */
function renderDeltaReport(report, options) {
    const lines = headerLines(report, options);
    const delta = record(report.delta) ?? report;
    const section = (key) => array(delta[key]).map((finding) => toViewFinding(finding));
    for (const key of ['added', 'removed', 'changed']) {
        const findings = section(key);
        if (findings.length === 0)
            continue;
        lines.push('', `${key.toUpperCase()} (${String(findings.length)})`);
        lines.push(...findingLines(findings, options, new Set()));
    }
    const current = text(report.currentVerdict) ?? text(record(report.current)?.verdict);
    if (current !== undefined)
        lines.push(`CURRENT  verdict=${current}`);
    return [...lines, ...wrapFooter(report)];
}
/** A payload result (a rendered diagram, an exported file): print the payload, not JSON of it. */
function renderPayloadReport(report, options) {
    const lines = headerLines(report, options);
    const primary = text(report.diagram) ?? text(report.primary);
    if (primary !== undefined)
        lines.push('', primary.trimEnd());
    const extras = record(report.extras);
    for (const [name, content] of Object.entries(extras ?? {})) {
        const body = text(content);
        if (body !== undefined)
            lines.push('', `--- ${name} ---`, body.trimEnd());
    }
    const warnings = array(report.warnings).map(String).filter((warning) => warning !== '');
    for (const warning of warnings)
        lines.push(`WARNING  ${warning}`);
    return [...lines, ...wrapFooter(report)];
}
function wrapFooter(report) {
    const footer = footerLines(report);
    return footer.length === 0 ? [] : ['', ...footer];
}
/**
 * A refusal, or a shape this module does not recognize: state the reason first, then the
 * remaining fields compactly so nothing is lost, without paying for indentation.
 */
function renderFallbackReport(report, options) {
    const lines = headerLines(report, options);
    const message = text(report.error);
    if (message !== undefined) {
        const code = text(report.errorCode);
        lines.push(`ERROR  ${message}${code === undefined ? '' : ` [${code}]`}`);
    }
    const rest = { ...report };
    delete rest.error;
    delete rest.errorCode;
    lines.push('', JSON.stringify(rest));
    return [...lines, ...wrapFooter(report)];
}
/**
 * Render any logicprobe result as the text a model reads.
 *
 * Order of recognition: a `checks[]` report, a flat `findings[]` report, a baseline delta,
 * a payload result (`diagram`/`primary`), and finally compact JSON so an unrecognized shape
 * is still readable rather than silently empty.
 */
export function renderReportText(value, options = {}) {
    const resolved = { ...DEFAULTS, ...options };
    if (resolved.full)
        return JSON.stringify(value, null, 2);
    const report = record(value);
    if (report === undefined)
        return JSON.stringify(value) ?? String(value);
    const hasChecks = array(report.checks).some((check) => record(check) !== undefined);
    const hasFindings = array(report.findings).length > 0;
    const isDelta = array(report.added).length + array(report.removed).length + array(report.changed).length > 0;
    const isPayload = typeof report.diagram === 'string' || typeof report.primary === 'string';
    const lines = hasChecks
        ? renderChecksReport(report, resolved)
        : isDelta
            ? renderDeltaReport(report, resolved)
            : hasFindings
                ? renderFindingsReport(report, resolved)
                : isPayload
                    ? renderPayloadReport(report, resolved)
                    : renderFallbackReport(report, resolved);
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}
