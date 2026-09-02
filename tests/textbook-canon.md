# Textbook Canon (tests)

Named cases from the formal-methods / systems literature, each mapped to the check(s)
it exercises and where it lives. These are the regression fixtures behind the new
checks and the legacy-gap coverage of the older ones.

| Check | Canonical case (literature anchor) | Where |
|---|---|---|
| S1 | unreachable init guard (dead code) | tests/engine/run.mjs fixtures (init-violation, retry-unbounded) |
| S2 | two-phase commit participant stranded in WAITING | tests/engine/fixtures/twophase-participant-stuck.json |
| S3 | absorbing busy-loop without exit | tests/engine/fixtures/absorbing-scc.json |
| S4 | vending machine: one coin -> DISPENSE and REFUND | tests/engine/fixtures/vending-ambiguous.json |
| S5/A1 | TCP half-close: ESTABLISHED silently ignores RST | tests/engine/fixtures/tcp-missing-rst.json |
| S6 | retry guard without an else branch | tests/engine/fixtures/boundary-guard.json |
| S7/A7 | invariant violated from the initial state | tests/engine/fixtures/init-violation.json, event-before-state.json |
| S8 | monotonic counter moved backwards | tests/engine/run.mjs advanced-constraints (monotonic) |
| A2 | ISR vs task shared-counter write race | tests/engine/run.mjs textbook-canon (counterRace) |
| A4 | critical-section lock on entry / unlock on exit; leak; held into terminal | tests/engine/fixtures/entry-exit-*.json |
| A6 | semaphore take with no timeout handler | tests/engine/run.mjs textbook-canon (semTake) |
| A8 | webhook redelivery without dedupe | tests/engine/run.mjs textbook-canon (webhook), idempotent-replay |
| A9 | leads-to loop that avoids the target | tests/engine/run.mjs advanced-constraints (leadsBad) |
| A10 | two-phase commit: commit before prepare | tests/engine/fixtures/twophase-order.json |
| A11 | atomic group left without commit/rollback | tests/engine/run.mjs advanced-constraints (atomicBad) |
| A12 | bounded retry within budget vs unbounded retry (classic missing counter) | tests/engine/fixtures/retry-bounded.json, retry-unbounded.json |
| A13 | gambler's ruin (fair coin, P(broke) = 4/5) | tests/engine/fixtures/gamblers-ruin.json |
| A14 | watchdog deadline: resident past maxTicks | tests/engine/fixtures/deadline-over.json, deadline-ok.json |
| C1/C2 | CSP-style request/ack handshake; blocked handshake; 3-machine chain | tests/engine/run.mjs composition-tests |
| S7/A7 | Peterson mutual exclusion: never both in CS; removing the wait condition breaks it | tests/engine/run.mjs canon-two |
| C1/C2 | producer-consumer single-slot rendezvous; consumer that never drains deadlocks | tests/engine/run.mjs canon-two |
| A13 | biased gambler (p_win = 0.4): P(broke first) = 0.924 from $1 | tests/engine/run.mjs canon-two |
| A3 | ledger bookings A/B: order-dependent (DONE1 vs DONE2) vs commutative negative | tests/engine/run.mjs canon-three |
| S1 | post-migration dead code: LEGACY_V1 unreachable after V2 flow | tests/engine/run.mjs canon-three |
| scale | 300-state chain; 80x80 composition product + forced truncation; deep 120-state DTMC convergence | tests/engine/run.mjs stress-tests |
| coverageNotes | watchdog/ISR/hybrid/reliability vocabulary routing | tests/engine/run.mjs coverage-note-tests |
| CONC | thread-safe / interrupt-safe absolute claims routing | tests/concurrency/run.mjs |
