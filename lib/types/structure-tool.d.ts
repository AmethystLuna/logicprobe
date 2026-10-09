export declare const LOGICPROBE_STRUCTURE_TOOL_NAME = "logicprobe_structure_verify";
/**
 * Model-visible DSH tool that audits a *structure* diagram — components, packages,
 * classes, deployment nodes and the dependency arrows between them — against an
 * optional dependency matrix. A structure diagram is not a state machine: this tool
 * reads the graph the diagram actually draws, instead of refusing it (which is what
 * `logicprobe_uml action=parse` does) or pretending the arrows are state transitions
 * (which is what a false `ok` used to hide).
 */
export declare const logicProbeStructureTool: import("@deepseek-ai/dsh-tools").ToolDefinition;
