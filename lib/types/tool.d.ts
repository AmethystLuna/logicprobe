export declare const LOGICPROBE_VERIFY_TOOL_NAME = "logicprobe_verify";
/**
 * Model-visible DSH tool wrapping the bundled TypeScript verification engine.
 * The model passes a LogicModelV1 object; the engine validates it and returns
 * the 14-check report, or an 18-check report when beforeModel is supplied
 * (D1 behavioral preservation, D2 invariant continuity, D3 regression delta,
 * D4 deadlock/liveness regression). This is the dsh-native replacement for
 * hand-filling the Python template shipped in the skill references.
 */
export declare const logicProbeVerifyTool: import("@deepseek-ai/dsh-tools").ToolDefinition;
