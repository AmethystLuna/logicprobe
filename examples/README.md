# Examples

Sample models for testing logicprobe and logicprobe-datamodel.

## State machine

- `order-state-machine.before.json` — order processing BEFORE model
- `order-state-machine.after.json` — AFTER model with an added VERIFY step

Both order examples include a `narrative` block that explains every state, every
event, and every (state, event) scenario in natural language — the model as shown
to the user before verification.

Run D1-D4 comparison:

```bash
# DSH tool
logicprobe_verify model=examples/order-state-machine.after.json beforeModel=examples/order-state-machine.before.json
```

## Data model

- `ecommerce-data-model.json` — classic e-commerce schema
- `user-migration.before.json` / `user-migration.after.json` — field rename migration

Run data-model verification:

```bash
# DSH tool
logicprobe_datamodel_verify model=examples/user-migration.after.json beforeModel=examples/user-migration.before.json fieldMapping={"User.name":"User.fullName"}
```
