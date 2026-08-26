# Data Model Manual Verification Mode

Use this when neither the DSH `logicprobe_datamodel_verify` tool nor Python is available. It mirrors the automated DS/DA/DD checks as a structured checklist.

## 1. Extract the DataModelV1 table

For every entity, list fields, types, nullability, required, unique, primary key, and relationships.

```text
Entity   | Field      | Type    | Required | Unique | Nullable | Notes
---------|------------|---------|----------|--------|----------|-------
User     | id         | uuid    | yes      | yes    | no       | PK
User     | email      | string  | yes      | yes    | no       |
Order    | userId     | uuid    | yes      | no     | no       | FK -> User.id
```

## 2. Structural checklist (DS1-DS4)

- [ ] Entity names are unique.
- [ ] Field names are unique within each entity.
- [ ] Primary key and unique key fields exist.
- [ ] Required fields are not nullable.
- [ ] Relationship targets exist.
- [ ] `onDelete` values are valid.
- [ ] `min <= max`, `minLength <= maxLength`.

## 3. Adversarial checklist (DA1-DA7)

- [ ] Null cannot be injected into required fields.
- [ ] Empty strings are rejected for required string fields.
- [ ] Boundary values outside min/max are rejected.
- [ ] Unique/primary key fields are not nullable.
- [ ] Referenced fields have compatible types.
- [ ] Every removed/renamed field has a migration mapping.
- [ ] Every required target field in a copy pair is mapped.
- [ ] Every copy pair has a matching backup/restore pair.

## 4. Before/after checklist (DD1-DD4)

- [ ] Every BEFORE required field still exists in AFTER or has a migration mapping.
- [ ] BEFORE data invariants still hold in AFTER.
- [ ] Added/removed entities, fields, relationships are listed.
- [ ] No new breaking changes: removed required field, optional→required, nullable→non-null, type narrowing, added unique constraint.

## 5. Output

Append a summary to the plan file:

```markdown
## Data Model Verification

- **Depth**: LIGHTWEIGHT / STANDARD / ESCALATED
- **Checks**: [list DS/DA/DD checks performed]
- **Findings**: [list]
- **Confirmed**: yes / UNCONFIRMED
```
