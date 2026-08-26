# DSH Model Schema v1 — logicprobe_verify

The dsh-native `logicprobe_verify` tool accepts a structured JSON model. The engine runs 14 checks (S1-S7 structural, A1-A7 adversarial) and returns a JSON report. When `beforeModel` is supplied, it also runs D1-D4 before/after regression checks. Guards and updates are structured data — no code strings, no arbitrary execution.

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
  "resourcePairs": []
}
```

| Field | Required | Meaning |
|---|---|---|
| `schemaVersion` | yes | Must be `1` |
| `init` | yes | Initial state id |
| `states` | yes | `{ id, terminal? }`; `terminal` exempts S2/S3/S5/A1 |
| `transitions` | yes | `{ from, event, to, guard?, updates? }` |
| `variables` | no | `{ name, kind: integer\|boolean, init, min?, max? }` |
| `invariants` | no | See invariant kinds below |
| `concurrentPairs` | no | `["eventA", "eventB"]` pairs for A2 |
| `boundaryChecks` | no | `{ variable, values: number[] }` for A5 |
| `resourcePairs` | no | `{ resource, acquireEvent, releaseEvent, failEvent? }` for A4/A6 |

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

A7 reports the shortest violating path for each failed invariant. An empty path means the initial state already violates it.

## Permission presets and interaction mode

| Preset | sandbox | approval | logicprobe behavior |
|---|---|---|---|
| `workspace-write` | workspace-write | ask | Evidence stays in workspace; model confirmation defaults to ask |
| `danger-full-access` | danger-full-access | never | Full file access; interaction resolves to auto; never request sandbox escalation |
| custom | any | any | The session folds the last `sandbox/mode` and `approval/policy` events; interaction follows approval only |

In `interaction=auto`, do NOT call `ask_user_question` for model confirmation. Round-trip the extracted model into a transition table, compare it against the source extraction, and mark the report `UNCONFIRMED`.

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

When `beforeModel` is passed to `logicprobe_verify`, the engine treats `model` as AFTER and runs four extra checks after S1-A7:

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

## Limits

- State-space exploration caps at `maxStates` (default 10000); larger guards/domains may report truncation instead of a false pass.
- A3 samples the first `maxPermutationEvents` events (default 5).
- The engine is a finite-state model checker. It cannot prove properties of the real implementation; follow with code-level review.
