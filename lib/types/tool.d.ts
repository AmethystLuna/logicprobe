export declare const LOGICPROBE_VERIFY_TOOL_NAME = "logicprobe_verify";
/**
 * Model-visible DSH tool wrapping the bundled TypeScript verification engine.
 * The model passes a LogicModelV1 object; the engine validates it and returns
 * the 14-check report. This is the dsh-native replacement for hand-filling the
 * Python template shipped in the skill references.
 */
export declare const logicProbeVerifyTool: import("@deepseek-ai/dsh-tools").ToolDefinition;
