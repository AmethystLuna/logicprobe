import { createHash } from 'node:crypto';
export const DATA_ENGINE_SCHEMA_VERSION = 1;
const KNOWN_TYPES = new Set([
    'string', 'integer', 'number', 'boolean', 'uuid', 'date', 'datetime', 'timestamp',
    'json', 'enum', 'array', 'object', 'binary',
]);
function stableStringify(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
    const record = value;
    return '{' + Object.keys(record).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(record[key])).join(',') + '}';
}
export function dataModelHash(model) {
    return createHash('sha256').update(stableStringify(model)).digest('hex');
}
function bad(errors, path, message) {
    errors.push(path + ': ' + message);
}
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validateField(input, path, errors, fieldNames) {
    if (!isPlainObject(input)) {
        bad(errors, path, 'must be an object');
        return undefined;
    }
    if (typeof input.name !== 'string' || input.name.length === 0) {
        bad(errors, path + '.name', 'must be a non-empty string');
    }
    else if (fieldNames.has(input.name)) {
        bad(errors, path + '.name', 'duplicate field name ' + input.name);
    }
    else {
        fieldNames.add(input.name);
    }
    if (typeof input.type !== 'string' || input.type.length === 0) {
        bad(errors, path + '.type', 'must be a non-empty string');
    }
    if (input.required !== undefined && typeof input.required !== 'boolean')
        bad(errors, path + '.required', 'must be a boolean');
    if (input.unique !== undefined && typeof input.unique !== 'boolean')
        bad(errors, path + '.unique', 'must be a boolean');
    if (input.nullable !== undefined && typeof input.nullable !== 'boolean')
        bad(errors, path + '.nullable', 'must be a boolean');
    if (input.min !== undefined && typeof input.min !== 'number')
        bad(errors, path + '.min', 'must be a number');
    if (input.max !== undefined && typeof input.max !== 'number')
        bad(errors, path + '.max', 'must be a number');
    if (input.minLength !== undefined && typeof input.minLength !== 'number')
        bad(errors, path + '.minLength', 'must be a number');
    if (input.maxLength !== undefined && typeof input.maxLength !== 'number')
        bad(errors, path + '.maxLength', 'must be a number');
    if (input.pattern !== undefined && typeof input.pattern !== 'string')
        bad(errors, path + '.pattern', 'must be a string');
    if (input.ref !== undefined && typeof input.ref !== 'string')
        bad(errors, path + '.ref', 'must be a string');
    if (input.enum !== undefined && !Array.isArray(input.enum))
        bad(errors, path + '.enum', 'must be an array');
    if (input.items !== undefined)
        validateField(input.items, path + '.items', errors, new Set());
    return input;
}
function entityByName(model, name) {
    return model.entities.find((entity) => entity.name === name);
}
function fieldByPath(model, entityName, fieldName) {
    return entityByName(model, entityName)?.fields.find((field) => field.name === fieldName);
}
function mapFieldPath(mapping, path) {
    return mapping[path] ?? path;
}
export function validateDataModel(input) {
    const errors = [];
    if (!isPlainObject(input)) {
        return { ok: false, errors: ['model: must be an object'] };
    }
    const root = input;
    if (root.schemaVersion !== 1)
        bad(errors, 'schemaVersion', 'must be 1');
    if (!Array.isArray(root.entities) || root.entities.length === 0) {
        bad(errors, 'entities', 'must be a non-empty array');
    }
    else {
        const entityNames = new Set();
        root.entities.forEach((entry, index) => {
            const path = 'entities[' + index + ']';
            if (!isPlainObject(entry)) {
                bad(errors, path, 'must be an object');
                return;
            }
            if (typeof entry.name !== 'string' || entry.name.length === 0) {
                bad(errors, path + '.name', 'must be a non-empty string');
            }
            else if (entityNames.has(entry.name)) {
                bad(errors, path + '.name', 'duplicate entity name ' + entry.name);
            }
            else {
                entityNames.add(entry.name);
            }
            if (!Array.isArray(entry.fields) || entry.fields.length === 0) {
                bad(errors, path + '.fields', 'must be a non-empty array');
            }
            else {
                const fieldNames = new Set();
                entry.fields.forEach((field, fieldIndex) => {
                    validateField(field, path + '.fields[' + fieldIndex + ']', errors, fieldNames);
                });
            }
            if (entry.primaryKey !== undefined) {
                if (!Array.isArray(entry.primaryKey))
                    bad(errors, path + '.primaryKey', 'must be an array');
            }
            if (entry.uniqueKeys !== undefined) {
                if (!Array.isArray(entry.uniqueKeys))
                    bad(errors, path + '.uniqueKeys', 'must be an array');
            }
            if (entry.indexes !== undefined) {
                if (!Array.isArray(entry.indexes))
                    bad(errors, path + '.indexes', 'must be an array');
            }
        });
    }
    if (root.relationships !== undefined) {
        if (!Array.isArray(root.relationships))
            bad(errors, 'relationships', 'must be an array');
    }
    if (root.invariants !== undefined) {
        if (!Array.isArray(root.invariants))
            bad(errors, 'invariants', 'must be an array');
        else
            root.invariants.forEach((entry, index) => {
                const path = 'invariants[' + index + ']';
                if (!isPlainObject(entry)) {
                    bad(errors, path, 'must be an object');
                    return;
                }
                if (typeof entry.id !== 'string' || entry.id.length === 0)
                    bad(errors, path + '.id', 'must be a non-empty string');
                if (typeof entry.description !== 'string')
                    bad(errors, path + '.description', 'must be a string');
                const kind = entry.kind;
                if (kind === 'field-required' || kind === 'no-orphan') {
                    if (typeof entry.entity !== 'string')
                        bad(errors, path + '.entity', 'must be a string');
                    if (typeof entry.field !== 'string')
                        bad(errors, path + '.field', 'must be a string');
                }
                else if (kind === 'unique') {
                    if (!Array.isArray(entry.fields))
                        bad(errors, path + '.fields', 'must be an array');
                }
                else if (kind === 'referential-integrity') {
                    if (typeof entry.entity !== 'string')
                        bad(errors, path + '.entity', 'must be a string');
                    if (typeof entry.field !== 'string')
                        bad(errors, path + '.field', 'must be a string');
                    if (typeof entry.refEntity !== 'string')
                        bad(errors, path + '.refEntity', 'must be a string');
                    if (entry.refField !== undefined && typeof entry.refField !== 'string')
                        bad(errors, path + '.refField', 'must be a string');
                }
                else if (kind === 'range') {
                    if (typeof entry.entity !== 'string')
                        bad(errors, path + '.entity', 'must be a string');
                    if (typeof entry.field !== 'string')
                        bad(errors, path + '.field', 'must be a string');
                    if (entry.min !== undefined && typeof entry.min !== 'number')
                        bad(errors, path + '.min', 'must be a number');
                    if (entry.max !== undefined && typeof entry.max !== 'number')
                        bad(errors, path + '.max', 'must be a number');
                }
                else if (kind === 'count-equal') {
                    if (typeof entry.sourceEntity !== 'string')
                        bad(errors, path + '.sourceEntity', 'must be a string');
                    if (typeof entry.targetEntity !== 'string')
                        bad(errors, path + '.targetEntity', 'must be a string');
                }
                else if (kind === 'field-equal') {
                    if (typeof entry.sourceEntity !== 'string')
                        bad(errors, path + '.sourceEntity', 'must be a string');
                    if (typeof entry.sourceField !== 'string')
                        bad(errors, path + '.sourceField', 'must be a string');
                    if (typeof entry.targetEntity !== 'string')
                        bad(errors, path + '.targetEntity', 'must be a string');
                    if (typeof entry.targetField !== 'string')
                        bad(errors, path + '.targetField', 'must be a string');
                }
                else if (kind === 'idempotent-copy') {
                    if (typeof entry.sourceEntity !== 'string')
                        bad(errors, path + '.sourceEntity', 'must be a string');
                    if (typeof entry.targetEntity !== 'string')
                        bad(errors, path + '.targetEntity', 'must be a string');
                }
                else if (kind === 'idempotent-migration') {
                    if (typeof entry.from !== 'string')
                        bad(errors, path + '.from', 'must be a string');
                    if (typeof entry.to !== 'string')
                        bad(errors, path + '.to', 'must be a string');
                }
                else {
                    bad(errors, path + '.kind', 'unknown invariant kind');
                }
            });
    }
    if (root.boundaryChecks !== undefined) {
        if (!Array.isArray(root.boundaryChecks))
            bad(errors, 'boundaryChecks', 'must be an array');
    }
    if (errors.length > 0)
        return { ok: false, errors };
    return { ok: true, model: root };
}
function checkResult(id, name, findings, detail) {
    const errors = findings.filter((finding) => finding.severity === 'error').length;
    const warnings = findings.filter((finding) => finding.severity === 'warning').length;
    return {
        id,
        name,
        status: findings.length === 0 ? 'pass' : 'fail',
        detail: detail + (errors > 0 ? ' (' + errors + ' errors' + (warnings > 0 ? ', ' + warnings + ' warnings' : '') + ')' : warnings > 0 ? ' (' + warnings + ' warnings)' : ''),
        findings,
    };
}
function allFieldPaths(model) {
    const result = [];
    for (const entity of model.entities) {
        for (const field of entity.fields)
            result.push(entity.name + '.' + field.name);
    }
    return result;
}
function entityFieldMap(model) {
    const map = new Map();
    for (const entity of model.entities) {
        for (const field of entity.fields)
            map.set(entity.name + '.' + field.name, field);
    }
    return map;
}
function DS1_schemaWellFormed(model) {
    const findings = [];
    const entityNames = new Set();
    for (const entity of model.entities) {
        if (entityNames.has(entity.name)) {
            findings.push({ code: 'DS1_DUPLICATE_ENTITY', severity: 'error', message: 'Duplicate entity name ' + entity.name, evidence: { entity: entity.name } });
        }
        entityNames.add(entity.name);
        const fieldNames = new Set();
        for (const field of entity.fields) {
            if (fieldNames.has(field.name)) {
                findings.push({ code: 'DS1_DUPLICATE_FIELD', severity: 'error', message: 'Duplicate field ' + entity.name + '.' + field.name, evidence: { entity: entity.name, field: field.name } });
            }
            fieldNames.add(field.name);
            if (field.type !== undefined && !KNOWN_TYPES.has(field.type) && field.type.trim().length === 0) {
                findings.push({ code: 'DS1_EMPTY_TYPE', severity: 'error', message: 'Field ' + entity.name + '.' + field.name + ' has empty type', evidence: { entity: entity.name, field: field.name } });
            }
        }
        for (const key of entity.primaryKey ?? []) {
            if (!fieldNames.has(key))
                findings.push({ code: 'DS1_PRIMARY_KEY_MISSING', severity: 'error', message: 'Primary key field ' + key + ' does not exist in entity ' + entity.name, evidence: { entity: entity.name, field: key } });
        }
        for (const keySet of entity.uniqueKeys ?? []) {
            for (const key of keySet) {
                if (!fieldNames.has(key))
                    findings.push({ code: 'DS1_UNIQUE_KEY_MISSING', severity: 'error', message: 'Unique key field ' + key + ' does not exist in entity ' + entity.name, evidence: { entity: entity.name, field: key } });
            }
        }
        for (const keySet of entity.indexes ?? []) {
            for (const key of keySet) {
                if (!fieldNames.has(key))
                    findings.push({ code: 'DS1_INDEX_MISSING', severity: 'error', message: 'Index field ' + key + ' does not exist in entity ' + entity.name, evidence: { entity: entity.name, field: key } });
            }
        }
    }
    return checkResult('DS1', 'Schema Well-Formedness', findings, findings.length === 0 ? 'Schema is well-formed' : 'Schema findings: ' + findings.length);
}
function DS2_requiredCompleteness(model, options) {
    const findings = [];
    const afterFields = entityFieldMap(model);
    const migrationFrom = new Set((options.migrationMappings ?? []).map((mapping) => mapping.from));
    const copyTargets = new Set();
    for (const pair of options.copyPairs ?? []) {
        for (const target of Object.values(pair.mapping))
            copyTargets.add(pair.targetEntity + '.' + target);
    }
    const beforePaths = new Set();
    if (options.beforeModel !== undefined) {
        const beforeValidation = validateDataModel(options.beforeModel);
        if (beforeValidation.ok) {
            const mapping = options.fieldMapping ?? {};
            for (const path of allFieldPaths(beforeValidation.model))
                beforePaths.add(mapFieldPath(mapping, path));
        }
    }
    for (const entity of model.entities) {
        for (const field of entity.fields) {
            if (field.required !== true)
                continue;
            if ((entity.primaryKey ?? []).includes(field.name) && field.nullable === true) {
                findings.push({ code: 'DS2_NULLABLE_PRIMARY_KEY', severity: 'error', message: 'Primary key field ' + entity.name + '.' + field.name + ' must not be nullable', evidence: { entity: entity.name, field: field.name } });
            }
            if (options.beforeModel !== undefined) {
                const path = entity.name + '.' + field.name;
                if (!beforePaths.has(path) && !migrationFrom.has(path) && !copyTargets.has(path)) {
                    findings.push({ code: 'DS2_REQUIRED_FIELD_UNSOURCED', severity: 'warning', message: 'Required field ' + path + ' has no explicit migration mapping or copy target in a before/after migration', evidence: { entity: entity.name, field: field.name } });
                }
            }
        }
    }
    return checkResult('DS2', 'Required-Field Completeness', findings, findings.length === 0 ? 'Required fields are complete' : 'Required-field findings: ' + findings.length);
}
function DS3_relationshipIntegrity(model) {
    const findings = [];
    for (const relationship of model.relationships ?? []) {
        const fromEntity = entityByName(model, relationship.fromEntity);
        const toEntity = entityByName(model, relationship.toEntity);
        if (fromEntity === undefined) {
            findings.push({ code: 'DS3_FROM_ENTITY_MISSING', severity: 'error', message: 'Relationship references unknown fromEntity ' + relationship.fromEntity, evidence: { relationship } });
            continue;
        }
        if (toEntity === undefined) {
            findings.push({ code: 'DS3_TO_ENTITY_MISSING', severity: 'error', message: 'Relationship references unknown toEntity ' + relationship.toEntity, evidence: { relationship } });
            continue;
        }
        if (!fromEntity.fields.some((field) => field.name === relationship.fromField)) {
            findings.push({ code: 'DS3_FROM_FIELD_MISSING', severity: 'error', message: 'Relationship field ' + relationship.fromField + ' does not exist in ' + relationship.fromEntity, evidence: { relationship } });
        }
        if (relationship.toField !== undefined && !toEntity.fields.some((field) => field.name === relationship.toField)) {
            findings.push({ code: 'DS3_TO_FIELD_MISSING', severity: 'error', message: 'Relationship target field ' + relationship.toField + ' does not exist in ' + relationship.toEntity, evidence: { relationship } });
        }
        if (relationship.onDelete !== undefined && !['cascade', 'restrict', 'set-null', 'no-action'].includes(relationship.onDelete)) {
            findings.push({ code: 'DS3_INVALID_ON_DELETE', severity: 'error', message: 'Invalid onDelete value ' + relationship.onDelete, evidence: { relationship } });
        }
    }
    return checkResult('DS3', 'Relationship Integrity', findings, findings.length === 0 ? 'Relationships are valid' : 'Relationship findings: ' + findings.length);
}
function DS4_typeNullabilityConsistency(model) {
    const findings = [];
    for (const entity of model.entities) {
        for (const field of entity.fields) {
            if (field.required === true && field.nullable === true) {
                findings.push({ code: 'DS4_REQUIRED_NULLABLE', severity: 'error', message: 'Field ' + entity.name + '.' + field.name + ' is both required and nullable', evidence: { entity: entity.name, field: field.name } });
            }
            if (field.unique === true && field.nullable === true) {
                findings.push({ code: 'DS4_UNIQUE_NULLABLE', severity: 'warning', message: 'Unique field ' + entity.name + '.' + field.name + ' is nullable; uniqueness over NULL may be ambiguous', evidence: { entity: entity.name, field: field.name } });
            }
            if (typeof field.min === 'number' && typeof field.max === 'number' && field.min > field.max) {
                findings.push({ code: 'DS4_MIN_GT_MAX', severity: 'error', message: 'Field ' + entity.name + '.' + field.name + ' has min > max', evidence: { entity: entity.name, field: field.name, min: field.min, max: field.max } });
            }
            if (typeof field.minLength === 'number' && typeof field.maxLength === 'number' && field.minLength > field.maxLength) {
                findings.push({ code: 'DS4_MIN_LENGTH_GT_MAX_LENGTH', severity: 'error', message: 'Field ' + entity.name + '.' + field.name + ' has minLength > maxLength', evidence: { entity: entity.name, field: field.name } });
            }
            if (field.default === null && field.required === true) {
                findings.push({ code: 'DS4_REQUIRED_NULL_DEFAULT', severity: 'warning', message: 'Required field ' + entity.name + '.' + field.name + ' has default null', evidence: { entity: entity.name, field: field.name } });
            }
        }
    }
    return checkResult('DS4', 'Type/Nullability Consistency', findings, findings.length === 0 ? 'Types and nullability are consistent' : 'Type/nullability findings: ' + findings.length);
}
function DA1_nullEmptyInjection(model) {
    const findings = [];
    for (const entity of model.entities) {
        for (const field of entity.fields) {
            if (field.required === true && field.nullable === true) {
                findings.push({ code: 'DA1_NULL_ACCEPTED_ON_REQUIRED', severity: 'error', message: 'Null can be injected into required field ' + entity.name + '.' + field.name, evidence: { entity: entity.name, field: field.name } });
            }
            if (field.required === true && field.type === 'string' && field.minLength !== undefined && field.minLength === 0) {
                findings.push({ code: 'DA1_EMPTY_STRING_ALLOWED', severity: 'warning', message: 'Required string field ' + entity.name + '.' + field.name + ' allows empty string', evidence: { entity: entity.name, field: field.name } });
            }
        }
    }
    return checkResult('DA1', 'Null/Empty Injection', findings, findings.length === 0 ? 'Null/empty injection is rejected' : 'Null/empty findings: ' + findings.length);
}
function DA2_boundaryBlast(model) {
    const findings = [];
    for (const entity of model.entities) {
        for (const field of entity.fields) {
            if (typeof field.min === 'number' && typeof field.max === 'number' && field.min > field.max)
                continue;
            if (typeof field.default === 'number') {
                if (field.min !== undefined && field.default < field.min)
                    findings.push({ code: 'DA2_DEFAULT_BELOW_MIN', severity: 'error', message: 'Default ' + field.default + ' is below min ' + field.min + ' for ' + entity.name + '.' + field.name, evidence: { entity: entity.name, field: field.name } });
                if (field.max !== undefined && field.default > field.max)
                    findings.push({ code: 'DA2_DEFAULT_ABOVE_MAX', severity: 'error', message: 'Default ' + field.default + ' is above max ' + field.max + ' for ' + entity.name + '.' + field.name, evidence: { entity: entity.name, field: field.name } });
            }
            if (field.enum !== undefined && field.enum.length > 0) {
                if (typeof field.min === 'number') {
                    for (const value of field.enum) {
                        if (typeof value === 'number' && value < field.min)
                            findings.push({ code: 'DA2_ENUM_BELOW_MIN', severity: 'warning', message: 'Enum value ' + value + ' is below min ' + field.min + ' for ' + entity.name + '.' + field.name, evidence: { entity: entity.name, field: field.name, value } });
                    }
                }
                if (typeof field.max === 'number') {
                    for (const value of field.enum) {
                        if (typeof value === 'number' && value > field.max)
                            findings.push({ code: 'DA2_ENUM_ABOVE_MAX', severity: 'warning', message: 'Enum value ' + value + ' is above max ' + field.max + ' for ' + entity.name + '.' + field.name, evidence: { entity: entity.name, field: field.name, value } });
                    }
                }
            }
        }
    }
    for (const check of model.boundaryChecks ?? []) {
        const field = fieldByPath(model, check.entity, check.field);
        if (field === undefined) {
            findings.push({ code: 'DA2_BOUNDARY_FIELD_MISSING', severity: 'error', message: 'Boundary check references unknown field ' + check.entity + '.' + check.field, evidence: { entity: check.entity, field: check.field } });
            continue;
        }
        for (const value of check.values ?? []) {
            if (typeof value === 'number') {
                if (field.min !== undefined && value < field.min)
                    findings.push({ code: 'DA2_BOUNDARY_BELOW_MIN', severity: 'warning', message: 'Boundary value ' + value + ' below min ' + field.min + ' for ' + check.entity + '.' + check.field, evidence: { entity: check.entity, field: check.field, value } });
                if (field.max !== undefined && value > field.max)
                    findings.push({ code: 'DA2_BOUNDARY_ABOVE_MAX', severity: 'warning', message: 'Boundary value ' + value + ' above max ' + field.max + ' for ' + check.entity + '.' + check.field, evidence: { entity: check.entity, field: check.field, value } });
            }
            if (field.enum !== undefined && field.enum.length > 0 && !field.enum.includes(value)) {
                findings.push({ code: 'DA2_BOUNDARY_NOT_IN_ENUM', severity: 'warning', message: 'Boundary value ' + String(value) + ' not in enum for ' + check.entity + '.' + check.field, evidence: { entity: check.entity, field: check.field, value } });
            }
        }
    }
    return checkResult('DA2', 'Boundary Blast', findings, findings.length === 0 ? 'Boundary checks passed' : 'Boundary findings: ' + findings.length);
}
function DA3_uniquenessViolation(model) {
    const findings = [];
    for (const entity of model.entities) {
        for (const key of entity.primaryKey ?? []) {
            const field = fieldByPath(model, entity.name, key);
            if (field?.nullable === true)
                findings.push({ code: 'DA3_NULLABLE_PRIMARY_KEY', severity: 'error', message: 'Primary key ' + entity.name + '.' + key + ' is nullable', evidence: { entity: entity.name, field: key } });
        }
        for (const keySet of entity.uniqueKeys ?? []) {
            for (const key of keySet) {
                const field = fieldByPath(model, entity.name, key);
                if (field?.nullable === true)
                    findings.push({ code: 'DA3_NULLABLE_UNIQUE_KEY', severity: 'warning', message: 'Unique key ' + entity.name + '.' + key + ' is nullable', evidence: { entity: entity.name, field: key } });
            }
        }
    }
    return checkResult('DA3', 'Uniqueness Violation', findings, findings.length === 0 ? 'No uniqueness violations' : 'Uniqueness findings: ' + findings.length);
}
function DA4_referentialIntegrityViolation(model) {
    const findings = [];
    for (const relationship of model.relationships ?? []) {
        const fromField = fieldByPath(model, relationship.fromEntity, relationship.fromField);
        const toField = relationship.toField === undefined ? undefined : fieldByPath(model, relationship.toEntity, relationship.toField);
        if (fromField !== undefined && toField !== undefined && fromField.type !== toField.type) {
            findings.push({ code: 'DA4_REF_TYPE_MISMATCH', severity: 'warning', message: 'Relationship ' + (relationship.name ?? relationship.fromEntity + '.' + relationship.fromField) + ' links different types ' + fromField.type + ' -> ' + toField.type, evidence: { relationship } });
        }
    }
    return checkResult('DA4', 'Referential Integrity Violation', findings, findings.length === 0 ? 'No referential integrity violations' : 'Referential integrity findings: ' + findings.length);
}
function DA5_migrationCoverage(model, options) {
    const findings = [];
    if (options.beforeModel === undefined) {
        return checkResult('DA5', 'Migration Coverage', [], 'No beforeModel supplied — skipped');
    }
    const beforeValidation = validateDataModel(options.beforeModel);
    if (!beforeValidation.ok) {
        return checkResult('DA5', 'Migration Coverage', [{ code: 'DA5_BEFORE_MODEL_INVALID', severity: 'error', message: 'Before model failed validation: ' + beforeValidation.errors.join('; ') }], 'Before model invalid');
    }
    const before = beforeValidation.model;
    const afterPaths = new Set(allFieldPaths(model));
    const beforePaths = allFieldPaths(before);
    const mapping = options.fieldMapping ?? {};
    const migrationFrom = new Set((options.migrationMappings ?? []).map((mapping) => mapping.from));
    for (const path of beforePaths) {
        const mapped = mapFieldPath(mapping, path);
        if (!afterPaths.has(mapped) && !migrationFrom.has(path)) {
            findings.push({ code: 'DA5_FIELD_NOT_MIGRATED', severity: 'error', message: 'BEFORE field ' + path + ' is not present in AFTER and has no migration mapping', evidence: { beforeField: path, afterField: mapped } });
        }
    }
    return checkResult('DA5', 'Migration Coverage', findings, findings.length === 0 ? 'All before/after fields are covered by mappings' : 'Migration coverage findings: ' + findings.length);
}
function DA6_copyConsistency(model, options) {
    const findings = [];
    const afterFields = entityFieldMap(model);
    for (const pair of options.copyPairs ?? []) {
        const targetEntity = entityByName(model, pair.targetEntity);
        if (targetEntity === undefined) {
            findings.push({ code: 'DA6_TARGET_ENTITY_MISSING', severity: 'error', message: 'Copy pair ' + pair.id + ' references unknown target entity ' + pair.targetEntity, evidence: { pair } });
            continue;
        }
        if (entityByName(model, pair.sourceEntity) === undefined) {
            findings.push({ code: 'DA6_SOURCE_ENTITY_MISSING', severity: 'error', message: 'Copy pair ' + pair.id + ' references unknown source entity ' + pair.sourceEntity, evidence: { pair } });
        }
        const mappedTargets = new Set(Object.values(pair.mapping).map((field) => pair.targetEntity + '.' + field));
        for (const field of targetEntity.fields) {
            if (field.required === true && !mappedTargets.has(pair.targetEntity + '.' + field.name)) {
                findings.push({ code: 'DA6_REQUIRED_TARGET_UNMAPPED', severity: 'error', message: 'Copy pair ' + pair.id + ' does not map required target field ' + pair.targetEntity + '.' + field.name, evidence: { pair, field: field.name } });
            }
        }
        for (const [sourceField, targetField] of Object.entries(pair.mapping)) {
            if (fieldByPath(model, pair.sourceEntity, sourceField) === undefined) {
                findings.push({ code: 'DA6_SOURCE_FIELD_MISSING', severity: 'error', message: 'Copy pair ' + pair.id + ' maps unknown source field ' + pair.sourceEntity + '.' + sourceField, evidence: { pair, field: sourceField } });
            }
            if (afterFields.has(pair.targetEntity + '.' + targetField) === false) {
                findings.push({ code: 'DA6_TARGET_FIELD_MISSING', severity: 'error', message: 'Copy pair ' + pair.id + ' maps unknown target field ' + pair.targetEntity + '.' + targetField, evidence: { pair, field: targetField } });
            }
        }
    }
    return checkResult('DA6', 'Copy Consistency', findings, findings.length === 0 ? 'Copy mappings are consistent' : 'Copy consistency findings: ' + findings.length);
}
function DA7_rollbackBackupSymmetry(model, options) {
    const findings = [];
    const backupKeys = new Set((options.backupPairs ?? []).map((pair) => pair.sourceEntity + '|' + pair.targetEntity));
    for (const pair of options.copyPairs ?? []) {
        if (!backupKeys.has(pair.sourceEntity + '|' + pair.targetEntity)) {
            findings.push({ code: 'DA7_NO_BACKUP_PAIR', severity: 'warning', message: 'Copy pair ' + pair.id + ' (' + pair.sourceEntity + ' -> ' + pair.targetEntity + ') has no matching backup/restore pair', evidence: { pair } });
        }
    }
    return checkResult('DA7', 'Rollback/Backup Symmetry', findings, findings.length === 0 ? 'Copy/backup pairs are balanced' : 'Rollback/backup findings: ' + findings.length);
}
function DA8_idempotentConstraints(model, options) {
    const findings = [];
    const copyPairs = options.copyPairs ?? [];
    const migrationMappings = options.migrationMappings ?? [];
    for (const invariant of model.invariants ?? []) {
        if (invariant.kind === 'idempotent-copy') {
            const pair = copyPairs.find((entry) => entry.sourceEntity === invariant.sourceEntity && entry.targetEntity === invariant.targetEntity);
            if (pair === undefined) {
                findings.push({
                    code: 'DA8_COPY_PAIR_MISSING',
                    severity: 'error',
                    message: 'Idempotent-copy invariant "' + invariant.id + '" has no matching copy pair for ' + invariant.sourceEntity + ' -> ' + invariant.targetEntity,
                    evidence: { invariant },
                });
            }
        }
        else if (invariant.kind === 'idempotent-migration') {
            const mapping = migrationMappings.find((entry) => entry.from === invariant.from && entry.to === invariant.to);
            if (mapping === undefined) {
                findings.push({
                    code: 'DA8_MIGRATION_MAPPING_MISSING',
                    severity: 'error',
                    message: 'Idempotent-migration invariant "' + invariant.id + '" has no matching migration mapping ' + invariant.from + ' -> ' + invariant.to,
                    evidence: { invariant },
                });
            }
            else if (mapping.transform === 'split' || mapping.transform === 'merge' || mapping.transform === 'drop') {
                findings.push({
                    code: 'DA8_NON_IDEMPOTENT_TRANSFORM',
                    severity: 'warning',
                    message: 'Migration mapping ' + invariant.from + ' -> ' + invariant.to + ' uses non-idempotent transform ' + (mapping.transform ?? 'unknown'),
                    evidence: { invariant, mapping },
                });
            }
        }
    }
    return checkResult('DA8', 'Idempotent Constraints', findings, findings.length === 0 ? 'Idempotency constraints are satisfied' : 'Idempotency findings: ' + findings.length);
}
function DD1_dataBehaviorPreservation(before, after, options) {
    const findings = [];
    const afterFields = entityFieldMap(after);
    const mapping = options.fieldMapping ?? {};
    const migrationFrom = new Set((options.migrationMappings ?? []).map((mapping) => mapping.from));
    for (const entity of before.entities) {
        for (const field of entity.fields) {
            const path = entity.name + '.' + field.name;
            const mapped = mapFieldPath(mapping, path);
            const afterField = afterFields.get(mapped);
            if (afterField === undefined) {
                if (!migrationFrom.has(path)) {
                    findings.push({ code: 'DD1_FIELD_REMOVED', severity: 'error', message: 'BEFORE field ' + path + ' is missing in AFTER and has no migration mapping', evidence: { beforeField: path, mapped } });
                }
                continue;
            }
            if (field.required === true && afterField.required !== true && !migrationFrom.has(path)) {
                findings.push({ code: 'DD1_REQUIRED_BECAME_OPTIONAL', severity: 'warning', message: 'BEFORE required field ' + path + ' is optional in AFTER', evidence: { beforeField: path, afterField: mapped } });
            }
        }
    }
    return checkResult('DD1', 'Data Behavior Preservation', findings, findings.length === 0 ? 'BEFORE data behavior is preserved in AFTER' : 'Data behavior findings: ' + findings.length);
}
function DD2_dataInvariantContinuity(before, after, options) {
    const findings = [];
    const afterEntities = new Set(after.entities.map((entity) => entity.name));
    const afterFields = entityFieldMap(after);
    const mapping = options.fieldMapping ?? {};
    for (const invariant of before.invariants ?? []) {
        if (invariant.kind === 'field-required' || invariant.kind === 'range' || invariant.kind === 'no-orphan') {
            const mappedField = mapFieldPath(mapping, invariant.entity + '.' + invariant.field);
            const [entityName, fieldName] = mappedField.split('.');
            if (!afterEntities.has(entityName) || !afterFields.has(mappedField)) {
                findings.push({ code: 'DD2_INVARIANT_FIELD_MISSING', severity: 'error', message: 'BEFORE invariant "' + invariant.id + '" references ' + mappedField + ', missing in AFTER', evidence: { invariant, mappedField } });
            }
        }
        else if (invariant.kind === 'unique') {
            for (const field of invariant.fields) {
                const mappedField = mapFieldPath(mapping, invariant.entity + '.' + field);
                if (!afterFields.has(mappedField)) {
                    findings.push({ code: 'DD2_INVARIANT_FIELD_MISSING', severity: 'error', message: 'BEFORE unique invariant "' + invariant.id + '" references ' + mappedField + ', missing in AFTER', evidence: { invariant, mappedField } });
                }
            }
        }
        else if (invariant.kind === 'referential-integrity') {
            const mappedField = mapFieldPath(mapping, invariant.entity + '.' + invariant.field);
            if (!afterFields.has(mappedField)) {
                findings.push({ code: 'DD2_INVARIANT_FIELD_MISSING', severity: 'error', message: 'BEFORE referential invariant "' + invariant.id + '" references ' + mappedField + ', missing in AFTER', evidence: { invariant, mappedField } });
            }
            if (!afterEntities.has(invariant.refEntity)) {
                findings.push({ code: 'DD2_INVARIANT_ENTITY_MISSING', severity: 'error', message: 'BEFORE referential invariant "' + invariant.id + '" references missing entity ' + invariant.refEntity, evidence: { invariant } });
            }
        }
        else if (invariant.kind === 'count-equal') {
            if (!afterEntities.has(invariant.sourceEntity))
                findings.push({ code: 'DD2_INVARIANT_ENTITY_MISSING', severity: 'error', message: 'BEFORE count-equal invariant "' + invariant.id + '" references missing source entity ' + invariant.sourceEntity, evidence: { invariant } });
            if (!afterEntities.has(invariant.targetEntity))
                findings.push({ code: 'DD2_INVARIANT_ENTITY_MISSING', severity: 'error', message: 'BEFORE count-equal invariant "' + invariant.id + '" references missing target entity ' + invariant.targetEntity, evidence: { invariant } });
        }
        else if (invariant.kind === 'field-equal') {
            const sourceMapped = mapFieldPath(mapping, invariant.sourceEntity + '.' + invariant.sourceField);
            const targetMapped = mapFieldPath(mapping, invariant.targetEntity + '.' + invariant.targetField);
            if (!afterFields.has(sourceMapped))
                findings.push({ code: 'DD2_INVARIANT_FIELD_MISSING', severity: 'error', message: 'BEFORE field-equal invariant "' + invariant.id + '" references missing source field ' + sourceMapped, evidence: { invariant, sourceMapped } });
            if (!afterFields.has(targetMapped))
                findings.push({ code: 'DD2_INVARIANT_FIELD_MISSING', severity: 'error', message: 'BEFORE field-equal invariant "' + invariant.id + '" references missing target field ' + targetMapped, evidence: { invariant, targetMapped } });
        }
    }
    return checkResult('DD2', 'Data Invariant Continuity', findings, findings.length === 0 ? 'All BEFORE data invariants continue to hold structurally' : 'Data invariant continuity findings: ' + findings.length);
}
function DD3_deltaSummary(before, after, options) {
    const findings = [];
    const afterEntities = new Set(after.entities.map((entity) => entity.name));
    const beforeEntities = new Set(before.entities.map((entity) => entity.name));
    const removedEntities = before.entities.filter((entity) => !afterEntities.has(entity.name)).map((entity) => entity.name);
    const addedEntities = after.entities.filter((entity) => !beforeEntities.has(entity.name)).map((entity) => entity.name);
    const mapping = options.fieldMapping ?? {};
    const beforePaths = new Set(allFieldPaths(before));
    const afterPaths = new Set(allFieldPaths(after));
    const removedFields = [];
    const addedFields = [];
    for (const path of beforePaths) {
        const mapped = mapFieldPath(mapping, path);
        if (!afterPaths.has(mapped))
            removedFields.push(path);
    }
    for (const path of afterPaths) {
        let found = false;
        for (const beforePath of beforePaths) {
            if (mapFieldPath(mapping, beforePath) === path) {
                found = true;
                break;
            }
        }
        if (!found)
            addedFields.push(path);
    }
    for (const entity of removedEntities)
        findings.push({ code: 'DD3_REMOVED_ENTITY', severity: 'warning', message: 'BEFORE entity ' + entity + ' is not present in AFTER', evidence: { entity } });
    for (const field of removedFields)
        findings.push({ code: 'DD3_REMOVED_FIELD', severity: 'warning', message: 'BEFORE field ' + field + ' is not present in AFTER', evidence: { field } });
    const detail = 'Delta: +' + addedEntities.length + ' entities, -' + removedEntities.length + ' entities, +' + addedFields.length + ' fields, -' + removedFields.length + ' fields';
    return checkResult('DD3', 'Delta Summary', findings, detail);
}
function DD4_breakingChangeRegression(before, after, options) {
    const findings = [];
    const afterFields = entityFieldMap(after);
    const mapping = options.fieldMapping ?? {};
    const migrationFrom = new Set((options.migrationMappings ?? []).map((mapping) => mapping.from));
    for (const entity of before.entities) {
        for (const field of entity.fields) {
            const path = entity.name + '.' + field.name;
            const mapped = mapFieldPath(mapping, path);
            const afterField = afterFields.get(mapped);
            if (afterField === undefined) {
                if (field.required === true && !migrationFrom.has(path)) {
                    findings.push({ code: 'DD4_REQUIRED_FIELD_REMOVED', severity: 'error', message: 'Required field ' + path + ' was removed without migration mapping', evidence: { beforeField: path } });
                }
                continue;
            }
            if (field.required !== true && afterField.required === true && !migrationFrom.has(path)) {
                findings.push({ code: 'DD4_OPTIONAL_BECAME_REQUIRED', severity: 'warning', message: 'Optional field ' + path + ' became required in AFTER', evidence: { beforeField: path, afterField: mapped } });
            }
            if (field.nullable !== false && afterField.nullable === false && !migrationFrom.has(path)) {
                findings.push({ code: 'DD4_NULLABLE_BECAME_NOT_NULL', severity: 'warning', message: 'Nullable field ' + path + ' became non-nullable in AFTER', evidence: { beforeField: path, afterField: mapped } });
            }
            if (field.type !== afterField.type && !migrationFrom.has(path)) {
                findings.push({ code: 'DD4_TYPE_CHANGED', severity: 'warning', message: 'Field type changed from ' + field.type + ' to ' + afterField.type + ' for ' + path, evidence: { beforeField: path, beforeType: field.type, afterType: afterField.type } });
            }
        }
    }
    return checkResult('DD4', 'Breaking Change Regression', findings, findings.length === 0 ? 'No new breaking changes detected' : 'Breaking change findings: ' + findings.length);
}
function buildDataComparisonSummary(before, after, options) {
    const afterEntities = new Set(after.entities.map((entity) => entity.name));
    const beforeEntities = new Set(before.entities.map((entity) => entity.name));
    const addedEntities = after.entities.filter((entity) => !beforeEntities.has(entity.name)).map((entity) => entity.name).sort();
    const removedEntities = before.entities.filter((entity) => !afterEntities.has(entity.name)).map((entity) => entity.name).sort();
    const mapping = options.fieldMapping ?? {};
    const beforePaths = allFieldPaths(before);
    const afterPaths = allFieldPaths(after);
    const afterPathSet = new Set(afterPaths);
    const removedFields = beforePaths.filter((path) => !afterPathSet.has(mapFieldPath(mapping, path))).sort();
    const addedFields = afterPaths.filter((path) => !beforePaths.some((beforePath) => mapFieldPath(mapping, beforePath) === path)).sort();
    const beforeRelationships = (before.relationships ?? []).map((relationship) => relationship.name ?? relationship.fromEntity + '.' + relationship.fromField + '->' + relationship.toEntity);
    const afterRelationships = (after.relationships ?? []).map((relationship) => relationship.name ?? relationship.fromEntity + '.' + relationship.fromField + '->' + relationship.toEntity);
    const removedRelationships = beforeRelationships.filter((name) => !afterRelationships.includes(name)).sort();
    const addedRelationships = afterRelationships.filter((name) => !beforeRelationships.includes(name)).sort();
    return {
        beforeModelHash: dataModelHash(before),
        afterModelHash: dataModelHash(after),
        fieldMapping: mapping,
        beforeEntities: before.entities.length,
        beforeFields: beforePaths.length,
        afterEntities: after.entities.length,
        afterFields: afterPaths.length,
        addedEntities,
        removedEntities,
        addedFields,
        removedFields,
        addedRelationships,
        removedRelationships,
    };
}
export function runDataVerification(input, options = {}) {
    const validation = validateDataModel(input);
    if (!validation.ok) {
        return {
            ok: false,
            schemaVersion: 1,
            modelHash: '',
            summary: { entities: 0, fields: 0, errors: validation.errors.length, warnings: 0, checksRun: 0 },
            checks: [{
                    id: 'DATA_MODEL',
                    name: 'Data Model Validation',
                    status: 'fail',
                    detail: 'Data model schema validation failed: ' + validation.errors.length + ' errors',
                    findings: validation.errors.map((message) => ({ code: 'DATA_MODEL_INVALID', severity: 'error', message })),
                }],
        };
    }
    const model = validation.model;
    const checks = [
        DS1_schemaWellFormed(model),
        DS2_requiredCompleteness(model, options),
        DS3_relationshipIntegrity(model),
        DS4_typeNullabilityConsistency(model),
        DA1_nullEmptyInjection(model),
        DA2_boundaryBlast(model),
        DA3_uniquenessViolation(model),
        DA4_referentialIntegrityViolation(model),
        DA5_migrationCoverage(model, options),
        DA6_copyConsistency(model, options),
        DA7_rollbackBackupSymmetry(model, options),
        DA8_idempotentConstraints(model, options),
    ];
    let comparison;
    if (options.beforeModel !== undefined) {
        const beforeValidation = validateDataModel(options.beforeModel);
        if (!beforeValidation.ok) {
            return {
                ok: false,
                schemaVersion: 1,
                modelHash: dataModelHash(model),
                summary: {
                    entities: model.entities.length,
                    fields: allFieldPaths(model).length,
                    errors: beforeValidation.errors.length,
                    warnings: 0,
                    checksRun: checks.length + 1,
                },
                checks: [
                    ...checks,
                    {
                        id: 'BEFORE_DATA_MODEL',
                        name: 'Before Data Model Validation',
                        status: 'fail',
                        detail: 'Before data model schema validation failed: ' + beforeValidation.errors.length + ' errors',
                        findings: beforeValidation.errors.map((message) => ({ code: 'BEFORE_DATA_MODEL_INVALID', severity: 'error', message })),
                    },
                ],
            };
        }
        const before = beforeValidation.model;
        checks.push(DD1_dataBehaviorPreservation(before, model, options), DD2_dataInvariantContinuity(before, model, options), DD3_deltaSummary(before, model, options), DD4_breakingChangeRegression(before, model, options));
        comparison = buildDataComparisonSummary(before, model, options);
    }
    const errors = checks.reduce((sum, check) => sum + check.findings.filter((finding) => finding.severity === 'error').length, 0);
    const warnings = checks.reduce((sum, check) => sum + check.findings.filter((finding) => finding.severity === 'warning').length, 0);
    return {
        ok: true,
        schemaVersion: 1,
        modelHash: dataModelHash(model),
        summary: {
            entities: model.entities.length,
            fields: allFieldPaths(model).length,
            errors,
            warnings,
            checksRun: checks.length,
        },
        checks,
        ...(comparison === undefined ? {} : { comparison }),
    };
}
