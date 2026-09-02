# DSH Model Schema v1 — logicprobe_verify

The dsh-native `logicprobe_verify` tool accepts a structured JSON model. The engine runs 20 checks (S1-S8 structural, A1-A12 adversarial) and returns a JSON report. When `beforeModel` is supplied, it also runs D1-D4 before/after regression checks. Guards and updates are structured data — no code strings, no arbitrary execution.

## Top-level model

```json
{
  "schemaVersion": 1,
  "init": "INIT",
  "states": [{ "id": "INIT" }, { "id": "ACTIVE", "terminal": true }],
  "transitions": [
    { "from": "INIT", "event": "go", "to": "ACTIVE" }
  ],
  "variables": [],
  "invariants": [],
  "concurrentPairs": [],
  "boundaryChecks": [],
  "resourcePairs": [],
  "idempotentEvents": []
}
```

| Field | Required | Meaning |
|---|---|---|
| `schemaVersion` | yes | Must be `1` |
| `init` | yes | Initial state id |
| `states` | yes | `{ id, terminal?, onEntry?, onExit? }`; `terminal` exempts S2/S3/S5/A1; `onEntry`/`onExit` are action-name lists fired on entry/exit and treated by A4 as implicit acquire/release |
| `transitions` | yes | `{ from, event, to, guard?, updates?, cost? }`; `cost` (non-negative) is the execution cost of firing the transition, absent = 1, checked by A12 against `budget` invariants |
| `variables` | no | `{ name, kind: integer\|boolean, init, min?, max?, monotonic? }` |
| `invariants` | no | See invariant kinds below |
| `concurrentPairs` | no | `["eventA", "eventB"]` pairs for A2 |
| `boundaryChecks` | no | `{ variable, values: number[] }` for A5 |
| `resourcePairs` | no | `{ resource, acquireEvent, releaseEvent, failEvent? }` for A4/A6 |
| `idempotentEvents` | no | Events that must be replay-safe; verified by A8 |
| `narrative` | no | Natural-language descriptions of states, events, and (state, event) scenarios — echoed in the report |

## Model narrative (natural-language context)

The model may carry a `narrative` block explaining, in natural language, what
every symbol means in the real scenario. It is what gets shown to the user when
the extracted model is presented for confirmation, and the report echoes it back
so findings can be read against real scenarios instead of bare ids.

```json
"narrative": {
  "states": {
    "NEW": "订单已创建，等待支付",
    "PAID": "已支付，等待发货",
    "SHIPPED": "已发货，等待签收",
    "DONE": "已完成（终态）",
    "CANCELLED": "已取消（终态）"
  },
  "events": {
    "pay": "买家完成支付",
    "ship": "仓库发货",
    "deliver": "买家签收",
    "cancel": "取消订单"
  },
  "scenarios": [
    { "from": "NEW", "event": "pay", "scenario": "下单后支付成功，订单进入待发货" },
    { "from": "PAID", "event": "ship", "scenario": "已支付订单发货，进入运输中" },
    { "from": "SHIPPED", "event": "deliver", "scenario": "签收完成，订单结束" },
    { "from": "NEW", "event": "cancel", "scenario": "未支付订单被取消" },
    { "from": "PAID", "event": "cancel", "scenario": "已支付订单取消并退款" }
  ]
}
```

**Completeness contract**: when `narrative` is present, all three parts are
required and must fully cover the model — every declared state needs a
`narrative.states` entry, every event used in `transitions` needs a
`narrative.events` entry, and every distinct `(from, event)` group needs a
`narrative.scenarios` entry. Keys must reference declared ids; unknown
references, missing coverage, and duplicate scenario keys are model validation
errors. The report's `narrative` field echoes the block unchanged.

**Presenting the model**: when showing the extracted model for confirmation, render
the natural language INLINE in the model presentation, not as a separate block.
Three rendering forms (all derive from the same `narrative` data):

- **Form A — integrated transition table (default)**: one row per transition with
  state/event meanings in parentheses and the scenario as the last column. Keep
  meanings short (state/event ≤ 6 characters, scenario ≤ 10) and estimate row
  width (CJK counts as 2) so rows fit the display area — a wrapped row loses
  column alignment and readability collapses.
- **Form B — sentence blocks (reading-accessible)**: scenario sentence first, then
  a fixed three-line frame (状态…/发生…/进入…). Use for detailed confirmation,
  users with reading difficulties, or ≤ 10 transitions.
- **Form C — grouped by source state (large machines / narrow panes)**: one
  section per state, each rendered as its own small 3-column table
  （`event（含义）| NEXT（含义）| 场景`）; no cross-group column alignment to
  track. Use for ≥ 15 transitions or narrow display areas; if a group table would
  still wrap, fall back to a one-line-per-event bullet list for that group.

## Guards

A guard is exactly one of:

```json
{ "variable": "retry", "op": "<", "value": 3 }
{ "all": [ { "variable": "armed", "op": "==", "value": true }, { "variable": "retry", "op": ">", "value": 0 } ] }
{ "any": [ { "variable": "mode", "op": "==", "value": 1 }, { "variable": "mode", "op": "==", "value": 2 } ] }
{ "not": { "variable": "locked", "op": "==", "value": true } }
```

- Boolean variables only support `==` / `!=`.
- A transition with **no guard** is the default/else branch for its `(from, event)` group. It fires only when no guarded branch in that group is true.
- Multiple true guards in one `(from, event)` group are reported as S4 nondeterminism; a group with guards and no default must be exhaustive or S6 flags the missing branch.

## Updates

```json
{ "variable": "retry", "op": "inc", "value": 1 }
{ "variable": "retry", "op": "set", "value": 0 }
{ "variable": "retry", "op": "dec", "value": 1 }
```

`inc`/`dec` default to 1 when `value` is omitted. `set` defaults to 0.

## Invariants

| Kind | Shape | Checks |
|---|---|---|
| `never-states` | `{ states: ["ERROR"] }` | No reachable runtime state may be in the forbidden set |
| `var-in-range` | `{ variable, min?, max? }` | Every reachable runtime state keeps the variable in range |
| `event-before-state` | `{ event: "power_ready", state: "ACTIVE" }` | Every path entering `state` must have passed through `event` first |
| `leads-to` | `{ from: "MIGRATING", to: "DONE" }` | Every path from `from` must eventually reach `to` |
| `sequence` | `{ events: ["backup", "modify", "commit"] }` | Events must occur in the given order |
| `atomicity` | `{ events: ["write"], commit: "commit", rollback?: "rollback" }` | Atomic group must end with commit/rollback before leaving scope |
| `budget` | `{ budget: n }` | No reachable path may accumulate transition cost greater than n (A12). Costs are non-negative; a transition without `cost` counts 1, so legacy machines keep step-count semantics |

A7 reports the shortest violating path for each failed invariant. An empty path means the initial state already violates it.

## Permission presets and interaction mode

| Preset | sandbox | approval | logicprobe behavior |
|---|---|---|---|
| `workspace-write` | workspace-write | ask | Evidence stays in workspace; model confirmation defaults to ask |
| `danger-full-access` | danger-full-access | never | Full file access; interaction resolves to auto; never request sandbox escalation |
| custom | any | any | The session folds the last `sandbox/mode` and `approval/policy` events; interaction follows approval only |

In `interaction=auto`, do NOT call `ask_user_question` for model confirmation. Round-trip the extracted model into a transition table, compare it against the source extraction, and mark the report `UNCONFIRMED`.

## Cost and budget (A12)

Transitions may carry a non-negative execution cost (`cost`, default 1 per transition — e.g. cycles or microseconds spent in the handler). A `budget` invariant bounds the worst-case accumulated cost over every reachable path:

```json
{
  "id": "dispatch-budget",
  "description": "worst-case dispatch path stays within 100 cycles",
  "kind": "budget",
  "budget": 100
}
```

A12 reports the shortest over-budget counterexample path. A reachable cycle whose cost is positive is reported as unbounded — under model event semantics it can repeat indefinitely, so no finite budget holds. Budgets on machines with repeatable loops must bound those loops with variables (e.g. a retry counter guard). If transitions declare `cost` but no `budget` invariant exists, A12 emits the advisory `A12_COST_WITHOUT_BUDGET`.

## State entry/exit actions (onEntry / onExit)

States may declare ordered action-name lists that fire automatically:

```json
{ "id": "ACTIVE", "onEntry": ["sync_lock"], "onExit": ["sync_unlock"] }
```

Actions never change state or variables. Checks that care about resource discipline see them as implicit events: A4 Pair Symmetry treats an action equal to a pair acquireEvent/releaseEvent as an acquire/release that fires on every entry (resp. exit) of the state, so lock/unlock hidden inside entry/exit actions is verified without hand-written ENTER_x/EXIT_x pseudo-events.

## Minimal example

```json
{
  "schemaVersion": 1,
  "init": "INIT",
  "states": [
    { "id": "INIT" },
    { "id": "RETRY" },
    { "id": "FATAL", "terminal": true }
  ],
  "transitions": [
    { "from": "INIT", "event": "timeout", "guard": { "variable": "retry", "op": "<", "value": 3 }, "to": "RETRY", "updates": [{ "variable": "retry", "op": "inc" }] },
    { "from": "INIT", "event": "timeout", "guard": { "variable": "retry", "op": ">=", "value": 3 }, "to": "FATAL" }
  ],
  "variables": [{ "name": "retry", "kind": "integer", "init": 0, "min": 0, "max": 3 }],
  "boundaryChecks": [{ "variable": "retry", "values": [0, 1, 2, 3] }]
}
```

## Before/after comparison (D1-D4)

When `beforeModel` is passed to `logicprobe_verify`, the engine treats `model` as AFTER and runs four extra checks after S1-A11:

| Check | Purpose |
|---|---|
| D1 Behavioral Preservation | Every BEFORE (state, event) that could fire must still be fireable from the mapped AFTER state |
| D2 Invariant Continuity | Every BEFORE invariant (mapped through `stateMapping`) must still hold in AFTER |
| D3 Regression Delta | Lists added/removed states, events, and transitions |
| D4 Deadlock/Liveness Regression | New deadlock states or closed SCCs not present in BEFORE |

`stateMapping` maps BEFORE state ids to AFTER state ids. Omit it when state names are unchanged.

Example tool call shape:

```json
{
  "model": { "...": "AFTER LogicModelV1" },
  "beforeModel": { "...": "BEFORE LogicModelV1" },
  "stateMapping": { "OLD_INIT": "INIT", "OLD_ACTIVE": "ACTIVE" }
}
```

The report's `comparison` object includes both model hashes, state/transition counts, and delta arrays.

## Idempotent replay (A8)

List events that must be idempotent in `idempotentEvents`. For every reachable state, applying the event twice must produce the same state as applying it once. This is useful for retries, webhook redelivery, and migration replay.

## Advanced constraints (S8, A9-A12)

- **S8 Monotonic Variables**: declare `monotonic: "inc"|"dec"` on a variable; updates must not move in the opposite direction.
- **A9 Leads-To**: `{ kind: "leads-to", from, to }` — every path from `from` must eventually reach `to`.
- **A10 Sequence**: `{ kind: "sequence", events }` — events must appear in order.
- **A11 Atomicity**: `{ kind: "atomicity", events, commit, rollback? }` — once an atomic event starts, the machine must reach commit/rollback before leaving the atomic scope or terminating.
- **A12 Budget**: `{ kind: "budget", budget }` — no reachable path may accumulate transition cost above the budget; reports the shortest over-budget path and flags reachable positive-cost cycles as unbounded.

## Limits

- State-space exploration caps at `maxStates` (default 10000); larger guards/domains may report truncation instead of a false pass.
- A3 samples the first `maxPermutationEvents` events (default 5).
- The engine is a finite-state model checker. It cannot prove properties of the real implementation; follow with code-level review.
- `cost` values are modeler-provided static labels — A12 verifies against them; real execution time/WCET needs binary-level timing analysis.
- When the model state/event/action names reference semantics the engine does not verify (timing, preemption, hybrid control, probability), the report carries informational `coverageNotes` that route such claims to dedicated tools. These notes are vocabulary-based heuristics, never a substitute for the checks.
