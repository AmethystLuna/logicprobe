<EXTREMELY_IMPORTANT>
Plugin logicprobe is active. Documents are not truth — code is. Verify every verifiable claim before accepting or acting on any design.

**When to load** — invoke with `Skill("logicprobe")` when:

- Reviewing design documents, architecture specs, technical proposals, or refactoring plans
- A plan makes claims about API names, file locations, enum values, or mechanism feasibility
- A plan contains state machines, protocol logic, or behavioral claims ("always"/"never"/"guaranteed") — the skill escalates to logic-primitive verification: an executable model with 8 structural checks (S1-S8) + 14 adversarial probes (A1-A14)
- The claim is quantitative or temporal — worst-case path cost against a declared budget, probabilistic reachability ("≥90% of runs reach SAFE"), or a deadline ("must leave within 2 ticks"). A12, A13 and A14 decide it against the model
- The claim spans two or more machines — a req/ack handshake, or power-up sequencing across modules. The skill checks them together: composition deadlock, rendezvous that never fires
- The plan asserts concurrency guarantees ("thread-safe", "lock-free", "no data race", "ISR-safe"). The skill mines those claims and routes them to dedicated verification; it does not prove concurrency safety
- A refactoring plan modifies state topology — the skill compares before/after models for behavioral regression detection
- The task is to model a code flow as UML, or to audit a diagram somebody drew. The skill renders the model as a diagram, reads a hand-drawn diagram back into a model, and reviews the modelling itself.
- The claims are about entities, fields, relationships, or a schema migration — use the sibling `logicprobe-datamodel` skill instead (DS1-DS4, DA1-DA12, DD1-DD4)

**1% Rule**: If there is even a 1% chance the skill applies to the task, invoke it before responding. The cost of loading is trivial compared to the cost of a false claim.

**Red Flags** — if you think any of these, STOP. You are rationalizing:

| You think | Reality |
|-----------|---------|
| "This plan is too simple to verify" | The skill auto-classifies depth (LIGHTWEIGHT / STANDARD / ESCALATED). You don't decide. |
| "I already know the file paths are correct" | Organic verification leaves no audit trail. Run Phase 0, append the `## Plan Verification` block. |
| "I'll verify while implementing" | Verification happens before implementation, not during. |
| "I can check this with reasoning alone" | Behavioral claims are verified with code/models, not intuition. One counter-example refutes a universal claim. |

**Reading the reports** — every report carries `ran`, `verdict` (`pass` / `pass_with_findings` / `fail`) and `verdictReason`. `ok: true` only means a report was produced: a deadlocked model verifies with `ok: true` and `verdict: "fail"`, so gate on `verdict`. A `UML_NOT_A_STATE_DIAGRAM` finding means the file is not a state/activity diagram and the parsed model must not be quoted as a model of it. `_`-prefixed keys are annotation metadata: ignored by the schema, excluded from `modelHash`, echoed as `metadataKeys`.

**Proactive suggestion**: When a user asks code-level behavioral questions — "could this state machine deadlock", "is this retry limit safe", "check this timing sequence for bugs" — suggest logicprobe as an optional verification pass (do not auto-escalate).
</EXTREMELY_IMPORTANT>
