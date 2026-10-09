import { defineTool } from '@deepseek-ai/dsh-tools';
import { diffReports } from './baseline.js';
export const LOGICPROBE_REPORT_DIFF_TOOL_NAME = 'logicprobe_report_diff';
/**
 * Model-visible DSH tool that compares two reports of the same family — the accepted
 * "violations must not increase" acceptance criterion, computed instead of eyeballed.
 * A finding's identity is its check + code + machine-readable locator, so a reworded
 * message reads as `changed`, and two runs over the same input add nothing.
 */
export const logicProbeReportDiffTool = defineTool({
    name: LOGICPROBE_REPORT_DIFF_TOOL_NAME,
    description: 'Compare two logicprobe reports of the same family (baseline vs current) and report what the change added, removed or altered (logicprobe). Use it for the "no new findings" acceptance criterion of a slice: pass the earlier report as `baseline` and the new one as `current`. Findings are matched by a stable identity — the check id + code + a canonical locator built from `evidence` and `path` (falling back to the message only when a finding carries neither) — so prose edits show up as `changed`, never as new findings. Returns {schema, verdict, verdictReason, currentVerdict, added[], removed[], changed[], summary}; the verdict describes the DELTA (a newly added error finding fails it) while `currentVerdict` keeps the absolute result visible, and a clean delta over a still-failing report says so in nextSteps. Two runs over the same input add zero findings.',
    parameters: {
        baseline: {
            type: 'json',
            required: true,
            description: 'The earlier report (any family: verify, compose, datamodel, uml review, structure, concurrency).',
        },
        current: {
            type: 'json',
            required: true,
            description: 'The current report to compare against the baseline.',
        },
    },
    output: {
        schema: {
            type: 'json',
            description: 'Baseline diff report: added/removed/changed findings, delta verdict, current verdict, summary and next steps.',
        },
        render(_args, value) {
            return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
        },
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    async execute(args) {
        return diffReports(args.baseline, args.current);
    },
});
