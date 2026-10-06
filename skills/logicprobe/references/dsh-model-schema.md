# DSH Model Schema v1 — logicprobe_verify

The dsh-native `logicprobe_verify` tool accepts a structured JSON model. The engine runs 22 checks (S1-S8 structural, A1-A14) and returns a JSON report. When `beforeModel` is supplied, it also runs D1-D4 before/after regression checks. Guards and updates are structured data — no code strings, no arbitrary execution.

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
| `states` | yes | `{ id, terminal?, onEntry?, onExit?, maxTicks? }`; `terminal` exempts S2/S3/S5/A1; `onEntry`/`onExit` are action-name lists fired on entry/exit and treated by A4 as implicit acquire/release; `maxTicks` is an A14 deadline since entry (needs top-level `tickEvents`) |
| `transitions` | yes | `{ from, event, to, guard?, updates?, cost?, weight? }`; `cost` (non-negative, absent = 1) is checked by A12 against `budget` invariants; `weight` (non-negative, absent = 1) makes the machine a DTMC under A13 `probability` invariants |
| `variables` | no | `{ name, kind: integer\|boolean, init, min?, max?, monotonic? }` |
| `invariants` | no | See invariant kinds below |
| `concurrentPairs` | no | `["eventA", "eventB"]` pairs for A2 |
| `boundaryChecks` | no | `{ variable, values: number[] }` for A5 |
| `resourcePairs` | no | `{ resource, acquireEvent, releaseEvent, failEvent? }` for A4/A6 |
| `idempotentEvents` | no | Events that must be replay-safe; verified by A8 |
| `narrative` | no | Natural-language descriptions of states, events, and (state, event) scenarios — echoed in the report |

### The schema is closed

Every object in the model declares a fixed key set, and **an undeclared key is a validation error, never silently ignored**. This is a correctness requirement, not strictness for its own sake: a mistyped field name used to be dropped while the reported result still looked authoritative. The concrete regression this prevents — `{"kind": "var-in-range", "variable": "c", "maximum": 0}` (note `maximum` for `max`) validated cleanly and reported `errors: 0, S7: pass`, turning a range that must fail into a vacuously true invariant. The same class of typo applies to `states` vs `state` on a `never-states` invariant, `guard` vs `gaurd` on a transition, `updates` vs `update`, and so on.

Declared keys per part:

| Part | Allowed keys |
|---|---|
| model | `schemaVersion, init, states, transitions, variables, invariants, concurrentPairs, boundaryChecks, resourcePairs, idempotentEvents, tickEvents, narrative` |
| state | `id, terminal, onEntry, onExit, maxTicks` |
| transition | `from, event, to, guard, updates, cost, weight` |
| update | `variable, op, value` |
| variable | `name, kind, init, min, max, monotonic` |
| boundaryCheck | `variable, values` |
| resourcePair | `resource, acquireEvent, releaseEvent, failEvent` |
| narrative | `states, events, scenarios` |
| scenario | `from, event, scenario` |
| invariant | per kind — see [Invariants](#invariants) |

`boundaryChecks` is the one place where two schemas share a field name: `logicprobe_verify` uses `{ variable, values }` (a variable's boundary values for A5), while `logicprobe_datamodel_verify` uses `{ entity, field, values }` (a field's boundary values for DA2). Each validator enforces its own shape, so an `(entity, field)` check passed to the state-machine engine is rejected rather than half-understood.

### References must resolve

The same reasoning applies to every id a check names. A reference to a state, event, or variable that the model does not declare cannot be satisfied, and because the engine copies each check's target into its findings (`"target": "DONE"`), an unresolvable id reads as authoritative in the report:

| Reference | Must name |
|---|---|
| `states[].id`, `init` | a declared state (unique) |
| `transitions[].from` / `.to` | a declared state |
| `transitions[].updates[].variable`, `boundaryChecks[].variable` | a declared variable |
| `transitions[].guard` variables | a declared variable |
| `resourcePairs[].acquireEvent` / `.releaseEvent` / `.failEvent` | a declared event |
| `invariants[].event` (`event-before-state`) | a declared event |
| `invariants[].state` / `.states[]` / `.from` / `.target` / `.when.state` | a declared state |
| `invariants[].to` and every member of `invariants[].to[]` (`leads-to`) | a declared state |

A vacuous check is worse than a rejected one: a `leads-to` invariant whose `to` state is misspelled can never be violated, and a `never-states` list holding a nonexistent id can never be reached, so both report "pass" for a model that was never actually checked.

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
| `var-in-range` | `{ variable, min?, max?, when? }` | Every reachable runtime state selected by `when` keeps the variable in range (at least one of `min`/`max` is required) |
| `event-before-state` | `{ event: "power_ready", state: "ACTIVE" }` | Every path entering `state` must have passed through `event` first |
| `leads-to` | `{ from: "MIGRATING", to: "DONE" }`, or `to: ["DONE", "FAILED"]` | Every path from `from` must eventually reach `to`. With a target set, every path must reach at least one member. The set must be non-empty and free of duplicates |
| `sequence` | `{ events: ["backup", "modify", "commit"] }` | Events must occur in the given order |
| `atomicity` | `{ events: ["write"], commit: "commit", rollback?: "rollback" }` | Atomic group must end with commit/rollback before leaving scope |
| `budget` | `{ budget: n }` | No reachable path may accumulate transition cost greater than n (A12). Costs are non-negative; a transition without `cost` counts 1, so legacy machines keep step-count semantics |
| `probability` | `{ target, op: one of >= <= > <, p }` | P(ever hitting target) must satisfy the bound (A13, DTMC from transition `weight`, default 1; value iteration) |

A7 reports the shortest violating path for each failed invariant. An empty path means the initial state already violates it.

### Scoping a range to a state (`when`)

`var-in-range` is the only kind that accepts `when`, and only it needs to: the others either already constrain a state set (`never-states`) or assert a property of a whole path (`leads-to`, `sequence`, `atomicity`, `budget`, `probability`), where "the scope applies at which step of the path" has no single answer. A `when` on any other kind is a validation error rather than a silently ignored field.

```json
{ "id": "depth-in-probe", "description": "probe depth stays bounded while in PROBE",
  "kind": "var-in-range", "variable": "depth", "min": 0, "max": 4,
  "when": { "state": "PROBE" } }
```

Two scope shapes are accepted:

- `{ "state": "PROBE" }` — the state-scoped form, for "this range applies only here".
- a guard node (`{ variable, op, value }` / `{ all }` / `{ any }` / `{ not }`) — for "this range applies only while a mode variable says so". It must not reference the constrained variable itself: a scope that depends on the value it constrains can switch itself off exactly when the value drifts out of range, which masks its own violation.

Semantics — `when` is evaluated against the **post-state** of every transition, and the **initial state is checked unconditionally** whatever the scope says. So a `{ state }` scope is exhaustive over that state: for every reachable runtime state whose id is in the scope, the variable is in range, including the case where the machine starts there. This is why scoping away from the state that actually violates the range is not a loophole — it simply produces a machine in which no reachable in-scope state is out of range, i.e. an invariant that holds.

`when` participates in the model hash, so two models differing only in scope are never treated as the same model in before/after comparison; a `{ state }` scope also follows `stateMapping` during D2 continuity checks.

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

## Probability reachability (A13)

Declare `weight` on transitions (default 1) to interpret the machine as a DTMC, then add a `probability` invariant:

```json
{ "id": "reliability", "description": "at least 90% of runs reach SAFE", "kind": "probability", "target": "SAFE", "op": ">=", "p": 0.9 }
```

A13 computes P(ever hitting `target`) from the initial state by value iteration over the absorbing chain (transitions with `weight` 0 never fire; terminals other than the target are absorbing failures) and reports a violation when the bound fails. Converges to the least fixed point; an iteration cap protects against non-convergent models.

## Deadline check (A14)

Declare which events advance the discrete clock (`tickEvents`) and set `maxTicks` on a state that must be left within that many ticks of entering it:

```json
{ "schemaVersion": 1, "init": "LISTEN", "states": [{ "id": "LISTEN" }, { "id": "CRITICAL", "maxTicks": 2 }, { "id": "SAFE", "terminal": true }], "transitions": [ { "from": "LISTEN", "event": "fault", "to": "CRITICAL" }, { "from": "CRITICAL", "event": "recover", "to": "SAFE" } ], "tickEvents": ["tick"] }
```

A14 explores residency with a per-entry tick counter: a `tickEvents` step that keeps the machine resident past `maxTicks` reports `A14_DEADLINE_MISS` with the over-residency path. Time advances only when a tick event fires — real-time passage (auto-advancing clocks) is not modeled; dense-time claims still route to timed model checkers. States declaring `maxTicks` without any `tickEvents` yield the advisory `A14_NO_TICK_EVENTS`.

## State entry/exit actions (onEntry / onExit)

States may declare ordered action-name lists that fire automatically:

```json
{ "id": "ACTIVE", "onEntry": ["sync_lock"], "onExit": ["sync_unlock"] }
```

Actions never change state or variables. Checks that care about resource discipline see them as implicit events: A4 Pair Symmetry treats an action equal to a pair acquireEvent/releaseEvent as an acquire/release that fires on every entry (resp. exit) of the state, so lock/unlock hidden inside entry/exit actions is verified without hand-written ENTER_x/EXIT_x pseudo-events.

## Composition verification

Two or more machines can be checked together with `runCompositionVerification` (DSH tool `logicprobe_compose_verify`):

- non-rendezvous events advance exactly one firing machine;
- a rendezvous (handshake) event fires only when at least two machines declare it and every such non-terminal machine has it jointly enabled (guards held); participants advance simultaneously;
- a terminal machine is stopped and does not participate.

Checks: `C1_COMPOSITION_DEADLOCK` (a reachable composite state with no move while at least one machine is not terminal) and `C2_RENDEZVOUS_NEVER_FIRES`. This is a product-space BFS, so composite state count is the product of the machines; keep `maxStates` in mind.

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

## Advanced constraints (S8, A9-A14)

- **S8 Monotonic Variables**: declare `monotonic: "inc"|"dec"` on a variable; updates must not move in the opposite direction.
- **A9 Leads-To**: `{ kind: "leads-to", from, to }` — every path from `from` must eventually reach `to`. `to` is one state id or a non-empty array of state ids for "reach any one of these"; a duplicated member is a validation error rather than a shorthand. Either way the property stays universal: one branch that loops forever, or that stops before every target, refutes it.
- **A10 Sequence**: `{ kind: "sequence", events }` — events must appear in order.
- **A11 Atomicity**: `{ kind: "atomicity", events, commit, rollback? }` — once an atomic event starts, the machine must reach commit/rollback before leaving the atomic scope or terminating.
- **A12 Budget**: `{ kind: "budget", budget }` — no reachable path may accumulate transition cost above the budget; reports the shortest over-budget path and flags reachable positive-cost cycles as unbounded.
- **A13 Probability**: `{ kind: "probability", target, op, p }` — P(ever hitting target) must satisfy the bound under the DTMC induced by transition `weight` (default 1).
- **A14 Deadline**: state `maxTicks` + top-level `tickEvents` — a tick step may not keep a state resident past its deadline; reports the over-residency path.

## Limits

- State-space exploration caps at `maxStates` (default 10000); larger guards/domains may report truncation instead of a false pass.
- A3 samples the first `maxPermutationEvents` events (default 5).
- The engine is a finite-state model checker. It cannot prove properties of the real implementation; follow with code-level review.
- `cost` values are modeler-provided static labels — A12 verifies against them; real execution time/WCET needs binary-level timing analysis.
- When the model state/event/action names reference semantics the engine does not verify (timing, preemption, hybrid control, probability), the report carries informational `coverageNotes` that route such claims to dedicated tools. These notes are vocabulary-based heuristics, never a substitute for the checks.
