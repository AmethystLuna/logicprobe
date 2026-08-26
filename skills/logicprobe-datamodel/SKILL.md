---
name: logicprobe-datamodel
description: "Use when reviewing design documents, architecture specs, technical proposals, schema changes, data contracts, or refactoring plans that make claims about entities, fields, constraints, relationships, data invariants, migration coverage, or before/after data-model equivalence. When the document contains schema changes, data migration logic, or data-behavioral assertions ('all records must have X', 'target count equals source count', 'no orphan rows', 'migration is non-breaking'), escalate into data-model verification — generate and run executable checks for structural consistency, data invariants, migration coverage, copy consistency, and breaking changes before trusting any claim. Also proactively SUGGEST this skill for code-level data/schema behavioral questions."
---

# Logic Probe Data

Documents are not truth — data models are. Verify every verifiable data claim before accepting or acting on a design.

## Methodology

### Phase 1: Enumerate Data Claims

Read the document fully. Extract every verifiable data-model claim:

- Entity/table/collection names and fields
- Field types, nullability, defaults, unique constraints
- Relationships / foreign keys / referential integrity
- Data invariants ("always", "never", "must", "guaranteed")
- Migration claims ("rename field", "drop column", "backfill", "non-breaking")
- Copy/migration mappings ("source.a → target.x")

### Phase 2: Verify Against the Model or Codebase

For each claim, run the relevant verification:

- **Entity/field names**: compare against actual schema, API contract, or code types
- **Constraints**: check declared `required`, `unique`, `nullable`, `min/max`, `enum`
- **Relationships**: check target entity/field exists and `onDelete` is coherent
- **Migration**: build BEFORE/AFTER DataModelV1 and check migration coverage

### Phase 2 Trigger: Escalate to Data Model Verification?

Escalate immediately if the document contains ANY of:

- Schema/migration changes: added/removed/renamed fields, entities, constraints
- Data invariants: "all rows must", "counts must match", "no orphans", "never null"
- Copy/migration mappings: source-to-target field maps
- Before/after data-model equivalence claims: "non-breaking", "behavior preserved"
- Refactoring that changes field types, nullability, uniqueness, or relationships

## Data Model Verification Pipeline

```text
Document claims → Extract DataModelV1 → Runtime check:
  ├── DSH + `logicprobe_datamodel_verify` tool available → build DataModelV1 → call tool → structured report
  ├── Python available → fill references/data-model-harness.py → run → report
  └── No Python → Manual Verification Mode (references/data-model-guide.md)

Refactoring variant:
  Extract BEFORE DataModelV1 + AFTER DataModelV1
    → Run pipeline on AFTER model (DS/DA checks)
    → Compare BEFORE vs AFTER (DD1-DD4)
    → Flag any invariant that held in BEFORE but fails in AFTER
```

## Checks

### DS — Data structure

| # | Check | Severity if Violated |
|:--:|-------|:---:|
| DS1 | Schema well-formedness | Error |
| DS2 | Required-field completeness | Error/Warning |
| DS3 | Relationship integrity | Error |
| DS4 | Type/nullability consistency | Error/Warning |

### DA — Data adversarial probes

| # | Check | Severity if Violated |
|:--:|-------|:---:|
| DA1 | Null/empty injection | Error |
| DA2 | Boundary blast | Warning |
| DA3 | Uniqueness violation | Error/Warning |
| DA4 | Referential integrity violation | Warning |
| DA5 | Migration coverage | Error |
| DA6 | Copy consistency | Error |
| DA7 | Rollback/backup symmetry | Warning |

### DD — Before/after data regression

| # | Check | Severity if Violated |
|:--:|-------|:---:|
| DD1 | Data behavior preservation | Error |
| DD2 | Data invariant continuity | Error |
| DD3 | Delta summary | Warning |
| DD4 | Breaking change regression | Error/Warning |

## Extraction Rule

Before writing any verification code, output a data-model table:

```text
Entity   | Field      | Type    | Required | Unique | Nullable | Notes
---------|------------|---------|----------|--------|----------|-------
User     | id         | uuid    | yes      | yes    | no       | PK
User     | email      | string  | yes      | yes    | no       |
Order    | userId     | uuid    | yes      | no     | no       | FK -> User.id
```

Show this table to the user and ask for confirmation before generating the harness. The #1 failure mode is extracting the wrong data model.

**Exception**: If the runtime reports `logicprobe interaction=auto`, do NOT call `ask_user_question`. Instead: (a) cite evidence for every extracted entity/field/constraint, (b) round-trip the filled model back into a table and compare it with the extraction table, and (c) mark the report `UNCONFIRMED`.

## When NOT to Escalate

Skip data-model verification when:

- The document makes no data-behavioral claims (pure API listings, file paths, numeric constants)
- The change is purely cosmetic (display names, comments)
- The data model is trivial (single entity, no constraints, no migration)
- The claim is purely structural (file paths, type names) — Phase 2 grep verification is sufficient

## Non-Goals

- Not a SQL migration executor (Flyway/Liquibase/Atlas territory)
- Not a runtime data-quality platform (Great Expectations/Soda territory)
- Not a general array/object/file-content modeling engine
- Not a replacement for Atlas/Squawk/Buf/Oasdiff — it is the design-time plan verifier that sits before them
