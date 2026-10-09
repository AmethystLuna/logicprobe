---
name: logicprobe-uml
description: "Use when drawing a code flow as UML or auditing a diagram someone drew: parse a hand-drawn state or activity diagram, render a model, and check round-trip fidelity (dead ends, unreachable states, label drift). Component, class and ER diagrams are refused, not modelled. Doctrine and behavioural verification: the logicprobe skill."
---

# Logic Probe — UML Modelling

A diagram is a model, and a model can be wrong. A tidy flow chart is not evidence about the code, and a diagram that disagrees with its own model is worse than no diagram, because a reader will believe it.

This skill covers the diagram half of the Logic Probe toolbox. The claim-verification doctrine it inherits — enumerate verifiable claims, cite `file:line`, read `verdict` and never `ok` — lives in the `logicprobe` skill; load that one when the task is to verify behaviour rather than to draw or audit a diagram.

## When This Skill Applies

| The task involves… | What it does |
|---|---|
| Modelling a code flow as a state, activity or sequence diagram | `logicprobe_uml action=render`: model to diagram source, with a citation per state, event, guard and action |
| Reading a hand-drawn diagram back into a model | `action=parse`: Mermaid or PlantUML state/activity text into a LogicModelV1 that `logicprobe_verify` can check |
| Auditing a diagram somebody drew | `action=review`: structural defects, documentation gaps, and render-versus-model round-trip fidelity |
| A diagram whose claims must be tied to the code | Every element needs a source citation; the review says what the diagram says, not whether the code is correct |

Pipeline (DSH):

```text
code flow → model (citation per element) → logicprobe_uml action=render → diagram source
          → logicprobe_uml action=review → modelling findings + round-trip fidelity
          → logicprobe_verify           → behaviour (S1-S8 structural, A1-A14 adversarial)
```

- **render** — model to diagram. Mermaid covers `state`, `activity` and `sequence`. PlantUML covers `state` and `sequence`. Any construct the notation cannot carry becomes a warning, never a silent drop. PlantUML activity is refused instead of approximated.
- **parse** — diagram to model. It reads Mermaid and PlantUML state or activity text, so a hand-drawn diagram can be verified like any other model. Two inputs are refused because they cannot become a machine: a sequence diagram (a trace cannot reconstruct a machine) and a different Mermaid family (`classDiagram`, `erDiagram`, `gantt`, `mindmap`, …) — both come back as `errorCode: "UML_NOT_A_STATE_DIAGRAM"` with the discarded construct named.
- **review** — it answers one of three questions. Give it a model: is the machine well-modelled? Give it a diagram: what does the diagram say? Give it both: does the diagram match the model?

A host without the tools runs the same three actions through the repository engine. The engine is deliberately single-source — do not copy it into this skill.

## A Structure Diagram Is the Dangerous Case, Because It Parses

PlantUML component, package, class and deployment diagrams declare no diagram kind, so the parser meets their keywords line by line. It still returns *something* — the arrows look like transitions — so `parse` reports the by-product model **plus** an error finding `UML_NOT_A_STATE_DIAGRAM`, the declarations it could not represent in `discardedConstructs` (with line and text), the arrows that were misread in `discardedEdges`, and `verdict: "fail"`.

Read that as: **there is no model of this file; the diagram was not checked.** Do not feed that model to `logicprobe_verify` and call the result a review of the architecture, and do not present a component diagram as evidence about dependencies. A structure diagram has its own reviewer: the `logicprobe-structure` skill and the `logicprobe_structure_verify` tool parse the same text into a real dependency graph and check isolated nodes, dangling endpoints, cycles, allowed-dependency and layer violations (`UML020`-`UML026`). Use that one when the question is *where the dependencies point*.

Mermaid families with an explicit header (`classDiagram`, `erDiagram`, `gantt`, …) are refused outright, because an empty model would be worse than no model.

## What the Review Reports

Structural defects: unreachable states, dead ends, ambiguous or non-exhaustive branches, self-loops with no exit, duplicate transitions. Documentation gaps: a missing narrative, unbounded variables, states the reader cannot map back to code, and label drift between diagram and narrative. It also runs the fidelity check — any structural difference between the diagram and its model is `UML017_ROUND_TRIP_MISMATCH`.

## Rules for This Mode

1. **A diagram is not evidence.** Every state, event, guard and action needs a citation. Use `file:line` for code and a section reference for a document. Present the citations with the diagram.
2. **Review before you present.** Run `logicprobe_uml action=review` and fix the error findings first. An ambiguous or dead-ended diagram misleads every later reader.
3. **Check the verdict before the picture.** `ok: true` with `verdict: "fail"` means the review failed; a diagram whose review failed is not something to show as if it were checked.
4. **The review never replaces verification.** It covers the modelling. S1-S8 and A1-A14 cover the behaviour, and each finding names the check that settles it — hand those over to the `logicprobe` skill.
5. **Keep the narrative with the model.** Write `narrative.states`, `narrative.events` and `narrative.scenarios`. Then the diagram stays readable against the code, and label drift shows up as a finding instead of as a stale picture.

The full checklist (codes `UML001` to `UML019` plus `UML_NOT_A_STATE_DIAGRAM`), the directive format generated diagrams carry, a worked example, and the limits of each view are in [`references/uml-modeling-guide.md`](references/uml-modeling-guide.md).
