export declare const LOGICPROBE_UML_TOOL_NAME = "logicprobe_uml";
/**
 * DSH tool wrapping the UML front end: model a code flow as a UML diagram
 * (`action: "render"`), read a UML diagram back into a LogicModelV1
 * (`action: "parse"`), or review the modelling itself (`action: "review"`).
 *
 * review is the half that makes the feature a check rather than a drawing
 * utility: it reports structural defects the diagram would present as valid
 * flow (unreachable states, dead ends, ambiguous and non-exhaustive branches,
 * self-loops with no exit), documentation gaps (a symbol no reader can map back
 * to code), and — the fidelity check — whether the rendered diagram reads back
 * as the model it was drawn from.
 */
export declare const logicProbeUmlTool: import("@deepseek-ai/dsh-tools").ToolDefinition;
