export declare const LOGICPROBE_CONCURRENCY_SCAN_TOOL_NAME = "logicprobe_concurrency_scan";
/**
 * Model-visible DSH tool that mines design documents/plans for concurrency-related
 * claims and risk keywords. It does not prove concurrency safety; it flags terms
 * such as "thread-safe", "lock-free", "race condition", "atomic", "mutex", etc.,
 * so the model can either provide dedicated evidence or mark the claim unverified.
 */
export declare const logicProbeConcurrencyScanTool: import("@deepseek-ai/dsh-tools").ToolDefinition;
