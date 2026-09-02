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

## Performance-sensitive control dispatcher

- `control-dispatcher.json` — a motor-mode / safety dispatch state machine (RESET → BOOT → READY → RUN/FAULT → SAFE/OFF). Every transition carries a `cost` (handler cost units) and a `budget` invariant bounds any mission path to 100; RUN declares `onEntry: ["sync_lock"]` / `onExit: ["sync_unlock"]` so A4 Pair Symmetry verifies the mode-register lock/unlock balance. Expected result: **0 errors** (worst path = 90 ≤ 100). The `watchdog_expiry` name also demos the informational `coverageNotes` (timing vocabulary routed to UPPAAL-class tools).
- `control-dispatcher.overbudget.json` — the same machine with a slower watchdog handler (cost 60 instead of 15), pushing the fault path to 135 > 100. Expected: **one `A12_BUDGET_OVER` error** with the shortest over-budget path `power_ok → calibrate_done → engage → watchdog_expiry`.

Run:

```bash
# DSH tool
logicprobe_verify model=examples/control-dispatcher.json
logicprobe_verify model=examples/control-dispatcher.overbudget.json
```

Fields used: transition `cost` (absent defaults to 1), invariant `kind: "budget"` (A12), state `onEntry`/`onExit` action lists (A4). Schema details in `skills/logicprobe/references/dsh-model-schema.md`.

## Data model

- `ecommerce-data-model.json` — classic e-commerce schema
- `user-migration.before.json` / `user-migration.after.json` — field rename migration

Run data-model verification:

```bash
# DSH tool
logicprobe_datamodel_verify model=examples/user-migration.after.json beforeModel=examples/user-migration.before.json fieldMapping={"User.name":"User.fullName"}
```
