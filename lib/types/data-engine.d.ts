import type { CheckResult } from './engine.js';
export declare const DATA_ENGINE_SCHEMA_VERSION = 1;
export type DataValue = number | string | boolean | null;
export type DataType = 'string' | 'integer' | 'number' | 'boolean' | 'uuid' | 'date' | 'datetime' | 'timestamp' | 'json' | 'enum' | 'array' | 'object' | 'binary';
export interface FieldSpec {
    name: string;
    type: DataType | string;
    required?: boolean;
    unique?: boolean;
    nullable?: boolean;
    default?: DataValue;
    min?: number;
    max?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    enum?: DataValue[];
    ref?: string;
    items?: FieldSpec;
}
export interface EntitySpec {
    name: string;
    fields: FieldSpec[];
    primaryKey?: string[];
    uniqueKeys?: string[][];
    indexes?: string[][];
}
export interface RelationshipSpec {
    name?: string;
    fromEntity: string;
    fromField: string;
    toEntity: string;
    toField?: string;
    onDelete?: 'cascade' | 'restrict' | 'set-null' | 'no-action';
}
export type DataInvariantSpec = {
    id: string;
    description: string;
    kind: 'field-required';
    entity: string;
    field: string;
} | {
    id: string;
    description: string;
    kind: 'unique';
    entity: string;
    fields: string[];
} | {
    id: string;
    description: string;
    kind: 'referential-integrity';
    entity: string;
    field: string;
    refEntity: string;
    refField?: string;
} | {
    id: string;
    description: string;
    kind: 'range';
    entity: string;
    field: string;
    min?: number;
    max?: number;
} | {
    id: string;
    description: string;
    kind: 'count-equal';
    sourceEntity: string;
    targetEntity: string;
} | {
    id: string;
    description: string;
    kind: 'field-equal';
    sourceEntity: string;
    sourceField: string;
    targetEntity: string;
    targetField: string;
} | {
    id: string;
    description: string;
    kind: 'no-orphan';
    entity: string;
    field: string;
    refEntity: string;
} | {
    id: string;
    description: string;
    kind: 'idempotent-copy';
    sourceEntity: string;
    targetEntity: string;
} | {
    id: string;
    description: string;
    kind: 'idempotent-migration';
    from: string;
    to: string;
};
export interface DataModelV1 {
    schemaVersion: 1;
    entities: EntitySpec[];
    relationships?: RelationshipSpec[];
    invariants?: DataInvariantSpec[];
    boundaryChecks?: Array<{
        entity: string;
        field: string;
        values?: DataValue[];
    }>;
}
export interface CopyPairSpec {
    id: string;
    sourceEntity: string;
    targetEntity: string;
    mapping: Record<string, string>;
}
export interface BackupPairSpec {
    id: string;
    sourceEntity: string;
    targetEntity: string;
    mapping: Record<string, string>;
}
export interface MigrationMappingSpec {
    from: string;
    to: string;
    transform?: 'copy' | 'rename' | 'split' | 'merge' | 'drop' | 'manual';
    note?: string;
}
export interface DataVerificationOptions {
    beforeModel?: unknown;
    fieldMapping?: Record<string, string>;
    copyPairs?: CopyPairSpec[];
    migrationMappings?: MigrationMappingSpec[];
    backupPairs?: BackupPairSpec[];
}
export interface DataComparisonSummary {
    beforeModelHash: string;
    afterModelHash: string;
    fieldMapping: Record<string, string>;
    beforeEntities: number;
    beforeFields: number;
    afterEntities: number;
    afterFields: number;
    addedEntities: string[];
    removedEntities: string[];
    addedFields: string[];
    removedFields: string[];
    addedRelationships: string[];
    removedRelationships: string[];
}
export interface DataVerificationReport {
    ok: boolean;
    schemaVersion: 1;
    modelHash: string;
    summary: {
        entities: number;
        fields: number;
        errors: number;
        warnings: number;
        checksRun: number;
        truncated?: boolean;
    };
    checks: CheckResult[];
    comparison?: DataComparisonSummary;
}
export declare function dataModelHash(model: DataModelV1): string;
export declare function validateDataModel(input: unknown): {
    ok: true;
    model: DataModelV1;
} | {
    ok: false;
    errors: string[];
};
export declare function runDataVerification(input: unknown, options?: DataVerificationOptions): DataVerificationReport;
