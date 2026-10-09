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
    description: 'Compare two logicprobe reports of the same family: `baseline` (earlier) against `current` (newer). Use it to accept a slice by "no new findings". Findings match on a stable identity: check id, code, and a locator built from `evidence` and `path`. Reworded prose counts as `changed`, not as new. Returns added, removed and changed findings, plus `summary`. The `verdict` is about the delta: a newly added error finding fails it. `currentVerdict` keeps the run\'s own verdict, so a clean delta over a failing report still shows as failing. Two runs over the same input add nothing.',
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
