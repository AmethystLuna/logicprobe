# Concurrency Risk Mining Guide

logicprobe does **not** prove concurrency safety. It mines design documents and plans for concurrency-related claims so they are either explicitly verified with dedicated tools or marked as unverified.

## When to use

**Prerequisite: confirm the verification target actually has concurrency requirements or behavior** — multiple threads, async tasks, interrupts, shared state, or parallel execution. Do not run concurrency mining on purely sequential designs just because a generic word like "parallel" or "atomic" appears.

Use when a document contains:

- "thread-safe", "lock-free", "wait-free", "no data race", "race-free"
- "race condition", "data race", "atomic", "synchronized"
- "mutex", "semaphore", "spinlock", "reentrant", "interrupt-safe"
- "concurrent", "parallel", "multi-threaded", "shared variable", "shared memory"

## DSH tool

```text
logicprobe_concurrency_scan text="..."
```

Returns:

- `CONCURRENCY_ABSOLUTE_CLAIM` (error) for guarantees like "thread-safe" / "lock-free" / "no data race"
- `CONCURRENCY_KEYWORD` (warning) for risk-related terms like "race condition" / "shared memory" / "mutex"

## Manual mining checklist

- [ ] Scan for absolute concurrency safety claims.
- [ ] For each absolute claim, require dedicated evidence: TSan report, model-checking result, formal proof, or a clear design argument.
- [ ] If no evidence exists, mark the claim `UNVERIFIED` and escalate to concurrency analysis.
- [ ] Do not treat "uses mutex" as "thread-safe" — synchronization primitives are not proof.

## Interrupt safety

Interrupt safety is a first-class concurrency dimension in embedded/real-time designs. The scan treats the following as interrupt-related risk points:

- `interrupt-safe`, `ISR-safe` → absolute claims (error)
- `interrupt safety`, `interrupt context`, `ISR`, `IRQ`, `NMI`, `critical section`
- `disable_irq`, `enable_irq`, `spin_lock_irqsave` → warning, verify pairing and nesting

Manual checklist:

- [ ] If the design claims "interrupt-safe", require evidence: critical sections, IRQ disable windows, atomic operations, or formal reasoning.
- [ ] Check that `disable_irq` / `enable_irq` are paired on all paths.
- [ ] Check that ISR-context code does not call blocking/sleeping primitives.
- [ ] Check that shared variables between ISR and thread context are protected (atomic, critical section, or lock-free protocol).

## Escalation targets

- C/C++: ThreadSanitizer, Helgrind
- Java: JCStress, Java PathFinder
- General: TLA+, SPIN, Alloy
- Rust: loom, Shuttle
