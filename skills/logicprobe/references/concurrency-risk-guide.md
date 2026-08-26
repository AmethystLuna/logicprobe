# Concurrency Risk Mining Guide

logicprobe does **not** prove concurrency safety. It mines design documents and plans for concurrency-related claims so they are either explicitly verified with dedicated tools or marked as unverified.

## When to use

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

## Escalation targets

- C/C++: ThreadSanitizer, Helgrind
- Java: JCStress, Java PathFinder
- General: TLA+, SPIN, Alloy
- Rust: loom, Shuttle
