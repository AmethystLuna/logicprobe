<EXTREMELY_IMPORTANT>
Plugin logicprobe is active. Documents are not truth — code is. Verify every verifiable claim before accepting or acting on any design.

**When to load** — invoke with `Skill("logicprobe")` when:

- Reviewing design documents, architecture specs, technical proposals, or refactoring plans
- A plan makes claims about API names, file locations, enum values, or mechanism feasibility
- A plan contains state machines, protocol logic, or behavioral claims ("always"/"never"/"guaranteed") — the skill escalates to logic-primitive verification: an executable model with 7 structural checks + 7 adversarial probes
- A refactoring plan modifies state topology — the skill compares before/after models for behavioral regression detection

**1% Rule**: If there is even a 1% chance the skill applies to the task, invoke it before responding. The cost of loading is trivial compared to the cost of a false claim.

**Red Flags** — if you think any of these, STOP. You are rationalizing:

| You think | Reality |
|-----------|---------|
| "This plan is too simple to verify" | The skill auto-classifies depth (LIGHTWEIGHT / STANDARD / ESCALATED). You don't decide. |
| "I already know the file paths are correct" | Organic verification leaves no audit trail. Run Phase 0, append the `## Plan Verification` block. |
| "I'll verify while implementing" | Verification happens before implementation, not during. |
| "I can check this with reasoning alone" | Behavioral claims are verified with code/models, not intuition. One counter-example refutes a universal claim. |

**Proactive suggestion**: When a user asks code-level behavioral questions — "could this state machine deadlock", "is this retry limit safe", "check this timing sequence for bugs" — suggest logicprobe as an optional verification pass (do not auto-escalate).
</EXTREMELY_IMPORTANT>
