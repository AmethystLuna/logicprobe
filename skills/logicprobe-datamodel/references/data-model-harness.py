#!/usr/bin/env python3
"""Data Model Verification Harness — generic template for logicprobe-datamodel.

Usage:
  python3 data-model-harness.py --model model.json [--before-model before.json]
      [--field-mapping mapping.json] [--copy-pairs copies.json]
      [--migration-mappings migrations.json] [--backup-pairs backups.json]

Outputs a structured DS/DA/DD verification report.
"""
import argparse
import json
import sys
from collections import defaultdict

KNOWN_TYPES = {
    'string', 'integer', 'number', 'boolean', 'uuid', 'date', 'datetime',
    'timestamp', 'json', 'enum', 'array', 'object', 'binary',
}


def load_json(path):
    with open(path, encoding='utf-8') as handle:
        return json.load(handle)


def entity_by_name(model, name):
    for entity in model.get('entities', []):
        if entity.get('name') == name:
            return entity
    return None


def field_by_path(model, entity_name, field_name):
    entity = entity_by_name(model, entity_name)
    if entity is None:
        return None
    for field in entity.get('fields', []):
        if field.get('name') == field_name:
            return field
    return None


def all_field_paths(model):
    result = []
    for entity in model.get('entities', []):
        for field in entity.get('fields', []):
            result.append(entity.get('name') + '.' + field.get('name'))
    return result


def map_field(mapping, path):
    return mapping.get(path, path) if mapping else path


def check_result(name, findings, detail=None):
    errors = sum(1 for finding in findings if finding.get('severity') == 'error')
    warnings = sum(1 for finding in findings if finding.get('severity') == 'warning')
    if detail is None:
        detail = f"{len(findings)} findings" if findings else "No findings"
    return {
        'id': name,
        'status': 'FAIL' if findings else 'PASS',
        'findings': findings,
        'detail': detail,
        'errors': errors,
        'warnings': warnings,
    }


def ds1_schema_well_formed(model):
    findings = []
    entity_names = set()
    for entity in model.get('entities', []):
        name = entity.get('name')
        if name in entity_names:
            findings.append({'code': 'DS1_DUPLICATE_ENTITY', 'severity': 'error', 'message': f'Duplicate entity {name}', 'evidence': {'entity': name}})
        entity_names.add(name)
        field_names = set()
        for field in entity.get('fields', []):
            fname = field.get('name')
            if fname in field_names:
                findings.append({'code': 'DS1_DUPLICATE_FIELD', 'severity': 'error', 'message': f'Duplicate field {name}.{fname}', 'evidence': {'entity': name, 'field': fname}})
            field_names.add(fname)
            if not field.get('type'):
                findings.append({'code': 'DS1_EMPTY_TYPE', 'severity': 'error', 'message': f'Field {name}.{fname} has empty type', 'evidence': {'entity': name, 'field': fname}})
        for key in entity.get('primaryKey', []):
            if key not in field_names:
                findings.append({'code': 'DS1_PRIMARY_KEY_MISSING', 'severity': 'error', 'message': f'Primary key {key} missing in {name}', 'evidence': {'entity': name, 'field': key}})
        for key_set in entity.get('uniqueKeys', []):
            for key in key_set:
                if key not in field_names:
                    findings.append({'code': 'DS1_UNIQUE_KEY_MISSING', 'severity': 'error', 'message': f'Unique key {key} missing in {name}', 'evidence': {'entity': name, 'field': key}})
    return check_result('DS1', findings, 'Schema well-formedness')


def ds2_required_completeness(model, options):
    findings = []
    migration_from = {m.get('from') for m in options.get('migrationMappings', [])}
    copy_targets = set()
    for pair in options.get('copyPairs', []):
        for target in pair.get('mapping', {}).values():
            copy_targets.add(pair.get('targetEntity') + '.' + target)
    before_paths = set()
    if options.get('beforeModel') is not None:
        mapping = options.get('fieldMapping', {})
        before_paths = {map_field(mapping, path) for path in all_field_paths(options['beforeModel'])}
    for entity in model.get('entities', []):
        for field in entity.get('fields', []):
            if field.get('required') is not True:
                continue
            if field.get('name') in entity.get('primaryKey', []) and field.get('nullable') is True:
                findings.append({'code': 'DS2_NULLABLE_PRIMARY_KEY', 'severity': 'error', 'message': f'Primary key {entity.get("name")}.{field.get("name")} must not be nullable', 'evidence': {'entity': entity.get('name'), 'field': field.get('name')}})
            if options.get('beforeModel') is not None:
                path = entity.get('name') + '.' + field.get('name')
                if path not in before_paths and path not in migration_from and path not in copy_targets:
                    findings.append({'code': 'DS2_REQUIRED_FIELD_UNSOURCED', 'severity': 'warning', 'message': f'Required field {path} has no migration mapping or copy target', 'evidence': {'entity': entity.get('name'), 'field': field.get('name')}})
    return check_result('DS2', findings, 'Required-field completeness')


def ds3_relationship_integrity(model):
    findings = []
    for rel in model.get('relationships', []):
        from_entity = entity_by_name(model, rel.get('fromEntity'))
        to_entity = entity_by_name(model, rel.get('toEntity'))
        if from_entity is None:
            findings.append({'code': 'DS3_FROM_ENTITY_MISSING', 'severity': 'error', 'message': f"Unknown fromEntity {rel.get('fromEntity')}", 'evidence': {'relationship': rel}})
            continue
        if to_entity is None:
            findings.append({'code': 'DS3_TO_ENTITY_MISSING', 'severity': 'error', 'message': f"Unknown toEntity {rel.get('toEntity')}", 'evidence': {'relationship': rel}})
            continue
        if not any(f.get('name') == rel.get('fromField') for f in from_entity.get('fields', [])):
            findings.append({'code': 'DS3_FROM_FIELD_MISSING', 'severity': 'error', 'message': f"Field {rel.get('fromField')} missing in {rel.get('fromEntity')}", 'evidence': {'relationship': rel}})
        if rel.get('toField') is not None and not any(f.get('name') == rel.get('toField') for f in to_entity.get('fields', [])):
            findings.append({'code': 'DS3_TO_FIELD_MISSING', 'severity': 'error', 'message': f"Field {rel.get('toField')} missing in {rel.get('toEntity')}", 'evidence': {'relationship': rel}})
    return check_result('DS3', findings, 'Relationship integrity')


def ds4_type_nullability_consistency(model):
    findings = []
    for entity in model.get('entities', []):
        for field in entity.get('fields', []):
            name = entity.get('name') + '.' + field.get('name')
            if field.get('required') is True and field.get('nullable') is True:
                findings.append({'code': 'DS4_REQUIRED_NULLABLE', 'severity': 'error', 'message': f'{name} is both required and nullable', 'evidence': {'entity': entity.get('name'), 'field': field.get('name')}})
            if field.get('unique') is True and field.get('nullable') is True:
                findings.append({'code': 'DS4_UNIQUE_NULLABLE', 'severity': 'warning', 'message': f'{name} is unique and nullable', 'evidence': {'entity': entity.get('name'), 'field': field.get('name')}})
            if isinstance(field.get('min'), (int, float)) and isinstance(field.get('max'), (int, float)) and field['min'] > field['max']:
                findings.append({'code': 'DS4_MIN_GT_MAX', 'severity': 'error', 'message': f'{name} has min > max', 'evidence': {'entity': entity.get('name'), 'field': field.get('name')}})
            if isinstance(field.get('minLength'), (int, float)) and isinstance(field.get('maxLength'), (int, float)) and field['minLength'] > field['maxLength']:
                findings.append({'code': 'DS4_MIN_LENGTH_GT_MAX_LENGTH', 'severity': 'error', 'message': f'{name} has minLength > maxLength', 'evidence': {'entity': entity.get('name'), 'field': field.get('name')}})
    return check_result('DS4', findings, 'Type/nullability consistency')


def da1_null_empty_injection(model):
    findings = []
    for entity in model.get('entities', []):
        for field in entity.get('fields', []):
            name = entity.get('name') + '.' + field.get('name')
            if field.get('required') is True and field.get('nullable') is True:
                findings.append({'code': 'DA1_NULL_ACCEPTED_ON_REQUIRED', 'severity': 'error', 'message': f'Null can be injected into required field {name}', 'evidence': {'entity': entity.get('name'), 'field': field.get('name')}})
            if field.get('required') is True and field.get('type') == 'string' and field.get('minLength') == 0:
                findings.append({'code': 'DA1_EMPTY_STRING_ALLOWED', 'severity': 'warning', 'message': f'Required string field {name} allows empty string', 'evidence': {'entity': entity.get('name'), 'field': field.get('name')}})
    return check_result('DA1', findings, 'Null/empty injection')


def da2_boundary_blast(model):
    findings = []
    for entity in model.get('entities', []):
        for field in entity.get('fields', []):
            name = entity.get('name') + '.' + field.get('name')
            if isinstance(field.get('default'), (int, float)):
                if field.get('min') is not None and field['default'] < field['min']:
                    findings.append({'code': 'DA2_DEFAULT_BELOW_MIN', 'severity': 'error', 'message': f'Default below min for {name}', 'evidence': {'entity': entity.get('name'), 'field': field.get('name')}})
                if field.get('max') is not None and field['default'] > field['max']:
                    findings.append({'code': 'DA2_DEFAULT_ABOVE_MAX', 'severity': 'error', 'message': f'Default above max for {name}', 'evidence': {'entity': entity.get('name'), 'field': field.get('name')}})
    for check in model.get('boundaryChecks', []):
        field = field_by_path(model, check.get('entity'), check.get('field'))
        if field is None:
            findings.append({'code': 'DA2_BOUNDARY_FIELD_MISSING', 'severity': 'error', 'message': f"Unknown boundary field {check.get('entity')}.{check.get('field')}", 'evidence': check})
            continue
        for value in check.get('values', []):
            if isinstance(value, (int, float)):
                if field.get('min') is not None and value < field['min']:
                    findings.append({'code': 'DA2_BOUNDARY_BELOW_MIN', 'severity': 'warning', 'message': f'Boundary below min for {check.get("entity")}.{check.get("field")}', 'evidence': check})
                if field.get('max') is not None and value > field['max']:
                    findings.append({'code': 'DA2_BOUNDARY_ABOVE_MAX', 'severity': 'warning', 'message': f'Boundary above max for {check.get("entity")}.{check.get("field")}', 'evidence': check})
    return check_result('DA2', findings, 'Boundary blast')


def da3_uniqueness_violation(model):
    findings = []
    for entity in model.get('entities', []):
        for key in entity.get('primaryKey', []):
            field = field_by_path(model, entity.get('name'), key)
            if field is not None and field.get('nullable') is True:
                findings.append({'code': 'DA3_NULLABLE_PRIMARY_KEY', 'severity': 'error', 'message': f'Primary key {entity.get("name")}.{key} is nullable', 'evidence': {'entity': entity.get('name'), 'field': key}})
        for key_set in entity.get('uniqueKeys', []):
            for key in key_set:
                field = field_by_path(model, entity.get('name'), key)
                if field is not None and field.get('nullable') is True:
                    findings.append({'code': 'DA3_NULLABLE_UNIQUE_KEY', 'severity': 'warning', 'message': f'Unique key {entity.get("name")}.{key} is nullable', 'evidence': {'entity': entity.get('name'), 'field': key}})
    return check_result('DA3', findings, 'Uniqueness violation')


def da4_referential_integrity_violation(model):
    findings = []
    for rel in model.get('relationships', []):
        from_field = field_by_path(model, rel.get('fromEntity'), rel.get('fromField'))
        to_field = None
        if rel.get('toField') is not None:
            to_field = field_by_path(model, rel.get('toEntity'), rel.get('toField'))
        if from_field is not None and to_field is not None and from_field.get('type') != to_field.get('type'):
            findings.append({'code': 'DA4_REF_TYPE_MISMATCH', 'severity': 'warning', 'message': f"Relationship type mismatch {rel.get('fromEntity')}.{rel.get('fromField')} -> {rel.get('toEntity')}.{rel.get('toField')}", 'evidence': {'relationship': rel}})
    return check_result('DA4', findings, 'Referential integrity violation')


def da5_migration_coverage(model, options):
    findings = []
    before = options.get('beforeModel')
    if before is None:
        return check_result('DA5', [], 'No beforeModel supplied — skipped')
    after_paths = set(all_field_paths(model))
    before_paths = all_field_paths(before)
    mapping = options.get('fieldMapping', {})
    migration_from = {m.get('from') for m in options.get('migrationMappings', [])}
    for path in before_paths:
        mapped = map_field(mapping, path)
        if mapped not in after_paths and path not in migration_from:
            findings.append({'code': 'DA5_FIELD_NOT_MIGRATED', 'severity': 'error', 'message': f'BEFORE field {path} is missing in AFTER and has no migration mapping', 'evidence': {'beforeField': path, 'afterField': mapped}})
    return check_result('DA5', findings, 'Migration coverage')


def da6_copy_consistency(model, options):
    findings = []
    for pair in options.get('copyPairs', []):
        target_entity = entity_by_name(model, pair.get('targetEntity'))
        if target_entity is None:
            findings.append({'code': 'DA6_TARGET_ENTITY_MISSING', 'severity': 'error', 'message': f"Unknown target entity {pair.get('targetEntity')}", 'evidence': {'pair': pair}})
            continue
        if entity_by_name(model, pair.get('sourceEntity')) is None:
            findings.append({'code': 'DA6_SOURCE_ENTITY_MISSING', 'severity': 'error', 'message': f"Unknown source entity {pair.get('sourceEntity')}", 'evidence': {'pair': pair}})
        mapped_targets = {pair.get('targetEntity') + '.' + target for target in pair.get('mapping', {}).values()}
        for field in target_entity.get('fields', []):
            if field.get('required') is True and (pair.get('targetEntity') + '.' + field.get('name')) not in mapped_targets:
                findings.append({'code': 'DA6_REQUIRED_TARGET_UNMAPPED', 'severity': 'error', 'message': f"Copy pair {pair.get('id')} does not map required target field {pair.get('targetEntity')}.{field.get('name')}", 'evidence': {'pair': pair, 'field': field.get('name')}})
    return check_result('DA6', findings, 'Copy consistency')


def da7_rollback_backup_symmetry(model, options):
    findings = []
    backup_keys = {pair.get('sourceEntity') + '|' + pair.get('targetEntity') for pair in options.get('backupPairs', [])}
    for pair in options.get('copyPairs', []):
        key = pair.get('sourceEntity') + '|' + pair.get('targetEntity')
        if key not in backup_keys:
            findings.append({'code': 'DA7_NO_BACKUP_PAIR', 'severity': 'warning', 'message': f"Copy pair {pair.get('id')} has no matching backup/restore pair", 'evidence': {'pair': pair}})
    return check_result('DA7', findings, 'Rollback/backup symmetry')


def da8_idempotent_constraints(model, options):
    findings = []
    copy_pairs = options.get('copyPairs', [])
    migration_mappings = options.get('migrationMappings', [])
    for invariant in model.get('invariants', []):
        kind = invariant.get('kind')
        if kind == 'idempotent-copy':
            pair = next((p for p in copy_pairs if p.get('sourceEntity') == invariant.get('sourceEntity') and p.get('targetEntity') == invariant.get('targetEntity')), None)
            if pair is None:
                findings.append({'code': 'DA8_COPY_PAIR_MISSING', 'severity': 'error', 'message': f"Idempotent-copy invariant {invariant.get('id')} has no matching copy pair", 'evidence': {'invariant': invariant}})
        elif kind == 'idempotent-migration':
            mapping = next((m for m in migration_mappings if m.get('from') == invariant.get('from') and m.get('to') == invariant.get('to')), None)
            if mapping is None:
                findings.append({'code': 'DA8_MIGRATION_MAPPING_MISSING', 'severity': 'error', 'message': f"Idempotent-migration invariant {invariant.get('id')} has no matching migration mapping", 'evidence': {'invariant': invariant}})
            elif mapping.get('transform') in ('split', 'merge', 'drop'):
                findings.append({'code': 'DA8_NON_IDEMPOTENT_TRANSFORM', 'severity': 'warning', 'message': f"Migration mapping {invariant.get('from')} -> {invariant.get('to')} uses non-idempotent transform {mapping.get('transform')}", 'evidence': {'invariant': invariant, 'mapping': mapping}})
    return check_result('DA8', findings, 'Idempotent constraints')

def data_step_registry(options):
    registry = {}
    for pair in options.get('copyPairs', []):
        registry[pair.get('id')] = {'kind': 'copy', 'copyPair': pair}
    for mapping in options.get('migrationMappings', []):
        step_id = mapping.get('id') or (mapping.get('from') + '->' + mapping.get('to'))
        registry[step_id] = {'kind': 'migration', 'transform': mapping.get('transform')}
    return registry

MONOTONIC_DATA_TYPES = {'integer', 'number', 'date', 'datetime', 'timestamp'}

def da9_data_monotonic(model, options):
    findings = []
    for invariant in model.get('invariants', []):
        if invariant.get('kind') != 'monotonic':
            continue
        field = field_by_path(model, invariant.get('entity'), invariant.get('field'))
        if field is None:
            findings.append({'code': 'DA9_MONOTONIC_FIELD_MISSING', 'severity': 'error', 'message': f"Monotonic invariant {invariant.get('id')} references missing field", 'evidence': {'invariant': invariant}})
            continue
        if field.get('type') not in MONOTONIC_DATA_TYPES:
            findings.append({'code': 'DA9_MONOTONIC_TYPE_UNSUPPORTED', 'severity': 'warning', 'message': f"Monotonic field {invariant.get('entity')}.{invariant.get('field')} has unsupported type {field.get('type')}", 'evidence': {'invariant': invariant}})
        if field.get('monotonic') is not None and field.get('monotonic') != invariant.get('direction'):
            findings.append({'code': 'DA9_MONOTONIC_DIRECTION_MISMATCH', 'severity': 'error', 'message': f"Monotonic direction mismatch for {invariant.get('entity')}.{invariant.get('field')}", 'evidence': {'invariant': invariant}})
        for pair in options.get('copyPairs', []):
            for source_field, target_field in pair.get('mapping', {}).items():
                if pair.get('targetEntity') + '.' + target_field == invariant.get('entity') + '.' + invariant.get('field'):
                    source = field_by_path(model, pair.get('sourceEntity'), source_field)
                    if source is not None and source.get('monotonic') is not None and source.get('monotonic') != invariant.get('direction'):
                        findings.append({'code': 'DA9_MONOTONIC_COPY_OPPOSITE', 'severity': 'warning', 'message': f"Copy {pair.get('id')} maps opposite-monotonic source into monotonic target", 'evidence': {'invariant': invariant, 'pair': pair}})
    return check_result('DA9', findings, 'Data monotonic')

def da10_data_sequence(model, options):
    findings = []
    registry = data_step_registry(options)
    for invariant in model.get('invariants', []):
        if invariant.get('kind') != 'sequence':
            continue
        for step in invariant.get('steps', []):
            if step not in registry:
                findings.append({'code': 'DA10_SEQUENCE_STEP_MISSING', 'severity': 'error', 'message': f"Sequence invariant {invariant.get('id')} references missing step {step}", 'evidence': {'invariant': invariant, 'step': step}})
    return check_result('DA10', findings, 'Data sequence')

def da11_data_leads_to(model, options):
    findings = []
    for invariant in model.get('invariants', []):
        if invariant.get('kind') != 'leads-to':
            continue
        field = field_by_path(model, invariant.get('entity'), invariant.get('field'))
        if field is None:
            findings.append({'code': 'DA11_LEADS_TO_FIELD_MISSING', 'severity': 'error', 'message': f"Leads-to invariant {invariant.get('id')} references missing field", 'evidence': {'invariant': invariant}})
            continue
        if field.get('enum'):
            if invariant.get('from') not in field['enum']:
                findings.append({'code': 'DA11_FROM_NOT_IN_ENUM', 'severity': 'warning', 'message': f"Leads-to from value {invariant.get('from')} not in enum", 'evidence': {'invariant': invariant}})
            if invariant.get('to') not in field['enum']:
                findings.append({'code': 'DA11_TO_NOT_IN_ENUM', 'severity': 'warning', 'message': f"Leads-to to value {invariant.get('to')} not in enum", 'evidence': {'invariant': invariant}})
    return check_result('DA11', findings, 'Data leads-to')

def da12_data_atomicity(model, options):
    findings = []
    registry = data_step_registry(options)
    for invariant in model.get('invariants', []):
        if invariant.get('kind') != 'atomicity':
            continue
        for step in invariant.get('steps', []):
            entry = registry.get(step)
            if entry is None:
                findings.append({'code': 'DA12_ATOMIC_STEP_MISSING', 'severity': 'error', 'message': f"Atomicity invariant {invariant.get('id')} references missing step {step}", 'evidence': {'invariant': invariant, 'step': step}})
                continue
            if entry.get('kind') == 'migration' and entry.get('transform') in ('drop', 'split', 'merge'):
                findings.append({'code': 'DA12_NON_ATOMIC_TRANSFORM', 'severity': 'warning', 'message': f"Atomic step {step} uses non-atomic transform {entry.get('transform')}", 'evidence': {'invariant': invariant, 'step': step}})
            if entry.get('kind') == 'copy' and entry.get('copyPair') is not None:
                pair = entry['copyPair']
                has_backup = any(bp.get('sourceEntity') == pair.get('sourceEntity') and bp.get('targetEntity') == pair.get('targetEntity') for bp in options.get('backupPairs', []))
                if not has_backup:
                    findings.append({'code': 'DA12_ATOMIC_COPY_NO_BACKUP', 'severity': 'warning', 'message': f"Atomic copy step {step} has no backup/restore pair", 'evidence': {'invariant': invariant, 'step': step}})
    return check_result('DA12', findings, 'Data atomicity')

def dd1_data_behavior_preservation(before, after, options):
    findings = []
    after_fields = {path: True for path in all_field_paths(after)}
    mapping = options.get('fieldMapping', {})
    migration_from = {m.get('from') for m in options.get('migrationMappings', [])}
    for path in all_field_paths(before):
        mapped = map_field(mapping, path)
        if mapped not in after_fields and path not in migration_from:
            findings.append({'code': 'DD1_FIELD_REMOVED', 'severity': 'error', 'message': f'BEFORE field {path} is missing in AFTER and has no migration mapping', 'evidence': {'beforeField': path, 'mapped': mapped}})
    return check_result('DD1', findings, 'Data behavior preservation')


def dd2_data_invariant_continuity(before, after, options):
    findings = []
    after_fields = set(all_field_paths(after))
    after_entities = {e.get('name') for e in after.get('entities', [])}
    mapping = options.get('fieldMapping', {})
    for invariant in before.get('invariants', []):
        kind = invariant.get('kind')
        if kind in ('field-required', 'range', 'no-orphan'):
            mapped = map_field(mapping, invariant.get('entity') + '.' + invariant.get('field'))
            if mapped not in after_fields:
                findings.append({'code': 'DD2_INVARIANT_FIELD_MISSING', 'severity': 'error', 'message': f"Invariant {invariant.get('id')} references missing field {mapped}", 'evidence': {'invariant': invariant, 'mappedField': mapped}})
        elif kind == 'unique':
            for field in invariant.get('fields', []):
                mapped = map_field(mapping, invariant.get('entity') + '.' + field)
                if mapped not in after_fields:
                    findings.append({'code': 'DD2_INVARIANT_FIELD_MISSING', 'severity': 'error', 'message': f"Invariant {invariant.get('id')} references missing field {mapped}", 'evidence': {'invariant': invariant, 'mappedField': mapped}})
        elif kind == 'referential-integrity':
            mapped = map_field(mapping, invariant.get('entity') + '.' + invariant.get('field'))
            if mapped not in after_fields:
                findings.append({'code': 'DD2_INVARIANT_FIELD_MISSING', 'severity': 'error', 'message': f"Invariant {invariant.get('id')} references missing field {mapped}", 'evidence': {'invariant': invariant, 'mappedField': mapped}})
            if invariant.get('refEntity') not in after_entities:
                findings.append({'code': 'DD2_INVARIANT_ENTITY_MISSING', 'severity': 'error', 'message': f"Invariant {invariant.get('id')} references missing entity {invariant.get('refEntity')}", 'evidence': {'invariant': invariant}})
        elif kind == 'count-equal':
            if invariant.get('sourceEntity') not in after_entities:
                findings.append({'code': 'DD2_INVARIANT_ENTITY_MISSING', 'severity': 'error', 'message': f"Invariant {invariant.get('id')} references missing source entity {invariant.get('sourceEntity')}", 'evidence': {'invariant': invariant}})
            if invariant.get('targetEntity') not in after_entities:
                findings.append({'code': 'DD2_INVARIANT_ENTITY_MISSING', 'severity': 'error', 'message': f"Invariant {invariant.get('id')} references missing target entity {invariant.get('targetEntity')}", 'evidence': {'invariant': invariant}})
        elif kind == 'field-equal':
            source_mapped = map_field(mapping, invariant.get('sourceEntity') + '.' + invariant.get('sourceField'))
            target_mapped = map_field(mapping, invariant.get('targetEntity') + '.' + invariant.get('targetField'))
            if source_mapped not in after_fields:
                findings.append({'code': 'DD2_INVARIANT_FIELD_MISSING', 'severity': 'error', 'message': f"Invariant {invariant.get('id')} references missing source field {source_mapped}", 'evidence': {'invariant': invariant, 'sourceMapped': source_mapped}})
            if target_mapped not in after_fields:
                findings.append({'code': 'DD2_INVARIANT_FIELD_MISSING', 'severity': 'error', 'message': f"Invariant {invariant.get('id')} references missing target field {target_mapped}", 'evidence': {'invariant': invariant, 'targetMapped': target_mapped}})
    return check_result('DD2', findings, 'Data invariant continuity')


def dd3_delta_summary(before, after, options):
    findings = []
    before_entities = {e.get('name') for e in before.get('entities', [])}
    after_entities = {e.get('name') for e in after.get('entities', [])}
    removed_entities = sorted(before_entities - after_entities)
    added_entities = sorted(after_entities - before_entities)
    mapping = options.get('fieldMapping', {})
    before_paths = set(all_field_paths(before))
    after_paths = set(all_field_paths(after))
    removed_fields = []
    for path in before_paths:
        if map_field(mapping, path) not in after_paths:
            removed_fields.append(path)
    added_fields = []
    for path in after_paths:
        if not any(map_field(mapping, before_path) == path for before_path in before_paths):
            added_fields.append(path)
    for entity in removed_entities:
        findings.append({'code': 'DD3_REMOVED_ENTITY', 'severity': 'warning', 'message': f'BEFORE entity {entity} is not present in AFTER', 'evidence': {'entity': entity}})
    for field in removed_fields:
        findings.append({'code': 'DD3_REMOVED_FIELD', 'severity': 'warning', 'message': f'BEFORE field {field} is not present in AFTER', 'evidence': {'field': field}})
    detail = f"Delta: +{len(added_entities)} entities, -{len(removed_entities)} entities, +{len(added_fields)} fields, -{len(removed_fields)} fields"
    return check_result('DD3', findings, detail)


def dd4_breaking_change_regression(before, after, options):
    findings = []
    after_field_map = {}
    for path in all_field_paths(after):
        entity_name, field_name = path.split('.', 1)
        after_field_map[path] = field_by_path(after, entity_name, field_name)
    mapping = options.get('fieldMapping', {})
    migration_from = {m.get('from') for m in options.get('migrationMappings', [])}
    for entity in before.get('entities', []):
        for field in entity.get('fields', []):
            path = entity.get('name') + '.' + field.get('name')
            mapped = map_field(mapping, path)
            after_field = after_field_map.get(mapped)
            if after_field is None:
                if field.get('required') is True and path not in migration_from:
                    findings.append({'code': 'DD4_REQUIRED_FIELD_REMOVED', 'severity': 'error', 'message': f'Required field {path} was removed without migration mapping', 'evidence': {'beforeField': path}})
                continue
            if field.get('required') is not True and after_field.get('required') is True and path not in migration_from:
                findings.append({'code': 'DD4_OPTIONAL_BECAME_REQUIRED', 'severity': 'warning', 'message': f'Optional field {path} became required in AFTER', 'evidence': {'beforeField': path, 'afterField': mapped}})
            if field.get('nullable') is not False and after_field.get('nullable') is False and path not in migration_from:
                findings.append({'code': 'DD4_NULLABLE_BECAME_NOT_NULL', 'severity': 'warning', 'message': f'Nullable field {path} became non-nullable in AFTER', 'evidence': {'beforeField': path, 'afterField': mapped}})
            if field.get('type') != after_field.get('type') and path not in migration_from:
                findings.append({'code': 'DD4_TYPE_CHANGED', 'severity': 'warning', 'message': f'Field type changed for {path}', 'evidence': {'beforeField': path, 'beforeType': field.get('type'), 'afterType': after_field.get('type')}})
    return check_result('DD4', findings, 'Breaking change regression')


def run_checks(model, options):
    checks = [
        ds1_schema_well_formed(model),
        ds2_required_completeness(model, options),
        ds3_relationship_integrity(model),
        ds4_type_nullability_consistency(model),
        da1_null_empty_injection(model),
        da2_boundary_blast(model),
        da3_uniqueness_violation(model),
        da4_referential_integrity_violation(model),
        da5_migration_coverage(model, options),
        da6_copy_consistency(model, options),
        da7_rollback_backup_symmetry(model, options),
        da8_idempotent_constraints(model, options),
        da9_data_monotonic(model, options),
        da10_data_sequence(model, options),
        da11_data_leads_to(model, options),
        da12_data_atomicity(model, options),
    ]
    if options.get('beforeModel') is not None:
        checks.extend([
            dd1_data_behavior_preservation(options['beforeModel'], model, options),
            dd2_data_invariant_continuity(options['beforeModel'], model, options),
            dd3_delta_summary(options['beforeModel'], model, options),
            dd4_breaking_change_regression(options['beforeModel'], model, options),
        ])
    return checks


def main():
    parser = argparse.ArgumentParser(description='DataModelV1 verification harness')
    parser.add_argument('--model', required=True, help='Path to AFTER DataModelV1 JSON file')
    parser.add_argument('--before-model', help='Path to BEFORE DataModelV1 JSON file')
    parser.add_argument('--field-mapping', help='Path to field mapping JSON object')
    parser.add_argument('--copy-pairs', help='Path to copy pairs JSON array')
    parser.add_argument('--migration-mappings', help='Path to migration mappings JSON array')
    parser.add_argument('--backup-pairs', help='Path to backup pairs JSON array')
    args = parser.parse_args()

    model = load_json(args.model)
    options = {}
    if args.before_model:
        options['beforeModel'] = load_json(args.before_model)
    if args.field_mapping:
        options['fieldMapping'] = load_json(args.field_mapping)
    if args.copy_pairs:
        options['copyPairs'] = load_json(args.copy_pairs)
    if args.migration_mappings:
        options['migrationMappings'] = load_json(args.migration_mappings)
    if args.backup_pairs:
        options['backupPairs'] = load_json(args.backup_pairs)

    checks = run_checks(model, options)
    errors = sum(check['errors'] for check in checks)
    warnings = sum(check['warnings'] for check in checks)

    print('=' * 60)
    print('DATA MODEL VERIFICATION REPORT')
    print('=' * 60)
    for check in checks:
        status = 'PASS' if not check['findings'] else 'FAIL'
        print(f"[{status}] {check['id']}: {check['detail']}")
        for finding in check['findings']:
            print(f"  - [{finding['severity']}] {finding['code']}: {finding['message']}")
    print('=' * 60)
    print(f'SUMMARY: {errors} errors, {warnings} warnings')
    print('=' * 60)
    sys.exit(1 if errors > 0 else 0)


if __name__ == '__main__':
    main()
