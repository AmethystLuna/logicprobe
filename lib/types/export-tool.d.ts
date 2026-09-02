export declare const LOGICPROBE_EXPORT_TOOL_NAME = "logicprobe_export";
/**
 * DSH tool wrapping the external-tool exporters: turn a LogicModelV1 machine into
 * native input for the tool logicprobe routes to (UPPAAL / TLA+ / PRISM / SPIN).
 * v1 translates the core machine; unrepresentable invariants become warnings.
 */
export declare const logicProbeExportTool: import("@deepseek-ai/dsh-tools").ToolDefinition;
