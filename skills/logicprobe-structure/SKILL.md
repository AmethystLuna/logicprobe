---
name: logicprobe-structure
description: "Use when reviewing architecture, module structure or a dependency diagram: parse a component, package, class or deployment diagram into a dependency graph and check isolated nodes, dangling endpoints, cycles, allowed-dependency violations, layer violations and missing required edges. Audits the diagram, not the code — reconcile it with a source-side scan. Doctrine: the logicprobe skill."
---

# Logic Probe — Structure and Dependency Review

A component diagram is a model of an architecture, and a model can be wrong. This skill audits the graph the diagram actually draws — nodes and dependency arrows — against a declared dependency matrix, and says plainly what that does and does not prove.

The claim-verification doctrine it inherits — cite evidence, read `verdict` and never `ok` — lives in the `logicprobe` skill. Load that one for behavioural claims (state machines, protocols, timing); load this one when the question is *where the dependencies point*.

## When This Skill Applies

| The task involves… | What it does |
|---|---|
| "Review this architecture", "are the module dependencies sound", "is the layering right" | Parse the structure diagram into a graph, then run the structural checks below |
| A component / package / class / deployment diagram (PlantUML) or a Mermaid class diagram | `logicprobe_structure_verify` reads nodes, containers, labels and arrows; nothing is discarded |
| A rule table of allowed dependencies (allow/deny, layers, required edges) | Every edge is judged against it and reported with the rule ids it matched |
| A diagram that must be reconciled with an include/graph check over the source | The per-edge rule ids are the meeting point: a difference between the two is the finding worth chasing |

Non-DSH hosts run the same engine: `python skills/logicprobe/references/logicprobe-engine.py structure diagram.puml --matrix matrix.json` (an exact mirror, cross-checked by `tests/python/run.mjs`).

## What It Checks

| Code | Severity | What it means |
|---|---|---|
| `UML020_ISOLATED_NODE` | warning | A declared, non-container node with no edge at all. A dead entry, or a dependency the diagram forgot to draw. |
| `UML021_DANGLING_REFERENCE` | error | An arrow endpoint that no declaration ever introduced. In a component diagram this is how a dependency on a component that does not exist stays invisible. |
| `UML022_CYCLE` | error | A directed cycle, reported as the **shortest** cycle path. A cycle means no build order and no layering can hold. |
| `UML023_DISALLOWED_EDGE` | error | An edge the matrix forbids — or, with `default: "deny"`, an edge no rule permits. The denying rule id is named. |
| `UML024_LAYER_VIOLATION` | error | An edge from a lower declared layer into a higher one (a child depending on its parent). Downward edges are allowed. |
| `UML025_MISSING_EXPECTED_EDGE` | warning | A rule with `require: true` whose edge the diagram does not draw — including the case where no node matches the source pattern at all. The matrix and the diagram disagree. |
| `UML026_NO_NODES` | error | The text declares no node, so there is no structure to review. |

## The Dependency Matrix

The matrix is the single source of truth the diagram is checked against. Keep it next to the rules it encodes, in JSON:

```json
{
  "rules": [
    { "id": "R1-app-may-use-hal", "source": "app.*", "allow": ["hal.*"], "deny": ["hal.at32_internal"] },
    { "id": "R2-adapter-owns-hal", "source": "LA", "allow": ["DRV"], "deny": ["MS"] },
    { "id": "R3-no-back-edges", "source": "*", "deny": ["MS"] },
    { "id": "R4-persistence-required", "source": "LA", "allow": ["DB"], "require": true }
  ],
  "layers": [
    { "name": "app", "members": ["MS", "LA"] },
    { "name": "hal", "members": ["DRV", "DB"] }
  ],
  "default": "deny"
}
```

- `source`, `allow`, `deny` and `layers[].members` accept **node ids or globs** (`*` any run, `?` one character).
- **`deny` wins globally.** A later rule's allow never resurrects an edge an earlier rule forbade; the result cannot depend on rule order.
- `default: "allow"` (the default) means only the rules judge: an edge no rule mentions is `default`. `default: "deny"` closes the matrix — anything unlisted is `UML023`.
- `require: true` turns a rule into an expectation about the diagram (`UML025`); it needs `allow` to say which edges must exist.
- Layers are ordered **top first**: an edge from an earlier layer to a later one is allowed, the reverse is `UML024`.
- Every edge is echoed in `edgeVerdicts` as `{from, to, line, matchedRules, allowed, basis}`, where `basis` is `allow` / `deny` / `default` / `unlisted`. That is the audit trail for the reconciliation below.

## Reconciling With a Source-Side Check

This tool audits the **diagram**; an include or dependency scan audits the **code**. They answer the same question from two sides, and each side can be the one that is wrong:

1. Run both. Keep the rule ids identical on both sides — that is what makes a difference explainable.
2. For every rule id, compare: does the diagram draw the edge, and does the source contain the dependency?
3. Classify each difference instead of averaging it away:
   - **Diagram missing an edge the code has** — the diagram is stale (`UML025` fires when the rule is `require: true`).
   - **Diagram drawing an edge the code does not have** — either the diagram is aspirational, or the source scan's scope is narrower (different file set, generated code, conditional compilation).
   - **Code violating an allowed dependency the diagram never showed** — the architecture defect the diagram was hiding. This is the one worth acting on.
4. Report the difference with both citations. Never present the diagram as evidence about the code without saying which side produced which half.

## Limits — Say These Out Loud

- **The diagram may be wrong.** A clean `pass` means the drawn graph is internally consistent and satisfies the matrix — not that the code matches it. Only the reconciliation above touches the code.
- **No transitive closure by default.** `A → B → C` does not report `A` reaching `C`; write the rule you mean, or add the edge the code actually has.
- **No runtime behaviour.** Calls through function pointers, DI containers, registries, plugin loading and dynamic dispatch do not appear as edges. A missing edge is not proof of a missing dependency.
- **Containers are not dependencies.** Package/rectangle nodes carry members, not arrows; they are exempt from `UML020`.
- **The matrix is a claim too.** A matrix nobody maintains produces confident, wrong verdicts. Treat a rule change as a code change: review, version, cite.
- **State machines are a different question.** For guards, deadlocks, budget, probability or deadlines, that is `logicprobe` (verification) and `logicprobe-uml` (the diagram round trip).

## Rules for This Mode

1. **Never read a structure diagram as a state machine.** The state-machine front end refuses such a file (`UML_NOT_A_STATE_DIAGRAM`); this skill reads it as the dependency graph it is. The two must not be mixed in one report.
2. **Quote the rule id for every judged edge.** "Not allowed" without the rule is an opinion; `matchedRules` makes it a finding.
3. **Run the numbers, never the impression.** An isolated node and a back edge are exactly what a reader misses by eye; that is why the check exists.
4. **Report the diagram-code difference, not just the diagram.** A structure review that never touches the source is a review of a drawing.

The full matrix schema, a worked example and the reconciliation worksheet are in [`references/structure-review-guide.md`](references/structure-review-guide.md).
