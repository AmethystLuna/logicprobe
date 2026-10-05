# UML Modelling Guide

Deep reference for modelling a code flow as UML and then reviewing that modelling. Load
this when the task is "draw the flow" rather than "check this claim": reverse-engineering a
handler, documenting a protocol, walking an unfamiliar state machine, or auditing a diagram
somebody else drew.

The rule this guide enforces: **a diagram is a model, and a model can be wrong.** A flow
chart that looks tidy is not evidence that the code behaves that way, and a UML model that
does not match the model you verify against is worse than no diagram — it puts a plausible
picture in front of a reader who will believe it.

## When to use this

| Situation | View that answers it |
|---|---|
| "What are the states of this handler and what moves between them?" | State machine |
| "What does this function actually do, step by step, including error paths?" | Activity (flow) |
| "In what order do these messages/events arrive, and what is the state after each?" | Sequence |
| "Someone gave me a diagram — is it right?" | Any; feed it to the review and compare against code |
| "This diagram and this model disagree" | Feed both to the review: the round-trip check names every difference |

Do **not** reach for UML when the question is a behavioural claim about a specific machine —
that is `logicprobe_verify`'s job (S1-S8 / A1-A14). The review here checks the modelling, not
the behaviour, and every finding says which engine check settles the behavioural half.

## The three views

One machine, three projections. They are not interchangeable, and the differences are the
reason the review reports which view it saw.

- **State machine** (`stateDiagram-v2` / PlantUML state) — the whole topology: every state,
  every (event, guard) branch, terminal states as `--> [*]`. This is the view to model code
  flow into, and the only view that round-trips without loss. Use it for review.
- **Activity** (`flowchart TD` in Mermaid) — the same machine drawn as work rather than as
  states, with `event [guard] / actions` on each edge. Better for a reader who thinks in
  steps; same information. PlantUML activity is **not** generated: its structured-flowchart
  syntax needs a while/if reconstruction for any graph with a merge or a cycle, and a
  diagram that quietly reshapes the machine is exactly the failure this feature exists to
  prevent. The tool refuses that combination instead.
- **Sequence** (`sequenceDiagram`) — one BFS trace: messages in the order a walker meets
  them, with a note per state change. A trace is not a machine: branches appear as separate
  guarded messages, paths the walk never took are absent, and the trace is capped. Use it to
  show a protocol exchange to a human. It cannot be the review's fidelity input — `parse`
  refuses it for that reason, and `review` reports the check as inapplicable (`UML019`).

## Modelling a code flow from source

Extraction is the same discipline as `logic-verification-guide.md`, applied to code instead
of a plan:

1. **Fix the boundary.** Which function, task, or module is the machine? In: state the code
   holds across calls (statics, fields, enums, task state variables). Out: the call stack
   inside one invocation, hardware behaviour, scheduler preemption.
2. **Name the states from the code, not from intuition.** A state exists if something
   survives a call boundary and is tested later. An enum, a `state` field, a task-local
   variable that gates the next entry all qualify; a local mid-function variable does not.
3. **Name the events from the code.** Every edge must trace to a call site, a message, a
   timer expiry, or an ISR — a source location the reader can open. An edge with no call
   site is a guess and belongs in the review findings, not in the model.
4. **Record guards and actions verbatim.** A guard must be the real condition, with the real
   variable and the real constant; a retry limit of 3 modelled as "a few" is a model of your
   assumption, not of the code.
5. **Mark terminals.** An absorbing state (power-off, fatal, done) is `terminal: true`. If
   nothing is terminal, say so out loud — the review will flag it.
6. **Write the narrative as you go.** `narrative.states` / `narrative.events` /
   `narrative.scenarios` is what lets a reader check the diagram against the code without
   re-deriving every symbol. The schema requires all three parts and full coverage once the
   block is present, so the narrative cannot rot half-way.

### Evidence rule

Every state, event, guard and action in the model needs a citation — `file:line` for code,
section for a document. A UML model without citations is a drawing: it cannot be reviewed,
only admired. When you present the model, present the citations with it.

### Confirming the model

Same gate as the rest of the plugin: show the extracted transition table (or the diagram)
and get confirmation before treating the model as fact. In `logicprobe interaction=auto`,
skip the question, cite evidence per element, round-trip the model (render → parse → compare)
and mark the result `UNCONFIRMED`.

## Rendering

In DSH:

```json
{ "action": "render", "model": { "...LogicModelV1..." }, "notation": "mermaid", "kind": "state" }
```

`logicprobe_uml action=render` returns the diagram source plus `warnings`. Warnings are not
cosmetic: they list every construct the notation could not carry verbatim (a state id that
needed an alias, a label containing `[` `/`, a trace that was capped).

Without the DSH tool: run the standalone engine
`skills/logicprobe/references/logicprobe-engine.py uml-render model.json --notation mermaid
--diagram state`, or write the diagram by hand — the generator is a convenience, not a
requirement. A hand-written diagram is parsed and reviewed exactly like a generated one.

### Generated diagrams carry directives

The generated text includes comment lines that Mermaid and PlantUML ignore but the parser
reads:

```text
%%logicprobe:uml v1 notation=mermaid diagram=state
%%logicprobe:init INIT
%%logicprobe:terminal FATAL
%%logicprobe:alias S_1 1st state
%%logicprobe:variable retry integer
```

They exist because the notation cannot express everything the model knows: `[*]` says
"initial" but a flowchart has no such marker; a state id may contain characters the notation
cannot spell; a boolean variable's assignment (`armed := 1`) is indistinguishable from an
integer one. Pinning those facts in comments is what makes the round-trip check exact rather
than approximate. PlantUML uses `'` instead of `%%`. A hand-written diagram needs none of
them, but adding `%%logicprobe:init` / `%%logicprobe:terminal` to a flowchart is how you say
which node starts and which end.

## Reviewing the modelling

```json
{ "action": "review", "model": { "...LogicModelV1..." } }
```

Four input shapes, four different questions:

| Input | Question answered |
|---|---|
| `model` only | Is this machine well-modelled? The review checks its structure, then renders and re-parses it to prove the diagram carries it. |
| `diagram` only | What does this diagram actually say? It is parsed into a model and that model is reviewed; fidelity to code is **unchecked** (`UML018`). |
| `model` + `diagram` | Does the diagram match the model? Every structural difference is a modelling defect (`UML017`). |
| `model` + `kind: "sequence"` | The trace is rendered and the structure is reviewed, but the fidelity check **does not apply** (`UML019`): a trace cannot be parsed back into a machine, so the review says so instead of pretending it verified the diagram. `maxSteps` caps the trace. |

### Findings

| Code | Severity | What it means |
|---|---|---|
| `UML001_DIAGRAM_UNREADABLE` | error | The diagram is not readable as Mermaid/PlantUML state or activity text. |
| `UML002_UNREACHABLE_STATE` | error | A state no transition can enter from init: the diagram draws flow nobody can reach. Structural (guards ignored); S1 is the guard-aware check. |
| `UML003_DEAD_END_STATE` | error | A non-terminal state with no outgoing transition: either it is terminal or the outgoing flow was never modelled. |
| `UML004_AMBIGUOUS_BRANCH` | error | Two unconditional arrows for one (state, event). No reader and no implementation can resolve that; S4 is the authoritative check. |
| `UML005_OVERLAPPING_GUARD` | warning | The same guard text appears twice in one branch group. |
| `UML006_INEXHAUSTIVE_BRANCH` | warning / info | Only guarded branches, no default. `warning` when the guards do not look complementary; `info` when a complementary pair (`k < 3` / `k >= 3`) is present, which is probably exhaustive but only S6 can settle it. |
| `UML007_UNUSED_EVENT` | warning | An event fires only from unreachable states: the diagram shows messages that never arrive. |
| `UML008_SELF_LOOP_NO_EXIT` | warning | An unguarded self-loop with no other exit — activity the diagram presents as progress but which never leaves; S3 reports absorbing cycles. |
| `UML009_DUPLICATE_TRANSITION` | warning | The same (from, event, guard, actions, to) row twice. |
| `UML010_UNUSED_VARIABLE` | warning | A variable never read by a guard and never written: a symbol with no source. |
| `UML011_UNBOUNDED_VARIABLE` | info | An integer variable with no min/max, so no range invariant can be checked and A5 has no declared domain. |
| `UML012_NO_TERMINAL` | warning | No terminal state: completion, failure and a stuck flow look the same. |
| `UML013_NO_NARRATIVE` | info | No natural-language meanings: a reader must re-derive every symbol from the source. |
| `UML014_UNDOCUMENTED_STATE` | info | States that render as their bare id, so the diagram cannot be read against code. |
| `UML015_LABEL_DRIFT` | warning | A diagram label disagrees with the model narrative: one of the two is stale, and the review cannot tell which. |
| `UML016_DIAGRAM_PARSE_NOTES` | info | Notes collected while rendering/reading: information the notation could not carry. |
| `UML017_ROUND_TRIP_MISMATCH` | error | The diagram does not carry the model: transitions lost or invented, init/terminal/variable differences. The `roundTrip.diffs` array lists each one. |
| `UML018_FIDELITY_UNCHECKED` | info | Only a diagram was supplied, so nothing here proves it matches the code. |
| `UML019_ROUND_TRIP_SKIPPED` | warning | The fidelity check could not run (view not round-trippable, or switched off). |

`ok: true` means the review ran. It does not mean the model is good — read the findings and
the `summary` counts.

### What the round trip proves, and what it does not

It proves the diagram is a faithful **rendering** of the model: same init, same states, same
terminal set, same transitions with the same guards and actions, same variables. It does not
prove the model matches the code — only a citation-per-element comparison can do that (the
"Evidence rule" above), and it does not prove the machine is correct — that is
`logicprobe_verify`.

A failing round trip means the notation lost something. In practice that is a real finding:
an unlabelled arrow (a synthetic `t_A_B` event names a transition the modeller never named),
a guard the parser could not read, or a diagram that was hand-edited away from its model.

## Worked example

Code under review: a handshake that retries on timeout and gives up.

```text
INIT --power_ready--> STARTING
STARTING --ack--> ACTIVE
STARTING --timeout [retry < 3] / retry := retry + 1--> ERROR
STARTING --timeout [retry >= 3]--> FATAL (terminal)
ERROR --cooldown--> STARTING
```

Render it as a state machine and the review reports:

```text
UML006_INEXHAUSTIVE_BRANCH (info)  guards look complementary on retry
UML013_NO_NARRATIVE       (info)  no state/event/scenario meanings
```

Both are modelling gaps, not behaviour bugs: add the narrative so a reader can check the
diagram against the code, then run `logicprobe_verify` for S1-S8/A1-A14. Now delete the
`ERROR --cooldown--> STARTING` arrow and re-review: `ACTIVE` and `ERROR` become dead ends
(`UML003`) and `cooldown` becomes an event that only fires from an unreachable state
(`UML007`) — the diagram still looks plausible, which is the whole point.

## Limits

- The review is **structural**. It evaluates no guard over any valuation; "probably
  exhaustive" is a shape test, not a proof, and S6 is the check that decides.
- Reachability ignores guards (`UML002`). A state reachable only under an unsatisfiable
  guard is a behaviour finding (S1/S6), not a modelling one.
- Sequence diagrams are traces: they are neither round-tripped nor parsed, and reviewing one
  renders the trace, reports the structure findings, and marks the fidelity check
  inapplicable (`UML019`).
- PlantUML activity is refused by design (see above).
- Renaming a state in the diagram does not rename it in the code. The review can only tell
  you the two disagree; resolving it needs the source.
- The generated diagram is a faithful view of the *model*, never of the *program*. If the
  model is wrong the diagram is wrong in exactly the same way.
