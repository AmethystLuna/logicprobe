<EXTREMELY_IMPORTANT>
Plugin logicprobe is active. Documents are not truth — code is. Verify every verifiable claim before accepting or acting on any design.

**When to load** — one skill per domain. `logicprobe` is the entry point and owns the doctrine; load it whenever you have any thought of checking whether something about the code is true, and let its routing table hand a neighbouring domain on.

- **Any claim about code you want to check** — a design doc, spec, plan, review comment, README or refactor asserting API names, file locations, enum values, mechanism feasibility, or "always"/"never" behaviour → `logicprobe` (claim enumeration, codebase verification with file:line evidence)
- **State machines and protocols** (≥3 states, guards, ACK/NACK/retry, lock pairing) → `logicprobe`: an executable model with 8 structural checks (S1-S8) + 14 adversarial probes (A1-A14)
- **Quantitative or temporal guarantees** — worst-case path cost against a declared budget, probabilistic reachability ("≥90% of runs reach SAFE"), a deadline ("must leave within 2 ticks") → `logicprobe`: A12, A13, A14
- **Two or more machines** — a req/ack handshake, or power-up sequencing across modules → `logicprobe`: composition deadlock, rendezvous that never fires
- **A refactoring that changes state topology or guards** → `logicprobe`: before/after models compared for behavioral regression (D1-D4)
- **Concurrency claims** ("thread-safe", "lock-free", "no data race", "ISR-safe") → `logicprobe-concurrency`: mined and routed to dedicated verification (TSan, Helgrind, CBMC, TLA+); it does not prove concurrency safety
- **Modelling a code flow as UML, or auditing a diagram somebody drew** → `logicprobe-uml`: render / parse / review, with render-versus-model round-trip fidelity; a component, package or class diagram is refused rather than modelled
- **Reviewing architecture, module structure or a dependency diagram** — "are the dependencies sound", "is the layering right" → `logicprobe-structure`: parse a component/package/class/deployment diagram into a dependency graph and check isolated nodes, dangling endpoints, cycles, allowed-dependency violations, layer violations and missing required edges, each edge naming the rule it matched
- **Entities, fields, relationships, data invariants, schema migrations** → `logicprobe-datamodel` (DS1-DS4, DA1-DA12, DD1-DD4)
- **Accepting a slice by "violations must not increase"** → `logicprobe_report_diff`: compare the earlier report with the new one by stable finding identity; a newly added error fails the delta, and a clean delta never hides a failing run

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
