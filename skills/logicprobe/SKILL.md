---
name: logicprobe
description: "Use when reviewing design documents, architecture specs, technical proposals, or refactoring plans that make claims about API names, file locations, enum values, or mechanism feasibility. When the document contains state machines, protocol logic, or behavioral claims (≥3 states, ACK/NACK/retry sequences, 'always'/'never'/'guaranteed' assertions, or refactoring that modifies state topology), escalate into logic-primitive verification — generate and run executable models to check mathematical completeness before trusting any claim. For refactoring specifically, the pipeline compares before/after models to verify behavioral preservation and regression freedom. ALSO proactively SUGGEST this skill (do not require) when a user asks code-level behavioral questions — 'check this timing for bugs', 'could this state machine deadlock', 'is this retry limit safe' — since plan-level verification has usually already been done."
---

# Logic Probe

Documents are not truth — code is. Verify every verifiable claim before accepting or acting on any design.

<HARD-GATE>

## Verification Depth (Plan-Mode Gate)

When loaded as a plan-mode verification gate, this skill's execution is **mandatory**. The model has no discretion to bypass it. Depth classification is gated on objective plan features extracted in Phase 0.

### Phase 0: Feature Extraction (Mandatory)

Before any verification, output the plan's feature summary to context:

```text
Plan features:
  Files: [N]
  Functions added/modified: [list or "none"]
  Behavioral claims: [none / "invariants listed" / "always/never/guaranteed assertions"]
  State machine changes: [none / describe topology delta]
→ Depth: LIGHTWEIGHT | STANDARD | ESCALATED
```

This step is NOT skippable — it creates an explicit, auditable record of what the plan claims before verification begins.

### Depth Classification

| Plan Feature | Depth |
|-------------|-------|
| Single file, zero function signatures added/modified, no behavioral claims of any kind | LIGHTWEIGHT |
| Multi-file, OR new/modified function signatures, OR implicit behavioral claims (invariants, equivalence assertions, "behavior is unchanged") | STANDARD |
| "Always"/"never"/"guaranteed" language, OR state machine topology changes (≥1 state or ≥2 transitions modified) | ESCALATED |

**"No behavioral claims" is narrow**: if the plan asserts anything about behavior preservation — including listing invariants, claiming equivalence, or saying "refactoring only, no behavior change" — that IS a behavioral claim. The absence of the literal words "always"/"never" does NOT mean there are no behavioral claims.

### Output Requirements

| Depth | Required |
|-------|----------|
| LIGHTWEIGHT | All 5 checklist items (file paths, API/type names, line numbers, behavioral claims, mechanism feasibility) answered in context with explicit results per item |
| STANDARD | Phase 1-2: enumerate every verifiable claim → verify each against codebase with evidence |
| ESCALATED | Full pipeline: Phase 1-5 including Logic Primitive Verification (Phase 2a + 2b, 22 checks) |

### Plan Verification Block

After verification, append a summary to the plan file:

```markdown
## Plan Verification

- **Depth**: [LIGHTWEIGHT / STANDARD / ESCALATED]
- **Scope**: [N] file paths, [M] API/type names, [K] line citations confirmed
- **Escalation**: [skipped — no behavioral claims detected] or [see transcript for N-check results]
```

This block is the audit trail. A future reviewer must be able to see what was verified and when.
</HARD-GATE>

## Methodology

### Phase 1: Enumerate Claims

Read the document fully. Extract every claim that is verifiable:

- Numeric claims (counts, sizes, frequencies)
- API/type/enum names
- File paths and line numbers
- Mechanism descriptions ("compile-time resolution", "static dispatch")

### Phase 2: Verify Against Codebase

For each claim, run the relevant verification:

- **Numeric claims**: `grep -c` or `grep -rn` to get the real count
- **API/type names**: extract actual signatures from headers
- **Enum/constant values**: list actual values from BSP/config headers
- **Mechanism feasibility**: check language standard and compiler support

### Phase 2 Trigger: Escalate to Logic Primitive?

If the document under review contains ANY of the following, escalate to [Logic Primitive Verification](#logic-primitive-verification) IMMEDIATELY:

- State machine or statechart with ≥3 states OR with guard conditions on transitions
- Protocol handshake, ACK/NACK, retry, or timeout sequence logic
- Claims using absolute language: "always", "never", "guaranteed", "all paths", "cannot", "impossible"
- Lock/unlock, alloc/free, start/stop paired operations where ordering matters
- Any logic where correctness depends on transition completeness or event ordering
- **Refactoring that modifies state topology**: splitting/merging states, adding/removing transitions, changing guard conditions, extracting sub-machines

**Heuristic**: If the transition-to-state ratio > 1.5 or any transition has a guard condition, the machine is complex enough to warrant verification — regardless of state count. For refactoring, trigger if the refactoring changes ≥1 state or ≥2 transitions from the original model.

### Phase 3: Gap Analysis

Classify findings by severity:

1. **Architecture-level**: claims that make the design unimplementable (fake APIs, missing modules)
2. **Mechanism-level**: claims the language/compiler cannot fulfill
3. **Consistency-level**: internal contradictions across documents

### Phase 4: Root Cause

For each error, identify why it happened:

- Wrong mental model (C++ constexpr thinking in C99)?
- Incomplete search scope?
- Copy-paste from other projects without verification?
- Misunderstanding of compiler/linker behavior?

### Phase 5: Structured Output

Each finding includes:

- Exact location (file:line or section)
- What the document claims
- What the codebase actually contains (with evidence — grep output, line numbers)
- Correction direction

---

## Logic Primitive Verification

When Phase 2 triggers escalation, do NOT proceed to Phase 3 until the verification pipeline below is complete. Trust models, not intuition.

### Pipeline Overview

```text
Document claims → Extract model → Runtime check:
  ├── DSH + `logicprobe_verify` tool available → build Model schema v1 (references/dsh-model-schema.md) → call the tool → structured report
  ├── Python available + LogicModelV1 JSON at hand → references/logicprobe-engine.py verify model.json (S1-S8/A1-A14/D1-D4; subcommands compose / export add C1-C2 and UPPAAL/TLA+/PRISM/SPIN output)
  ├── Python available + model only as extracted dicts → fill in references/verification-harness.py → run → report
  └── No Python → Manual Verification Mode (see references/logic-verification-guide.md#manual-verification-mode)

Refactoring variant:
  Old code + Refactoring plan → Extract BEFORE model + AFTER model
    → Run pipeline on AFTER model (22 checks)
    → Compare BEFORE vs AFTER: behavioral preservation, regression, complexity delta
    → Flag any invariant that held in BEFORE but fails in AFTER
```

### Refactoring Verification Mode

When the document under review is a refactoring plan (modifying existing state machine logic, not designing from scratch), adapt the pipeline:

1. **Extract the BEFORE model** from the existing codebase (not the plan — verify what the code actually does, not what the plan claims it does)
2. **Extract the AFTER model** from the refactoring plan
3. **Show both tables AND their model narratives** to the user side by side and confirm the delta is intentional
4. **Run Phase 2a + 2b on the AFTER model** — same 22 checks as new design
5. **Compare BEFORE vs AFTER**:

   | Check | Method | Severity if Violated |
   |-------|--------|:---:|
   | Behavioral preservation | Every event sequence accepted by BEFORE must also be accepted by AFTER (or explicitly removed per plan) | Error — regression |
   | Invariant continuity | Any invariant that held in BEFORE must hold in AFTER (unless the refactoring explicitly changes it) | Error — undocumented behavior change |
   | Deadlock regression | New states or transitions must not introduce deadlocks not present in BEFORE | Error |
   | Complexity claim | If plan claims "simpler": count states + transitions + guards. Is AFTER objectively simpler? | Warning — unsubstantiated claim |
   | Unreachable code | New states added in AFTER must be reachable (otherwise they're dead code from the start) | Warning |

   In DSH, pass `beforeModel` and optional `stateMapping` to `logicprobe_verify`; the engine runs D1 Behavioral Preservation, D2 Invariant Continuity, D3 Regression Delta, and D4 Deadlock/Liveness Regression automatically.

6. **Flag any behavioral delta not documented in the plan** — the most common refactoring bug is an unintended side effect that the plan doesn't acknowledge

**Detection step**: Before generating any verification code, run `python3 --version 2>&1` or `python --version 2>&1`. Check the output:

- Returns `Python 3.x.y` with x ≥ 6 → use Python harness
- Returns anything else (command not found, "Python was not found" Windows stub, version < 3.6) → fall back to Manual Verification Mode
- On Windows, if `python` launches the Microsoft Store, treat as unavailable

Do NOT attempt to install Python — the user's embedded development machine may be air-gapped or locked down.

In DSH, prefer the native `logicprobe_verify` tool (model JSON, structured guard DSL, path-aware invariants) — see `references/dsh-model-schema.md`. For non-DSH hosts: when the model is already a LogicModelV1 JSON, run the standalone JSON engine `references/logicprobe-engine.py` (verify | compose | export — an exact Python mirror of the DSH tools, cross-checked byte-for-byte by tests/python/run.mjs); when the model exists only as extracted dicts, fill in the reusable template `references/verification-harness.py`. For detailed probe patterns, model extraction methodology, and manual verification procedures, load `references/logic-verification-guide.md`.

### Phase 2a: Structural Primitives (8 Checks)

Run these FIRST. They establish basic well-formedness before adversarial probing.

| # | Primitive | Method | Severity if Violated |
|:--:|-----------|--------|:---:|
| S1 | **Reachability** | BFS from init state; flag all states not in visited set | Warning — dead code |
| S2 | **Deadlock** | Any non-terminal state with zero outgoing transitions? | Error — machine can get stuck |
| S3 | **Liveness** | Does the transition graph contain an absorbing cycle that excludes expected terminal/recovery states? (e.g. ERROR→RECOVERING→ERROR→... with no exit) | Error — infinite loop |
| S4 | **Determinism** | Same state + same event → multiple different targets? | Error — ambiguous behavior |
| S5 | **Event completeness** | For each state, are there plausible events with no defined transition? | Warning — implicit ignore |
| S6 | **Guard completeness** | For each transition with a guard condition, are ALL branch outcomes defined? `if (cnt<3) RETRY else FATAL` → both paths must exist in model | Error — undefined behavior path |
| S7 | **Invariant validity** | Does every reachable state satisfy the plan's stated "always/never/guaranteed" assertions? | Error — plan claim is false |
| S8 | **Monotonic variables** | If a variable is declared `monotonic: inc/dec`, do all updates respect that direction? | Error — counter can move backwards |

### Phase 2b: Adversarial Probes (14 Attacks)

Run these SECOND. Each probe actively tries to BREAK the model. If any probe succeeds (finds a violation), the plan has a behavior gap.

| # | Attack | Method | Target Claim |
|:--:|--------|--------|-------------|
| A1 | **Unexpected event** | For each state S, inject every event E where no transition is defined for (S, E). Log whether the model silently ignores or crashes. | "All events are handled in all states" |
| A2 | **Race interleaving** | For every pair of concurrent events (E1, E2), simulate arrival in both orders: E1-then-E2 vs E2-then-E1. Flag if terminal state differs. | "Behavior is independent of event ordering" |
| A3 | **Order permutation** | For N independent events, permute arrival order. Flag if different permutations produce different final states or violate invariants. | "Outcome is order-independent" |
| A4 | **Pair symmetry** | Match every `start/stop`, `lock/unlock`, `alloc/free` pair. Flag if any state allows a path where a pair is unbalanced (start without stop, lock without unlock). State `onEntry`/`onExit` actions are treated as implicit acquire/release. | "Resources are always released" |
| A5 | **Boundary blast** | Probe counters at 0, 1, max-1, max, max+1. Probe timestamps at 0, tick_wraparound. Flag overflow, underflow, or undefined behavior. | "Handles all counter/timer values" |
| A6 | **Resource injection** | Simulate `malloc→NULL`, `queue→full`, `semaphore→timeout` at each state that calls them. Flag if any state has no recovery path. | "Graceful degradation under resource pressure" |
| A7 | **Minimal counter-example** | For any invariant that fails, find the SHORTEST event sequence that violates it (BFS from init to violating state). Output the exact path. | "This invariant holds" → refuted by shortest path |
| A8 | **Idempotent replay** | For each event declared in `idempotentEvents`, apply it twice from every reachable state. Flag if the second application changes state or is not replayable. | "This event is safe to retry/replay" |
| A9 | **Leads-to** | From a declared source state, every path must eventually reach the target state. | "This state always progresses to completion" |
| A10 | **Sequence order** | Events declared in a sequence must occur in the specified order. | "backup before modify before commit" |
| A11 | **Atomicity** | Once an atomic event starts, the machine must commit or roll back before leaving the scope or terminating. | "all-or-nothing transaction" |
| A12 | **Budget (worst-case path cost)** | With `cost` on transitions (absent = 1) and a `budget` invariant, every reachable path must stay within budget; reports the shortest over-budget counterexample and flags reachable positive-cost cycles as unbounded. | "Worst-case path cost ≤ budget" |
| A13 | **Probability reachability (DTMC)** | With `weight` on transitions (absent = 1) and a `probability` invariant, P(ever hitting the target) must satisfy the bound; solved by value iteration over the absorbing chain. | "≥ 90% of runs reach SAFE" |
| A14 | **Deadline (discrete tick clock)** | State `maxTicks` plus top-level `tickEvents`: a tick step may not keep a state resident past its deadline; reports the over-residency path. | "must leave within 2 ticks" |

### Integration Back to Phase 3

For every probe failure:

1. **Quote** the plan claim verbatim
2. **Show** the counter-example event sequence
3. **Classify** severity (Architecture / Mechanism / Consistency)
4. **Propose** correction direction — never fix inline

### Extraction Rule

Before writing any verification code, output the model in one of the rendering
forms below. Default is Form A; switch forms when the machine is large or the
display area is narrow — never let a table row wrap.

**Form A — integrated transition table (default)**: formal symbols with their
natural-language meaning inlined; the scenario each (state, event) combination
represents is the last column:

```text
状态（含义）             | 事件（含义）          | 下一状态（含义）      | Guard?  | 场景（状态+事件）
------------------------|-----------------------|----------------------|---------|--------------------
INIT（上电待就绪）       | power_ready（电源就绪）| IDLE（空闲待命）     | -       | 就绪后进入待命
IDLE（空闲待命）         | start_cmd（启动命令） | STARTING（启动中）   | -       | 收到命令开始启动
STARTING（启动中）       | ack_received（收到ACK）| ACTIVE（运行中）    | -       | 启动成功进入运行
STARTING（启动中）       | timeout（等待超时）   | ERROR（出错待恢复）  | retry==0 | 首次超时进入重试
STARTING（启动中）       | timeout（等待超时）   | FATAL（不可恢复）    | retry>=1 | 重试耗尽转致命
ERROR（出错待恢复）      | cooldown_elapsed（冷却结束）| RECOVERING（重初始化）| -     | 冷却结束开始恢复
```

Width discipline (Form A): keep parenthetical meanings short (state/event ≤ 6
characters, scenario ≤ 10) and estimate every row's display width (CJK counts as
2) to fit the available area. If any row would wrap, shorten the meanings; if it
still will not fit, switch to Form C. A wrapped table row loses column alignment
and is harder to read than no table at all.

**Form B — sentence blocks (reading-accessible)**: one transition per block,
scenario sentence first, fixed three-line frame. Use for detailed confirmation,
users with reading difficulties, or machines with ≤ 10 transitions:

```text
第 1 步：就绪后进入待命
    状态 INIT（上电待就绪）
    发生 power_ready（电源就绪）
    进入 IDLE（空闲待命）
```

**Form C — grouped by source state (large machines / narrow panes)**: one
section per state, each rendered as its own small 3-column table
（事件（含义）| 下一状态（含义）| 场景）; no cross-group column alignment to track:

```text
DEGRADED_LOADING（降级加载）
  事件（含义）          | 下一状态（含义）      | 场景
  first_data（首帧数据）| OK_READY（正常就绪）  | 收到首帧转就绪
  fault（故障）         | FAULT（故障锁存）     | 故障锁存
  power_off（下电）     | POWER_OFF（下电）     | 下电
```

Each group table is narrow (3 columns, roughly ≤ 60 display columns with short
meanings). If one group's table would still wrap, fall back to a one-line-per-event
bullet list for that group only.

Reading rule: every row/block is one sentence — "在【状态（含义）】下发生【事件（含义）】
→ 进入【下一状态（含义）】，即【实际场景】"。Meanings repeat on purpose: each entry is
self-contained. The machine-readable model keeps the same information in its
`narrative` block (`narrative.states`, `narrative.events`, `narrative.scenarios`).

**CRITICAL**: Show the chosen form to the user and ask for confirmation before
generating the harness. Because the natural language is inlined, any entry that
reads wrong to the user — a state/event meaning that is off, or a scenario that
does not match reality — means the model is wrong even if the symbols are
consistent. The #1 failure mode of verification is extracting the wrong model. If
the plan is ambiguous, flag it as a finding first — don't guess.

**Exception**: If the runtime reports `logicprobe interaction=auto`, do NOT call
`ask_user_question`. Instead: (a) cite evidence for every cell/entry — each
state/event meaning and each scenario must trace to a source sentence, (b)
round-trip the filled model (including its `narrative` block) back into the SAME
rendering form and compare it with the extraction, and (c) mark the report
`UNCONFIRMED`.

### Code-Level Behavioral Suggestion

When the task is NOT document/plan review but involves code-level behavioral questions — e.g., the user is editing source files and asks:

- "check this timing sequence for bugs"
- "could this state machine deadlock here"
- "is this retry limit safe"
- "what happens if event X arrives during state Y"

→ **Proactively suggest** logicprobe as an optional verification pass. Do NOT escalate automatically — plan-level verification was likely already done. The suggestion is: "I can run a logic-primitive verification on this state machine to check for deadlocks, unreachable states, and boundary issues. Want me to?"

If the user says yes, extract the model from the existing code (not a plan document), and run the standard pipeline. Output the findings as suggestions, not requirements.

This covers the gap where behavioral verification is useful even when no design document is being reviewed.

### When NOT to Escalate

Skip logic-primitive verification when:

- The document makes no behavioral/logic claims (pure API listings, config tables, data schemas)
- The state machine has ≤2 states, no guards, and trivial transitions (IDLE↔ACTIVE)
- The claim is purely structural (file paths, type names, numeric constants) — Phase 2 grep verification is sufficient

## Concurrency Risk Mining

**Only use this after confirming the verification target actually has concurrency requirements or behavior** — e.g., multiple threads, async tasks, interrupts, shared state, or parallel execution. If the target is purely sequential, do not invoke concurrency mining.

logicprobe does **not** prove concurrency safety. It mines documents and plans for concurrency-related claims and flags them for dedicated verification.

- Absolute claims ("thread-safe", "lock-free", "no data race") → error / `UNVERIFIED` unless dedicated evidence is provided.
- Risk keywords ("race condition", "shared variable", "mutex", "atomic", "shared memory") → warning; review whether the plan addresses them.
- Interrupt safety is included: `interrupt-safe` / `ISR-safe` are absolute claims; `ISR`, `IRQ`, `NMI`, `critical section`, `disable_irq` / `enable_irq` are risk keywords.

In DSH, use the `logicprobe_concurrency_scan` tool. For manual review, follow `references/concurrency-risk-guide.md`.

For routing claims in dimensions logicprobe does not verify — hard real time (deadlines/periods), preemptive concurrency, hybrid control stability, probabilistic reliability, and execution-cost budgets — to dedicated tools, see `references/gap-routing-guide.md`. In `logicprobe_verify` reports, matching models carry informational `coverageNotes` with the same routing.

---

## Rules

1. Never trust a document's claim without codebase verification.
2. Be honest about mechanism boundaries — if the language standard can't do it, say so.
3. Cite evidence with specific file:line references.
4. Don't fix during review — point the way, let implementation happen after approval.
5. **For behavioral claims: verify with code, not reasoning.** If a plan says "always", "never", or "guaranteed", generate and run a model. One counter-example is enough to refute a universal claim.
6. **Confirm the model before running it** — unless the runtime reports `logicprobe interaction=auto`. Extraction errors are the dominant failure mode of formal verification. In auto mode, substitute evidence-cited extraction + round-trip validation and mark the report `UNCONFIRMED`.
7. **Don't verify what the code already checks.** If the existing codebase has compile-time assertions, static analysis, or runtime checks for a property, cite those — don't re-verify in a Python model.
