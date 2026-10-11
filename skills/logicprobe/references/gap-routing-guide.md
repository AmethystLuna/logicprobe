# Gap Routing Guide

logicprobe is a design-time, qualitative model checker. For semantic dimensions it does
not model, it does not stay silent: it routes claims to dedicated tools. This reference
is the routing table shared by the verification report (`coverageNotes`), the
concurrency scanner (`suggestions` on absolute claims), and manual review.

Routing is a hint, not a proof. A note never verifies the claim — it marks the dimension
as outside this engine and points at tooling that can handle it.

| Dimension | What logicprobe covers today | Claim examples | Dedicated tooling | Why not here |
|---|---|---|---|---|
| Hard real time (timing) | Order, counts, path budgets (A12), and deadlines over discrete ticks (A14). Time otherwise appears as counters and events | "500 ms to SAFE", "no deadline miss", "period ≤ 1 ms" | UPPAAL, IMITATOR (timed automata); binary-level timing analysis for WCET | No continuous clocks. A deadline that is not a tick count cannot be expressed |
| Preemptive concurrency | Event-order interleavings (A2/A3), resource pairing (A4), idempotent replay (A8) | "thread-safe", "interrupt-safe", "no priority inversion" | TSan/Helgrind (runtime), CBMC (proof), TLA+ (interleaving model), RTOS-aware analysis | Single-threaded event model; no preemption, IRQ nesting, or atomics at instruction level |
| Hybrid control (continuous plant) | Discrete transitions and modes only | "switching is stable", "no chattering", "settling within T" | SpaceEx, Flow* (hybrid reachability), Simulink/Stateflow verification | No continuous dynamics; stability is not expressible |
| Probabilistic / reliability | Qualitative reachability and invariants | "MTBF ≥ X", "failure rate ≤ p", "availability ≥ 99.9%" | PRISM, Storm (stochastic model checking), fault-tree / FMEA | No probability semantics |
| Execution cost / performance | A12 budget checks over declared transition `cost` (absent = 1) | "worst-case dispatch ≤ 100 cycles" | aiT, RapiTime (real WCET at binary level) | `cost` is a modeler label, not measured execution time |
| Multi-machine composition | `logicprobe_compose_verify` (dsh) and the engine's `compose` subcommand (non-dsh) check machines together: C1 composition deadlock, C2 a rendezvous that never fires. They stop at one handshake event per rendezvous | "A sends E, B always handles E", "these two never deadlock" | CSP (FDR), mCRL2, TLA+ (compositional models) | No payloads, no rate ratio and no fairness bound; each machine's own step order is free |
| Protocol semantics (message contents, channels, per-message ordering) | Events and handshakes between machines | "QoS 1 delivers exactly once", "the broker never reorders", "the queue never overflows" | TLA+, mCRL2, SPIN (Promela channels) | The model has states and events, not messages, queues or payloads |
| Nested/hierarchical statecharts | Flat models only; flatten before verification | parent/child states, orthogonal regions | SCXML / Stateflow (native hierarchy) | A flat state list only. `logicprobe_compose_verify` places machines side by side; it does not nest states. Flatten manually and re-confirm |
| Write-site / single-owner analysis | **Not covered, and not planned.** logicprobe reviews the diagram and the model; it does not read the source to see *who writes* a variable, a register or a field | "only the ISR writes this", "one owner per flag", "no double write to the CAN mailbox" | A source-side AST/rule check (e.g. the project's own include/arch checker), a static analyzer (clang-tidy, PC-lint, Coverity), or a model checker over the real code (CBMC) | It needs the source and a rule table about statements — a different input than a model or a diagram. `logicprobe_concurrency_scan` will flag the *claim* as unverified and route it here, which is the honest part of this plugin's answer (it is a dsh-only capability; without it, route the claim by hand) |

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
- Generators: `logicprobe_export` (dsh) and the engine's `export` subcommand (non-dsh) emit
  native inputs for UPPAAL (.xta + queries), TLA+ (TLC spec + safety), PRISM (.pm + .pctl),
  and SPIN (Promela + ltl) from a LogicModelV1. Both translate the core machine (guards,
  updates, weights; booleans as integers) and return unrepresentable invariants as explicit
  warnings.
