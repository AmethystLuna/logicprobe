export declare const LOGICPROBE_VERIFY_TOOL_NAME = "logicprobe_verify";
/**
 * Model-visible DSH tool wrapping the bundled TypeScript verification engine.
 * The model passes a LogicModelV1 object; the engine validates it and returns
 * the 22-check report (S1-S8 structural, A1-A14), or a 26-check
 * report when beforeModel is supplied (D1 behavioral preservation, D2
 * invariant continuity, D3 regression delta, D4 deadlock/liveness regression).
 * This is the dsh-native path: the model is built and run here, with no
 * template to fill in by hand.
 */
export declare const logicProbeVerifyTool: import("@deepseek-ai/dsh-tools").ToolDefinition;
