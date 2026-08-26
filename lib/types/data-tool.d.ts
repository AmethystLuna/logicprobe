import { DATA_ENGINE_SCHEMA_VERSION } from './data-engine.js';
export declare const LOGICPROBE_DATAMODEL_VERIFY_TOOL_NAME = "logicprobe_datamodel_verify";
/**
 * Model-visible DSH tool wrapping the bundled data-model verification engine.
 * The model passes a DataModelV1 object; the engine validates it and returns
 * DS/DA/DD checks. Optional beforeModel/fieldMapping/copyPairs/migrationMappings
 * enable before/after data-model regression and migration coverage checks.
 */
export declare const logicProbeDataModelVerifyTool: import("@deepseek-ai/dsh-tools").ToolDefinition;
export { DATA_ENGINE_SCHEMA_VERSION };
