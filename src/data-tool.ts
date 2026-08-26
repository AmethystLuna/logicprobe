import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import { runDataVerification, DATA_ENGINE_SCHEMA_VERSION } from './data-engine.js'

export const LOGICPROBE_DATAMODEL_VERIFY_TOOL_NAME = 'logicprobe_datamodel_verify'

/**
 * Model-visible DSH tool wrapping the bundled data-model verification engine.
 * The model passes a DataModelV1 object; the engine validates it and returns
 * DS/DA/DD checks. Optional beforeModel/fieldMapping/copyPairs/migrationMappings
 * enable before/after data-model regression and migration coverage checks.
 */
export const logicProbeDataModelVerifyTool = defineTool({
  name: LOGICPROBE_DATAMODEL_VERIFY_TOOL_NAME,
  description:
    'Run executable data-model verification (logicprobe-datamodel). Takes a DataModelV1 object with schemaVersion=1, entities ({name, fields, primaryKey?, uniqueKeys?, indexes?}), relationships?, invariants?, boundaryChecks?. Optional beforeModel/fieldMapping/copyPairs/migrationMappings/backupPairs enable migration coverage, copy consistency, rollback symmetry, and before/after data regression (DD1-DD4). Returns a report with DS/DA/DD checks. See skills/logicprobe-datamodel/references/data-model-schema.md.',
  parameters: {
    model: {
      type: 'json',
      required: true,
      description: 'DataModelV1 data model to verify.',
    },
    beforeModel: {
      type: 'json',
      description: 'Optional BEFORE DataModelV1 data model for regression comparison.',
    },
    fieldMapping: {
      type: 'json',
      description: 'Optional object mapping BEFORE "Entity.field" paths to AFTER "Entity.field" paths.',
    },
    copyPairs: {
      type: 'json',
      description: 'Optional copy pairs: { id, sourceEntity, targetEntity, mapping: {sourceField: targetField} }.',
    },
    migrationMappings: {
      type: 'json',
      description: 'Optional migration mappings: { from: "Entity.field", to: "Entity.field", transform?, note? }.',
    },
    backupPairs: {
      type: 'json',
      description: 'Optional backup/restore pairs for DA7 rollback symmetry.',
    },
  },
  output: {
    schema: {
      type: 'json',
      description: 'logicprobe-datamodel verification report with summary and per-check findings.',
    },
    render(_args, value) {
      return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
    },
  },
  timeoutMs: 10_000,
  isConcurrencySafe: () => true,
  async execute(args) {
    return runDataVerification(args.model, {
      beforeModel: args.beforeModel,
      fieldMapping: args.fieldMapping as Record<string, string> | undefined,
      copyPairs: args.copyPairs as Array<{ id: string; sourceEntity: string; targetEntity: string; mapping: Record<string, string> }> | undefined,
      migrationMappings: args.migrationMappings as Array<{ from: string; to: string; transform?: 'copy' | 'rename' | 'split' | 'merge' | 'drop' | 'manual'; note?: string }> | undefined,
      backupPairs: args.backupPairs as Array<{ id: string; sourceEntity: string; targetEntity: string; mapping: Record<string, string> }> | undefined,
    }) as unknown as JsonValue
  },
})

export { DATA_ENGINE_SCHEMA_VERSION }
