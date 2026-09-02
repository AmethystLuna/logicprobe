# Gap Routing Guide

logicprobe is a design-time, qualitative model checker. For semantic dimensions it does
not model, it does not stay silent: it routes claims to dedicated tools. This reference
is the routing table shared by the verification report (`coverageNotes`), the
concurrency scanner (`suggestions` on absolute claims), and manual review.

Routing is a hint, not a proof. A note never verifies the claim — it marks the dimension
as outside this engine and points at tooling that can handle it.

| Dimension | What logicprobe covers today | Claim examples | Dedicated tooling | Why not here |
|---|---|---|---|---|
| Hard real time (timing) | Order, counts, path budgets (A12); time modeled only as counters + events | "500 ms to SAFE", "no deadline miss", "period ≤ 1 ms" | UPPAAL, IMITATOR (timed automata); binary-level timing analysis for WCET | No clocks, deadlines, or period semantics |
| Preemptive concurrency | Event-order interleavings (A2/A3), resource pairing (A4), idempotent replay (A8) | "thread-safe", "interrupt-safe", "no priority inversion" | TSan/Helgrind (runtime), CBMC (proof), TLA+ (interleaving model), RTOS-aware analysis | Single-threaded event model; no preemption, IRQ nesting, or atomics at instruction level |
| Hybrid control (continuous plant) | Discrete transitions and modes only | "switching is stable", "no chattering", "settling within T" | SpaceEx, Flow* (hybrid reachability), Simulink/Stateflow verification | No continuous dynamics; stability is not expressible |
| Probabilistic / reliability | Qualitative reachability and invariants | "MTBF ≥ X", "failure rate ≤ p", "availability ≥ 99.9%" | PRISM, Storm (stochastic model checking), fault-tree / FMEA | No probability semantics |
| Execution cost / performance | A12 budget checks over declared transition `cost` (absent = 1) | "worst-case dispatch ≤ 100 cycles" | aiT, RapiTime (real WCET at binary level) | `cost` is a modeler label, not measured execution time |
| Multi-machine composition | Single machine verified; cross-machine contract must be documented separately | "A sends E, B always handles E" | CSP (FDR), mCRL2, TLA+ (compositional models) | No composition semantics between machines |
| Nested/hierarchical statecharts | Flat models only; flatten before verification | parent/child states, orthogonal regions | SCXML / Stateflow (native hierarchy) | Flat state list only — flatten manually and re-confirm |

## Where the routing surfaces

- `logicprobe_verify` report: a model whose state/event/action names match the timing,
  preemption, hybrid, or probability vocabulary gets informational `coverageNotes`
  with the same routing as above.
- A12 advisory: transitions declaring `cost` without a `budget` invariant produce
  `A12_COST_WITHOUT_BUDGET`, pointing at the budget check.
- `logicprobe_concurrency_scan`: absolute concurrency claims (thread-safe, lock-free,
  interrupt-safe, ...) carry `suggestions` naming dedicated tools.
- Manual review: when reading a plan, match its claims against the table above and
  require dedicated evidence before accepting "always"/"never"/"guaranteed" language
