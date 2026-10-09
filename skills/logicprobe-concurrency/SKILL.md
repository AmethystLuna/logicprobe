---
name: logicprobe-concurrency
description: "Use when a design or plan claims concurrency safety (thread-safe, lock-free, no data race, ISR-safe) or names shared state, mutexes, atomics or interrupts. Mines the claims and routes each to dedicated verification (TSan, Helgrind, CBMC, TLA+); it does not prove concurrency safety. Doctrine: the logicprobe skill."
---

# Logic Probe — Concurrency Claims

This skill does **not** prove concurrency safety, and no report from it should ever be read as a proof. It mines a document, plan or code review for concurrency claims, marks them `UNVERIFIED`, and routes each one to the tool that can actually decide it.

The claim-verification doctrine it inherits — enumerate verifiable claims, cite `file:line`, read `verdict` and never `ok` — lives in the `logicprobe` skill. Load that one when the task is behavioural verification of a state machine rather than a judgement about concurrency claims.

## When This Skill Applies

**Only after confirming the target actually has concurrency requirements or behaviour** — multiple threads, async tasks, interrupts, shared state, or parallel execution. If the target is purely sequential, do not invoke concurrency mining; there is nothing to mine.

| The claim | How it is treated |
|---|---|
| Absolute: "thread-safe", "lock-free", "no data race", "interrupt-safe", "ISR-safe" | error / `UNVERIFIED` unless dedicated evidence is provided |
| Risk keyword: "race condition", "shared variable", "mutex", "atomic", "shared memory", "critical section", `ISR`, `IRQ`, `NMI`, `disable_irq` / `enable_irq` | warning — review whether the plan actually addresses it |
| Lock/unlock, alloc/free, start/stop pairing where ordering matters | routed to `logicprobe` model verification (A4 pair symmetry), which can decide balance inside the modelled machine |

In DSH, run the `logicprobe_concurrency_scan` tool. For manual review, follow [`references/concurrency-risk-guide.md`](references/concurrency-risk-guide.md).

## Routing: What Decides Each Claim

Mining a claim is not verifying it. Hand each one to a tool that can:

| Dimension | Tool that decides it |
|---|---|
| Data races, lock-ordering, lock-free algorithms | ThreadSanitizer, Helgrind, or a model checker over the real code (CBMC) |
| Interrupt/ISR races, critical sections | RTOS-aware interrupt analysis, or a TLA+ model of the ISR/task interleaving |
| Protocol-level interleaving of discrete events | `logicprobe_verify` (S1-S8 / A1-A14) and `logicprobe_compose_verify` (C1/C2) |
| Hard real time: deadlines, periods, preemption | Scheduling analysis (RMA/EDF) and a timing tool — not logicprobe |
| Probability or reliability claims | PRISM/Storm, fault-tree analysis |

The full routing table, including hard-real-time, hybrid-control and execution-cost dimensions, is [`../logicprobe/references/gap-routing-guide.md`](../logicprobe/references/gap-routing-guide.md). `logicprobe_verify` reports carry the same routing as informational `coverageNotes` on matching models.

## Rules for This Mode

1. **Mining, not proof.** Report a concurrency claim as `UNVERIFIED` with the routing target; never as passing.
2. **No absolute language in the answer.** "This is thread-safe" is exactly the claim being mined, not a result this skill can produce.
3. **One counterexample is enough to refute.** If a race is suspected, the deliverable is the interleaving that breaks it plus the harness that demonstrates it (TSan/Helgrind output), not an argument.
4. **Sequential targets are out of scope.** If nothing runs concurrently, say so and stop.
