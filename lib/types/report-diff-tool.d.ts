export declare const LOGICPROBE_REPORT_DIFF_TOOL_NAME = "logicprobe_report_diff";
/**
 * Model-visible DSH tool that compares two reports of the same family — the accepted
 * "violations must not increase" acceptance criterion, computed instead of eyeballed.
 * A finding's identity is its check + code + machine-readable locator, so a reworded
 * message reads as `changed`, and two runs over the same input add nothing.
 */
export declare const logicProbeReportDiffTool: import("@deepseek-ai/dsh-tools").ToolDefinition;
