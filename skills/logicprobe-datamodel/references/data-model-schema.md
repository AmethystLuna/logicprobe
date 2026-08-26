# DataModelV1 — logicprobe-datamodel Schema

The `logicprobe_datamodel_verify` tool accepts a structured JSON data model. The engine runs DS/DA checks, and DD1-DD4 when `beforeModel` is supplied. It is host-agnostic; DSH uses the native tool, non-DSH hosts use `data-model-harness.py`.

## Top-level model

```json
{
  "schemaVersion": 1,
  "entities": [
    {
      "name": "User",
      "fields": [
        { "name": "id", "type": "uuid", "required": true, "unique": true },
        { "name": "email", "type": "string", "required": true, "unique": true }
      ],
      "primaryKey": ["id"]
    }
  ],
  "relationships": [
    { "fromEntity": "Order", "fromField": "userId", "toEntity": "User", "toField": "id", "onDelete": "restrict" }
  ],
  "invariants": [],
  "boundaryChecks": []
}
```

| Field | Required | Meaning |
|---|---|---|
| `schemaVersion` | yes | Must be `1` |
| `entities` | yes | `{ name, fields, primaryKey?, uniqueKeys?, indexes? }` |
| `relationships` | no | `{ fromEntity, fromField, toEntity, toField?, onDelete? }` |
| `invariants` | no | See invariant kinds below |
| `boundaryChecks` | no | `{ entity, field, values? }` for DA2 |

## Field

```json
{
  "name": "age",
  "type": "integer",
  "required": true,
  "unique": false,
  "nullable": false,
  "default": 0,
  "min": 0,
  "max": 150,
  "minLength": null,
  "maxLength": null,
  "pattern": null,
  "enum": null,
  "ref": null,
  "items": null
}
```

Supported `type` values: `string`, `integer`, `number`, `boolean`, `uuid`, `date`, `datetime`, `timestamp`, `json`, `enum`, `array`, `object`, `binary`, or any custom non-empty type name.

## Invariants

| Kind | Shape | Checks |
|---|---|---|
| `field-required` | `{ entity, field }` | Field must be required |
| `unique` | `{ entity, fields: [] }` | Unique constraint must exist |
| `referential-integrity` | `{ entity, field, refEntity, refField? }` | Reference target must exist |
| `range` | `{ entity, field, min?, max? }` | Range must be respected |
| `count-equal` | `{ sourceEntity, targetEntity }` | Source/target counts must match |
| `field-equal` | `{ sourceEntity, sourceField, targetEntity, targetField }` | Two fields must be equal |
| `no-orphan` | `{ entity, field, refEntity }` | No dangling references |

## Tool arguments

```json
{
  "model": { "...": "AFTER DataModelV1" },
  "beforeModel": { "...": "BEFORE DataModelV1" },
  "fieldMapping": { "User.name": "User.fullName" },
  "copyPairs": [
    { "id": "c1", "sourceEntity": "Source", "targetEntity": "Target", "mapping": { "a": "x" } }
  ],
  "migrationMappings": [
    { "from": "User.name", "to": "User.fullName", "transform": "rename" }
  ],
  "backupPairs": [
    { "id": "b1", "sourceEntity": "Source", "targetEntity": "Target", "mapping": { "x": "a" } }
  ]
}
```

## Checks

- **DS1-DS4**: schema well-formedness, required-field completeness, relationship integrity, type/nullability consistency
- **DA1-DA7**: null/empty injection, boundary blast, uniqueness, referential integrity, migration coverage, copy consistency, rollback/backup symmetry
- **DD1-DD4**: data behavior preservation, data invariant continuity, delta summary, breaking-change regression

## Minimal example

```json
{
  "schemaVersion": 1,
  "entities": [
    {
      "name": "User",
      "fields": [
        { "name": "id", "type": "uuid", "required": true },
        { "name": "age", "type": "integer", "min": 0, "max": 150 }
      ],
      "primaryKey": ["id"]
    }
  ],
  "boundaryChecks": [
    { "entity": "User", "field": "age", "values": [-1, 0, 150, 151] }
  ]
}
```

## Limits

- The engine is a design-time static verifier. It does not execute against a live database.
- Data invariants like `count-equal` and `field-equal` are checked structurally (referenced entities/fields exist) unless sample data is provided in a future version.
- Follow with runtime tools (Great Expectations, Soda, Pandera) for live data validation.
