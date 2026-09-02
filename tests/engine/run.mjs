import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { runVerification, runCompositionVerification } from '../../lib/engine.js'

const root = new URL('./fixtures/', import.meta.url)

// DSH tool results must be lossless JSON: a property whose value is
// `undefined` is rejected at the host boundary even though JSON.stringify
// would silently drop it. This guards against regressions like
// `truncated: exploration.truncated || undefined`.
function assertNoUndefinedValues(value, path = 'root') {
  if (value === undefined) {
    throw new Error(`lossless JSON violation: undefined at ${path}`)
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoUndefinedValues(entry, `${path}[${index}]`))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      assertNoUndefinedValues(entry, `${path}.${key}`)
    }
  }
}

const cases = [
  {
    name: 'absorbing-scc.json',
    errors: 1,
    findings: [{ check: 'S3', code: 'S3_CLOSED_SCC' }],
  },
  {
    name: 'init-violation.json',
    errors: 1,
    findings: [
      { check: 'S7', code: 'S7_INVARIANT_VIOLATION' },
      { check: 'A7', code: 'A7_SHORTEST_COUNTEREXAMPLE' },
    ],
    assert(report) {
      const a7 = report.checks.find((check) => check.id === 'A7')
      const finding = a7?.findings.find((entry) => entry.code === 'A7_SHORTEST_COUNTEREXAMPLE')
      if (finding === undefined || finding.path === undefined || finding.path.length !== 0) {
        throw new Error('init violation must be reported with an empty shortest path')
      }
    },
  },
  {
    name: 'unbalanced-lock.json',
    errors: 1,
    findings: [{ check: 'A4', code: 'A4_NO_RELEASE_EVENT' }],
  },
  {
    name: 'event-before-state.json',
    errors: 1,
    findings: [
      { check: 'S7', code: 'S7_INVARIANT_VIOLATION' },
      { check: 'A7', code: 'A7_SHORTEST_COUNTEREXAMPLE' },
    ],
    assert(report) {
      const a7 = report.checks.find((check) => check.id === 'A7')
      const finding = a7?.findings.find((entry) => entry.code === 'A7_SHORTEST_COUNTEREXAMPLE')
      const path = finding?.path
      if (path === undefined || path.length !== 1 || path[0].from !== 'INIT' || path[0].event !== 'go' || path[0].to !== 'ACTIVE') {
        throw new Error('event-before-state violation must report INIT -go-> ACTIVE, got ' + JSON.stringify(path))
      }
    },
  },
  {
    name: 'boundary-guard.json',
    errors: 1,
    findings: [
      { check: 'S6', code: 'S6_INCOMPLETE_GUARD' },
      { check: 'A5', code: 'A5_GUARD_HOLE' },
    ],
  },
  {
    name: 'happy-path.json',
    errors: 0,
    findings: [],
  },
  {
    name: 'narrative-complete.json',
    errors: 0,
    findings: [],
    assert(report) {
      const model = JSON.parse(readFileSync(new URL('narrative-complete.json', root), 'utf8'))
      if (JSON.stringify(report.narrative) !== JSON.stringify(model.narrative)) {
        throw new Error('report must echo the model narrative block')
      }
    },
  },
  {
    name: 'retry-bounded.json',
    errors: 0,
    findings: [],
  },
  {
    name: 'retry-unbounded.json',
    errors: 1,
    findings: [{ check: 'A12', code: 'A12_BUDGET_OVER' }],
    assert(report) {
      const a12 = report.checks.find((check) => check.id === 'A12')
      const finding = a12?.findings.find((entry) => entry.code === 'A12_BUDGET_OVER')
      const path = finding?.path
      if (finding?.evidence?.unbounded !== true) throw new Error('unbounded retry must be flagged as unbounded')
      if (path === undefined || path.length < 2 || path[path.length - 1].event !== 'timeout') {
        throw new Error('unbounded retry witness must loop back through timeout, got ' + JSON.stringify(path))
      }
    },
  },
  {
    name: 'deadline-over.json',
    errors: 1,
    findings: [{ check: 'A14', code: 'A14_DEADLINE_MISS' }],
    assert(report) {
      const a14 = report.checks.find((check) => check.id === 'A14')
      const finding = a14?.findings.find((entry) => entry.code === 'A14_DEADLINE_MISS')
      const path = finding?.path
      if (path === undefined || path.length < 3 || path[path.length - 1].event !== 'tick') {
        throw new Error('deadline miss must carry the over-residency tick path, got ' + JSON.stringify(path))
      }
    },
  },
  {
    name: 'deadline-ok.json',
    errors: 0,
    findings: [],
  },
  {
    name: 'probability-ok.json',
    errors: 0,
    findings: [],
  },
  {
    name: 'probability-fail.json',
    errors: 1,
    findings: [{ check: 'A13', code: 'A13_PROBABILITY_VIOLATION' }],
    assert(report) {
      const a13 = report.checks.find((check) => check.id === 'A13')
      const finding = a13?.findings.find((entry) => entry.code === 'A13_PROBABILITY_VIOLATION')
      const computed = finding?.evidence?.computed
      if (typeof computed !== 'number' || Math.abs(computed - 0.5) > 1e-6) {
        throw new Error('expected computed P(hit B) = 0.5, got ' + JSON.stringify(computed))
      }
    },
  },
  {
    name: 'budget-over.json',
    errors: 1,
    findings: [{ check: 'A12', code: 'A12_BUDGET_OVER' }],
    assert(report) {
      const a12 = report.checks.find((check) => check.id === 'A12')
      const finding = a12?.findings.find((entry) => entry.code === 'A12_BUDGET_OVER')
      const path = finding?.path
      if (path === undefined || path.length !== 2 || path[0].event !== 'start' || path[1].event !== 'finish') {
        throw new Error('budget violation must report the full over-budget path, got ' + JSON.stringify(path))
      }
      if (finding?.evidence === undefined || finding.evidence.totalCost !== 70) {
        throw new Error('budget finding must carry totalCost 70, got ' + JSON.stringify(finding?.evidence))
      }
    },
  },
  {
    name: 'budget-ok.json',
    errors: 0,
    findings: [],
  },
  {
    name: 'entry-exit-balanced.json',
    errors: 0,
    findings: [],
  },
  {
    name: 'entry-exit-unbalanced.json',
    errors: 1,
    findings: [{ check: 'A4', code: 'A4_NO_RELEASE_EVENT' }],
  },
  {
    name: 'entry-exit-terminal.json',
    errors: 1,
    findings: [{ check: 'A4', code: 'A4_TERMINAL_WITH_RESOURCE' }],
  },
]

let failures = 0
for (const testCase of cases) {
  try {
    const text = await readFile(new URL(testCase.name, root), 'utf8')
    const model = JSON.parse(text)
    const report = runVerification(model)
    if (!report.ok) throw new Error('model did not validate: ' + JSON.stringify(report.checks[0]?.findings ?? []))
    if (report.summary.errors !== testCase.errors) {
      throw new Error('expected ' + testCase.errors + ' errors, got ' + report.summary.errors)
    }
    for (const expected of testCase.findings) {
      const check = report.checks.find((entry) => entry.id === expected.check)
      if (check === undefined || !check.findings.some((finding) => finding.code === expected.code)) {
        throw new Error('missing finding ' + expected.check + '/' + expected.code)
      }
    }
    if (testCase.assert !== undefined) testCase.assert(report)
    assertNoUndefinedValues(report)
    console.log('PASS', testCase.name)
  } catch (error) {
    failures += 1
    console.log('FAIL', testCase.name, '-', error instanceof Error ? error.message : String(error))
  }
}

// Before/after regression comparison (D1-D4)
async function runDiffTests() {
  const before = {
    schemaVersion: 1,
    init: 'INIT',
    states: [
      { id: 'INIT' },
      { id: 'ACTIVE', terminal: true },
    ],
    transitions: [
      { from: 'INIT', event: 'go', to: 'ACTIVE' },
    ],
    invariants: [
      { id: 'go-before-active', description: 'go must precede ACTIVE', kind: 'event-before-state', event: 'go', state: 'ACTIVE' },
    ],
  }
  const after = {
    schemaVersion: 1,
    init: 'INIT',
    states: [
      { id: 'INIT' },
      { id: 'ACTIVE' },
    ],
    transitions: [
      { from: 'INIT', event: 'skip', to: 'ACTIVE' },
    ],
  }
  const report = runVerification(after, { beforeModel: before })
  if (!report.ok) throw new Error('diff report should be ok: ' + JSON.stringify(report.checks[0]?.findings ?? []))
  const ids = report.checks.map((check) => check.id)
  for (const id of ['D1', 'D2', 'D3', 'D4']) {
    if (!ids.includes(id)) throw new Error('missing diff check ' + id)
  }
  const d1 = report.checks.find((check) => check.id === 'D1')
  if (!d1?.findings.some((finding) => finding.code === 'D1_EVENT_DISABLED')) throw new Error('missing D1_EVENT_DISABLED')
  const d2 = report.checks.find((check) => check.id === 'D2')
  if (!d2?.findings.some((finding) => finding.code === 'D2_INVARIANT_REGRESSION')) throw new Error('missing D2_INVARIANT_REGRESSION')
  const d4 = report.checks.find((check) => check.id === 'D4')
  if (!d4?.findings.some((finding) => finding.code === 'D4_DEADLOCK_REGRESSION')) throw new Error('missing D4_DEADLOCK_REGRESSION')
  if (report.comparison === undefined) throw new Error('missing comparison summary')
  assertNoUndefinedValues(report)
  console.log('PASS before-after-regression')

  const beforeRename = {
    schemaVersion: 1,
    init: 'IDLE',
    states: [
      { id: 'IDLE' },
      { id: 'DONE', terminal: true },
    ],
    transitions: [
      { from: 'IDLE', event: 'go', to: 'DONE' },
    ],
  }
  const afterRename = {
    schemaVersion: 1,
    init: 'READY',
    states: [
      { id: 'READY' },
      { id: 'DONE', terminal: true },
    ],
    transitions: [
      { from: 'READY', event: 'go', to: 'DONE' },
    ],
  }
  const renameReport = runVerification(afterRename, { beforeModel: beforeRename, stateMapping: { IDLE: 'READY' } })
  if (!renameReport.ok) throw new Error('rename diff report should be ok')
  const renameD1 = renameReport.checks.find((check) => check.id === 'D1')
  if (renameD1 === undefined || renameD1.findings.length !== 0) throw new Error('rename D1 should pass')
  const renameD3 = renameReport.checks.find((check) => check.id === 'D3')
  if (renameD3 === undefined || renameD3.findings.length !== 0) throw new Error('rename D3 should pass')
  assertNoUndefinedValues(renameReport)
  console.log('PASS before-after-rename-mapping')
}

// Idempotent replay (A8)
async function runIdempotencyTests() {
  const nonIdempotent = {
    schemaVersion: 1,
    init: 'A',
    states: [
      { id: 'A' },
      { id: 'B' },
      { id: 'C', terminal: true },
    ],
    transitions: [
      { from: 'A', event: 'tick', to: 'B' },
      { from: 'B', event: 'tick', to: 'C' },
    ],
    idempotentEvents: ['tick'],
  }
  const report = runVerification(nonIdempotent)
  const a8 = report.checks.find((check) => check.id === 'A8')
  if (a8 === undefined || !a8.findings.some((finding) => finding.code === 'A8_NOT_IDEMPOTENT')) {
    throw new Error('missing A8_NOT_IDEMPOTENT')
  }
  assertNoUndefinedValues(report)

  const idempotent = {
    schemaVersion: 1,
    init: 'A',
    states: [
      { id: 'A' },
      { id: 'B' },
    ],
    transitions: [
      { from: 'A', event: 'go', to: 'B' },
      { from: 'A', event: 'noop', to: 'A' },
      { from: 'B', event: 'noop', to: 'B' },
    ],
    idempotentEvents: ['noop'],
  }
  const okReport = runVerification(idempotent)
  const okA8 = okReport.checks.find((check) => check.id === 'A8')
  if (okA8 === undefined || okA8.findings.length !== 0) {
    throw new Error('A8 should pass for noop self-loops: ' + JSON.stringify(okA8?.findings ?? []))
  }
  assertNoUndefinedValues(okReport)
  console.log('PASS idempotent-replay')
}

// Advanced domain constraints (S8, A9-A11)
async function runAdvancedConstraintTests() {
  const monotonic = {
    schemaVersion: 1,
    init: 'A',
    states: [{ id: 'A' }, { id: 'B', terminal: true }],
    transitions: [
      { from: 'A', event: 'bump', to: 'A', updates: [{ variable: 'count', op: 'inc' }] },
      { from: 'A', event: 'lower', to: 'B', updates: [{ variable: 'count', op: 'dec' }] },
    ],
    variables: [{ name: 'count', kind: 'integer', init: 0, monotonic: 'inc' }],
  }
  const monoReport = runVerification(monotonic)
  const s8 = monoReport.checks.find((check) => check.id === 'S8')
  if (s8 === undefined || !s8.findings.some((finding) => finding.code === 'S8_MONOTONIC_DECREASE')) throw new Error('missing S8_MONOTONIC_DECREASE')
  assertNoUndefinedValues(monoReport)

  const leadsBad = {
    schemaVersion: 1,
    init: 'A',
    states: [{ id: 'A' }, { id: 'B', terminal: true }, { id: 'C' }],
    transitions: [
      { from: 'A', event: 'go', to: 'B' },
      { from: 'A', event: 'loop', to: 'C' },
      { from: 'C', event: 'loop', to: 'C' },
    ],
    invariants: [{ id: 'l1', description: 'A leads to B', kind: 'leads-to', from: 'A', to: 'B' }],
  }
  const leadsReport = runVerification(leadsBad)
  const a9 = leadsReport.checks.find((check) => check.id === 'A9')
  if (a9 === undefined || !a9.findings.some((finding) => finding.code === 'A9_LEADS_TO_VIOLATION')) throw new Error('missing A9_LEADS_TO_VIOLATION')
  assertNoUndefinedValues(leadsReport)

  const seqBad = {
    schemaVersion: 1,
    init: 'A',
    states: [{ id: 'A' }, { id: 'B', terminal: true }],
    transitions: [{ from: 'A', event: 'b', to: 'B' }],
    invariants: [{ id: 's1', description: 'a then b', kind: 'sequence', events: ['a', 'b'] }],
  }
  const seqReport = runVerification(seqBad)
  const a10 = seqReport.checks.find((check) => check.id === 'A10')
  if (a10 === undefined || !a10.findings.some((finding) => finding.code === 'A10_SEQUENCE_VIOLATION')) throw new Error('missing A10_SEQUENCE_VIOLATION')
  assertNoUndefinedValues(seqReport)

  const atomicBad = {
    schemaVersion: 1,
    init: 'A',
    states: [{ id: 'A' }, { id: 'B', terminal: true }],
    transitions: [{ from: 'A', event: 'write', to: 'B' }],
    invariants: [{ id: 'at1', description: 'write must commit or rollback', kind: 'atomicity', events: ['write'], commit: 'commit', rollback: 'rollback' }],
  }
  const atomicReport = runVerification(atomicBad)
  const a11 = atomicReport.checks.find((check) => check.id === 'A11')
  if (a11 === undefined || !a11.findings.some((finding) => finding.code === 'A11_ATOMICITY_VIOLATION')) throw new Error('missing A11_ATOMICITY_VIOLATION')
  assertNoUndefinedValues(atomicReport)

  const atomicOk = {
    schemaVersion: 1,
    init: 'A',
    states: [{ id: 'A' }, { id: 'B' }, { id: 'C', terminal: true }],
    transitions: [
      { from: 'A', event: 'write', to: 'B' },
      { from: 'B', event: 'commit', to: 'C' },
    ],
    invariants: [{ id: 'at2', description: 'write must commit or rollback', kind: 'atomicity', events: ['write'], commit: 'commit', rollback: 'rollback' }],
  }
  const atomicOkReport = runVerification(atomicOk)
  const okA11 = atomicOkReport.checks.find((check) => check.id === 'A11')
  if (okA11 === undefined || okA11.findings.length !== 0) throw new Error('A11 should pass for commit path')
  assertNoUndefinedValues(atomicOkReport)

  console.log('PASS advanced-constraints')
}

await runAdvancedConstraintTests()

async function runBudgetTests() {
  // cost declared without any budget invariant -> advisory warning, no error
  const noBudget = {
    schemaVersion: 1,
    init: 'A',
    states: [{ id: 'A' }, { id: 'B', terminal: true }],
    transitions: [
      { from: 'A', event: 'go', to: 'B', cost: 7 },
    ],
  }
  const warnReport = runVerification(noBudget)
  if (warnReport.summary.errors !== 0) throw new Error('cost-without-budget must not produce errors')
  const a12w = warnReport.checks.find((check) => check.id === 'A12')
  if (a12w === undefined || !a12w.findings.some((finding) => finding.code === 'A12_COST_WITHOUT_BUDGET')) {
    throw new Error('missing A12_COST_WITHOUT_BUDGET advisory')
  }
  assertNoUndefinedValues(warnReport)

  // over-budget reachable only through a positive-cost cycle
  const loopOver = {
    schemaVersion: 1,
    init: 'A',
    states: [{ id: 'A' }, { id: 'B' }],
    transitions: [
      { from: 'A', event: 'work', to: 'B', cost: 5 },
      { from: 'B', event: 'work', to: 'A', cost: 5 },
    ],
    invariants: [{ id: 'b1', description: 'spin budget', kind: 'budget', budget: 100 }],
  }
  const loopReport = runVerification(loopOver)
  const a12l = loopReport.checks.find((check) => check.id === 'A12')
  if (a12l === undefined || !a12l.findings.some((finding) => finding.code === 'A12_BUDGET_OVER')) {
    throw new Error('a positive-cost cycle must exceed the budget')
  }
  assertNoUndefinedValues(loopReport)

  // guard-split same event with different costs: only the expensive branch overshoots
  const guarded = {
    schemaVersion: 1,
    init: 'A',
    states: [{ id: 'A' }, { id: 'B' }, { id: 'C', terminal: true }],
    transitions: [
      { from: 'A', event: 'retry', guard: { variable: 'fast', op: '==', value: true }, to: 'B', cost: 10 },
      { from: 'A', event: 'retry', guard: { variable: 'fast', op: '==', value: false }, to: 'B', cost: 90 },
      { from: 'B', event: 'done', to: 'C', cost: 5 },
    ],
    variables: [{ name: 'fast', kind: 'boolean', init: false }],
    invariants: [{ id: 'b2', description: 'branch budget', kind: 'budget', budget: 50 }],
  }
  const guardedReport = runVerification(guarded)
  const a12g = guardedReport.checks.find((check) => check.id === 'A12')
  if (a12g === undefined || !a12g.findings.some((finding) => finding.code === 'A12_BUDGET_OVER')) {
    throw new Error('expensive guarded branch must exceed budget')
  }
  assertNoUndefinedValues(guardedReport)

  // DAG merge (several paths into one terminal) must NOT be treated as an unbounded cycle
  const dagMerge = {
    schemaVersion: 1,
    init: 'A',
    states: [{ id: 'A' }, { id: 'B' }, { id: 'C', terminal: true }],
    transitions: [
      { from: 'A', event: 'x', to: 'B', cost: 10 },
      { from: 'A', event: 'y', to: 'C', cost: 30 },
      { from: 'B', event: 'z', to: 'C', cost: 5 },
    ],
    invariants: [{ id: 'b3', description: 'dag budget', kind: 'budget', budget: 100 }],
  }
  const dagReport = runVerification(dagMerge)
  const a12d = dagReport.checks.find((check) => check.id === 'A12')
  if (a12d === undefined || a12d.findings.length !== 0) {
    throw new Error('a DAG merge must not be flagged as an unbounded cycle: ' + JSON.stringify(a12d?.findings))
  }
  assertNoUndefinedValues(dagReport)

  // legacy machine without cost/budget: A12 passes cleanly and total checks stay 20
  const legacy = {
    schemaVersion: 1,
    init: 'A',
    states: [{ id: 'A' }, { id: 'B', terminal: true }],
    transitions: [{ from: 'A', event: 'go', to: 'B' }],
  }
  const legacyReport = runVerification(legacy)
  const a12 = legacyReport.checks.find((check) => check.id === 'A12')
  if (a12 === undefined || a12.findings.length !== 0 || a12.status !== 'pass') throw new Error('A12 must pass cleanly for legacy machines')
  if (legacyReport.summary.checksRun !== 22) throw new Error('expected 22 checks, got ' + legacyReport.summary.checksRun)
  assertNoUndefinedValues(legacyReport)
  console.log('PASS budget-tests')
}

await runBudgetTests()

async function runActionTests() {
  // reacquire inside a single onEntry list -> warning
  const reacquire = {
    schemaVersion: 1,
    init: 'A',
    states: [{ id: 'A' }, { id: 'B', onEntry: ['lock', 'lock'], onExit: ['unlock'] }, { id: 'C', terminal: true }],
    transitions: [
      { from: 'A', event: 'go', to: 'B' },
      { from: 'B', event: 'finish', to: 'C' },
    ],
    resourcePairs: [{ resource: 'mutex', acquireEvent: 'lock', releaseEvent: 'unlock' }],
  }
  const reacquireReport = runVerification(reacquire)
  const a4r = reacquireReport.checks.find((check) => check.id === 'A4')
  if (a4r === undefined || !a4r.findings.some((finding) => finding.code === 'A4_REACQUIRE_WITHOUT_RELEASE')) {
    throw new Error('double acquire inside onEntry must warn')
  }
  assertNoUndefinedValues(reacquireReport)

  // acquire inside onExit fires on every outgoing edge
  const exitAcquire = {
    schemaVersion: 1,
    init: 'A',
    states: [{ id: 'A', onExit: ['lock'] }, { id: 'B', terminal: true }, { id: 'C', terminal: true }],
    transitions: [
      { from: 'A', event: 'toB', to: 'B' },
      { from: 'A', event: 'toC', to: 'C' },
    ],
    resourcePairs: [{ resource: 'mutex', acquireEvent: 'lock', releaseEvent: 'unlock' }],
  }
  // unlock is never defined anywhere -> A4_NO_RELEASE_EVENT
  const exitReport = runVerification(exitAcquire)
  const a4e = exitReport.checks.find((check) => check.id === 'A4')
  if (a4e === undefined || !a4e.findings.some((finding) => finding.code === 'A4_NO_RELEASE_EVENT')) {
    throw new Error('exit-acquire with no release anywhere must be flagged')
  }
  assertNoUndefinedValues(exitReport)

  // malformed onEntry -> model validation failure
  const badActions = {
    schemaVersion: 1,
    init: 'A',
    states: [{ id: 'A', onEntry: [5] }, { id: 'B', terminal: true }],
    transitions: [{ from: 'A', event: 'go', to: 'B' }],
  }
  const badReport = runVerification(badActions)
  if (badReport.ok || !badReport.checks[0].findings.some((finding) => finding.message.includes('onEntry'))) {
    throw new Error('non-string onEntry must fail model validation')
  }
  assertNoUndefinedValues(badReport)
  console.log('PASS action-tests')
}

await runActionTests()

async function runCoverageNoteTests() {
  // timing + preemption vocabulary triggers informational notes
  const control = {
    schemaVersion: 1,
    init: 'IDLE',
    states: [{ id: 'IDLE' }, { id: 'RUN' }, { id: 'SAFE', terminal: true }],
    transitions: [
      { from: 'IDLE', event: 'start', to: 'RUN' },
      { from: 'RUN', event: 'watchdog_timeout', to: 'SAFE' },
      { from: 'RUN', event: 'isr_cmd', to: 'RUN' },
    ],
  }
  const report = runVerification(control)
  if (!report.ok) throw new Error('control model should verify')
  if (!Array.isArray(report.coverageNotes) || report.coverageNotes.length !== 2) {
    throw new Error('expected two coverage notes (timing + preemption), got ' + JSON.stringify(report.coverageNotes))
  }
  if (!report.coverageNotes.some((note) => note.includes('UPPAAL'))) throw new Error('timing note should route to UPPAAL')
  if (!report.coverageNotes.some((note) => note.includes('preemptive'))) throw new Error('preemption note must be present')
  assertNoUndefinedValues(report)

  // hybrid + probabilistic vocabulary routes to SpaceEx/PRISM
  const hybridProb = {
    schemaVersion: 1,
    init: 'IDLE',
    states: [{ id: 'IDLE' }, { id: 'RUN' }, { id: 'SAFE', terminal: true }],
    transitions: [
      { from: 'IDLE', event: 'pid_tune', to: 'RUN' },
      { from: 'RUN', event: 'mtbf_report', to: 'SAFE' },
    ],
  }
  const hpReport = runVerification(hybridProb)
  if (!Array.isArray(hpReport.coverageNotes) || hpReport.coverageNotes.length !== 2) {
    throw new Error('expected two coverage notes (hybrid + probabilistic), got ' + JSON.stringify(hpReport.coverageNotes))
  }
  if (!hpReport.coverageNotes.some((note) => note.includes('SpaceEx'))) throw new Error('hybrid note should route to SpaceEx')
  if (!hpReport.coverageNotes.some((note) => note.includes('PRISM'))) throw new Error('probabilistic note should route to PRISM')
  assertNoUndefinedValues(hpReport)

  // plain machine with no risky vocabulary: no coverage notes at all
  const plain = {
    schemaVersion: 1,
    init: 'A',
    states: [{ id: 'A' }, { id: 'B', terminal: true }],
    transitions: [{ from: 'A', event: 'go', to: 'B' }],
  }
  const plainReport = runVerification(plain)
  if (plainReport.coverageNotes !== undefined) throw new Error('plain model must not carry coverage notes')
  assertNoUndefinedValues(plainReport)
  console.log('PASS coverage-note-tests')
}

await runCoverageNoteTests()

async function runProbabilityTests() {
  // DTMC with a cycle: P(hit B) converges to 1
  const cycle = {
    schemaVersion: 1,
    init: 'A',
    states: [{ id: 'A' }, { id: 'B', terminal: true }],
    transitions: [
      { from: 'A', event: 'retry', to: 'A', weight: 1 },
      { from: 'A', event: 'ok', to: 'B', weight: 1 },
    ],
    invariants: [{ id: 'pc', description: 'almost surely reaches B', kind: 'probability', target: 'B', op: '>=', p: 0.9999 }],
  }
  const cycleReport = runVerification(cycle)
  const a13c = cycleReport.checks.find((check) => check.id === 'A13')
  if (a13c === undefined || a13c.findings.length !== 0) {
    throw new Error('P(hit B)=1 cycle must satisfy >=0.9999: ' + JSON.stringify(a13c?.findings))
  }
  assertNoUndefinedValues(cycleReport)

  // skewed weights: P = 9/10
  const skewed = {
    schemaVersion: 1,
    init: 'A',
    states: [{ id: 'A' }, { id: 'B', terminal: true }, { id: 'C', terminal: true }],
    transitions: [
      { from: 'A', event: 'ok', to: 'B', weight: 9 },
      { from: 'A', event: 'bad', to: 'C', weight: 1 },
    ],
    invariants: [{ id: 'ps', description: 'success rate 90%', kind: 'probability', target: 'B', op: '>=', p: 0.85 }],
  }
  const skewedReport = runVerification(skewed)
  const a13s = skewedReport.checks.find((check) => check.id === 'A13')
  if (a13s === undefined || a13s.findings.length !== 0) throw new Error('skewed 9:1 must satisfy >=0.85')
  assertNoUndefinedValues(skewedReport)

  // weight 0 = branch never fires probabilistically -> P = 1
  const zeroWeight = {
    schemaVersion: 1,
    init: 'A',
    states: [{ id: 'A' }, { id: 'B', terminal: true }, { id: 'C', terminal: true }],
    transitions: [
      { from: 'A', event: 'ok', to: 'B', weight: 1 },
      { from: 'A', event: 'bad', to: 'C', weight: 0 },
    ],
    invariants: [{ id: 'pz', description: 'bad branch disabled', kind: 'probability', target: 'B', op: '>=', p: 0.999 }],
  }
  const zeroReport = runVerification(zeroWeight)
  const a13z = zeroReport.checks.find((check) => check.id === 'A13')
  if (a13z === undefined || a13z.findings.length !== 0) throw new Error('zero-weight branch must not fire')
  assertNoUndefinedValues(zeroReport)

  // malformed probability invariants must fail model validation
  const badP = { schemaVersion: 1, init: 'A', states: [{ id: 'A' }, { id: 'B', terminal: true }], transitions: [{ from: 'A', event: 'go', to: 'B' }], invariants: [{ id: 'x', description: 'x', kind: 'probability', target: 'B', op: '>=', p: 1.5 }] }
  if (runVerification(badP).ok) throw new Error('p=1.5 must fail validation')
  const badW = { schemaVersion: 1, init: 'A', states: [{ id: 'A' }, { id: 'B', terminal: true }], transitions: [{ from: 'A', event: 'go', to: 'B', weight: -1 }] }
  if (runVerification(badW).ok) throw new Error('weight=-1 must fail validation')
  console.log('PASS probability-tests')
}

await runProbabilityTests()

async function runCompositionTests() {
  // textbook handshake: A sends req, B acks — rendezvous keeps both in lockstep
  const machineA = {
    schemaVersion: 1, init: 'A0',
    states: [{ id: 'A0' }, { id: 'A_REQ' }, { id: 'A_WAIT' }, { id: 'A_DONE', terminal: true }],
    transitions: [
      { from: 'A0', event: 'start', to: 'A_REQ' },
      { from: 'A_REQ', event: 'req', to: 'A_WAIT' },
      { from: 'A_WAIT', event: 'ack', to: 'A_DONE' },
    ],
  }
  const machineB = {
    schemaVersion: 1, init: 'B0',
    states: [{ id: 'B0' }, { id: 'B_BUSY' }, { id: 'B_DONE', terminal: true }],
    transitions: [
      { from: 'B0', event: 'req', to: 'B_BUSY' },
      { from: 'B_BUSY', event: 'ack', to: 'B_DONE' },
    ],
  }
  const okReport = runCompositionVerification([machineA, machineB], { rendezvous: ['req', 'ack'] })
  if (!okReport.ok || okReport.summary.errors !== 0) throw new Error('handshake composition must pass: ' + JSON.stringify(okReport.checks))
  const c2ok = okReport.checks.find((check) => check.id === 'C2')
  if (c2ok === undefined || c2ok.findings.length !== 0) throw new Error('rendezvous should fire: ' + JSON.stringify(c2ok?.findings))
  assertNoUndefinedValues(okReport)

  // classic bug: B can never be ready for req -> A is left blocked (composition deadlock)
  const stuckB = {
    schemaVersion: 1, init: 'B0',
    states: [{ id: 'B0' }, { id: 'B_DONE', terminal: true }],
    transitions: [{ from: 'B0', event: 'ack', to: 'B_DONE' }],
  }
  const deadReport = runCompositionVerification([machineA, stuckB], { rendezvous: ['req', 'ack'] })
  const c1 = deadReport.checks.find((check) => check.id === 'C1')
  if (c1 === undefined || !c1.findings.some((finding) => finding.code === 'C1_COMPOSITION_DEADLOCK')) {
    throw new Error('blocked handshake must deadlock: ' + JSON.stringify(deadReport.checks))
  }
  if (deadReport.summary.errors === 0) throw new Error('expected composition errors')
  assertNoUndefinedValues(deadReport)

  // rendezvous against a machine that is terminal from the start can never fire
  const terminalB = {
    schemaVersion: 1, init: 'B_DONE',
    states: [{ id: 'B_DONE', terminal: true }],
    transitions: [],
  }
  const termA = {
    schemaVersion: 1, init: 'A0',
    states: [{ id: 'A0' }, { id: 'A1', terminal: true }],
    transitions: [{ from: 'A0', event: 'req', to: 'A1' }],
  }
  const termReport = runCompositionVerification([termA, terminalB], { rendezvous: ['req'] })
  const c1t = termReport.checks.find((check) => check.id === 'C1')
  if (c1t === undefined || !c1t.findings.some((finding) => finding.code === 'C1_COMPOSITION_DEADLOCK')) {
    throw new Error('terminal peer must block the rendezvous (deadlock at init)')
  }
  assertNoUndefinedValues(termReport)

  // 3-machine chain: all three must be jointly ready on req and on ack
  const chainA = { schemaVersion: 1, init: 'A0', states: [{ id: 'A0' }, { id: 'A1' }, { id: 'A2' }, { id: 'A3', terminal: true }], transitions: [{ from: 'A0', event: 'start', to: 'A1' }, { from: 'A1', event: 'req', to: 'A2' }, { from: 'A2', event: 'ack', to: 'A3' }] }
  const chainB = { schemaVersion: 1, init: 'B0', states: [{ id: 'B0' }, { id: 'B1' }, { id: 'B2', terminal: true }], transitions: [{ from: 'B0', event: 'req', to: 'B1' }, { from: 'B1', event: 'ack', to: 'B2' }] }
  const chainC = { schemaVersion: 1, init: 'C0', states: [{ id: 'C0' }, { id: 'C1' }, { id: 'C2', terminal: true }], transitions: [{ from: 'C0', event: 'req', to: 'C1' }, { from: 'C1', event: 'ack', to: 'C2' }] }
  const chainOk = runCompositionVerification([chainA, chainB, chainC], { rendezvous: ['req', 'ack'] })
  if (!chainOk.ok || chainOk.summary.errors !== 0) throw new Error('3-machine chain must pass: ' + JSON.stringify(chainOk.checks))
  if (chainOk.summary.machineCount !== 3) throw new Error('machineCount should be 3')
  const c2c = chainOk.checks.find((check) => check.id === 'C2')
  if (c2c === undefined || c2c.findings.length !== 0) throw new Error('chain rendezvous must fire: ' + JSON.stringify(c2c?.findings))
  assertNoUndefinedValues(chainOk)

  // 3-machine chain desync: C drops out of the ack handshake -> A/B advance, C is left stranded
  const chainCdrop = { schemaVersion: 1, init: 'C0', states: [{ id: 'C0' }, { id: 'C1' }], transitions: [{ from: 'C0', event: 'req', to: 'C1' }] }
  const chainBad = runCompositionVerification([chainA, chainB, chainCdrop], { rendezvous: ['req', 'ack'] })
  const c1bad = chainBad.checks.find((check) => check.id === 'C1')
  if (c1bad === undefined || !c1bad.findings.some((finding) => finding.code === 'C1_COMPOSITION_DEADLOCK')) {
    throw new Error('dropped chain partner must surface as composition deadlock: ' + JSON.stringify(chainBad.checks))
  }
  assertNoUndefinedValues(chainBad)

  // fewer than two machines is rejected
  const one = runCompositionVerification([chainA])
  if (one.ok) throw new Error('single machine must be rejected')
  assertNoUndefinedValues(one)

  // invalid machine fails cleanly
  const bad = runCompositionVerification([machineA, { schemaVersion: 1, init: 'X', states: [{ id: 'Y' }], transitions: [] }])
  if (bad.ok) throw new Error('invalid machine must fail composition')
  assertNoUndefinedValues(bad)
  console.log('PASS composition-tests')
}

await runCompositionTests()

// Textbook canon: named cases from the formal-methods / systems literature, each mapped
// to the check it exercises. Expected outcomes are asserted per case.
async function runTextbookCanonTests() {
  const load = async (name) => JSON.parse(readFileSync(new URL(name, root), 'utf8'))
  const code = (report, checkId, want) => {
    const c = report.checks.find((entry) => entry.id === checkId)
    return c !== undefined && c.findings.some((finding) => finding.code === want)
  }

  // Two-Phase Commit (Gray): participant strands in WAITING with no outgoing transition
  const tpcStuck = await load('twophase-participant-stuck.json')
  const stuckReport = runVerification(tpcStuck)
  if (!code(stuckReport, 'S2', 'S2_NO_TRANSITIONS')) throw new Error('2PC participant deadlock: S2 must fire')
  assertNoUndefinedValues(stuckReport)

  // Vending machine (classic): one coin event ambiguously leads to both DISPENSE and REFUND
  const vending = await load('vending-ambiguous.json')
  const vendReport = runVerification(vending)
  if (!code(vendReport, 'S4', 'S4_AMBIGUOUS_DEFAULT')) throw new Error('vending ambiguity: S4 must fire')
  assertNoUndefinedValues(vendReport)

  // Two-Phase Commit ordering: commit before prepare must violate prepare-before-commit
  const tpcOrder = await load('twophase-order.json')
  const orderReport = runVerification(tpcOrder)
  if (!code(orderReport, 'A10', 'A10_SEQUENCE_VIOLATION')) throw new Error('2PC commit-before-prepare: A10 must fire')
  assertNoUndefinedValues(orderReport)

  // TCP half-close (RFC 793 style): ESTABLISHED silently ignores RST that other states handle
  const tcp = await load('tcp-missing-rst.json')
  const tcpReport = runVerification(tcp)
  if (!code(tcpReport, 'S5', 'S5_UNHANDLED_EVENT')) throw new Error('TCP missing RST handler: S5 must fire')
  assertNoUndefinedValues(tcpReport)

  // Gambler's ruin (Markov chain textbook): P(broke first) = 4/5 from $1 with a fair coin
  const ruin = await load('gamblers-ruin.json')
  const ruinReport = runVerification(ruin)
  const a13r = ruinReport.checks.find((entry) => entry.id === 'A13')
  if (a13r === undefined || a13r.findings.length !== 0) throw new Error('gambler ruin 0.8 >= 0.75 must pass: ' + JSON.stringify(a13r?.findings))
  if (ruinReport.summary.errors !== 0) throw new Error('gambler ruin should have no errors')
  assertNoUndefinedValues(ruinReport)
  const ruinClaim = JSON.parse(JSON.stringify(ruin))
  ruinClaim.invariants[0].p = 0.9
  const ruinFail = runVerification(ruinClaim)
  if (!code(ruinFail, 'A13', 'A13_PROBABILITY_VIOLATION')) throw new Error('claiming P>=0.9 must violate the true 0.8')
  assertNoUndefinedValues(ruinFail)

  // ISR vs task shared counter (embedded classic): event order changes the outcome
  const counterRace = {
    schemaVersion: 1, init: 'RUN',
    states: [{ id: 'RUN' }, { id: 'DONE', terminal: true }],
    variables: [{ name: 'v', kind: 'integer', init: 0 }],
    transitions: [
      { from: 'RUN', event: 'isr_write', to: 'RUN', updates: [{ variable: 'v', op: 'set', value: 1 }] },
      { from: 'RUN', event: 'task_write', to: 'RUN', updates: [{ variable: 'v', op: 'set', value: 2 }] },
      { from: 'RUN', event: 'stop', to: 'DONE' },
    ],
    concurrentPairs: [['isr_write', 'task_write']],
  }
  const raceReport = runVerification(counterRace)
  if (!code(raceReport, 'A2', 'A2_ORDER_DEPENDENT')) throw new Error('ISR/task write race: A2 must fire')
  assertNoUndefinedValues(raceReport)

  // Semaphore take without a timeout path (embedded classic): allocation can block forever
  const semTake = {
    schemaVersion: 1, init: 'WAIT',
    states: [{ id: 'WAIT' }, { id: 'READY' }, { id: 'RELEASED' }, { id: 'DONE', terminal: true }],
    transitions: [
      { from: 'WAIT', event: 'take', to: 'READY' },
      { from: 'READY', event: 'give', to: 'RELEASED' },
      { from: 'RELEASED', event: 'finish', to: 'DONE' },
    ],
    resourcePairs: [{ resource: 'queue', acquireEvent: 'take', failEvent: 'timeout', releaseEvent: 'give' }],
  }
  const semReport = runVerification(semTake)
  if (semReport.summary.errors !== 0) throw new Error('semaphore model should have no errors')
  if (!code(semReport, 'A6', 'A6_NO_FAILURE_HANDLER')) throw new Error('missing timeout handler: A6 must fire')
  assertNoUndefinedValues(semReport)

  // Webhook redelivery (distributed systems classic): notify is not idempotent
  const webhook = {
    schemaVersion: 1, init: 'A',
    states: [{ id: 'A' }, { id: 'B' }, { id: 'C', terminal: true }],
    transitions: [
      { from: 'A', event: 'notify', to: 'B' },
      { from: 'B', event: 'notify', to: 'C' },
    ],
    idempotentEvents: ['notify'],
  }
  const webReport = runVerification(webhook)
  if (!code(webReport, 'A8', 'A8_NOT_IDEMPOTENT')) throw new Error('redelivered notify changes state: A8 must fire')
  assertNoUndefinedValues(webReport)

  console.log('PASS textbook-canon')
}

await runTextbookCanonTests()

async function runDeadlineTests() {
  // advisory: maxTicks declared but no tickEvents -> cannot verify
  const noTicks = {
    schemaVersion: 1, init: 'A',
    states: [{ id: 'A', maxTicks: 3 }, { id: 'B', terminal: true }],
    transitions: [{ from: 'A', event: 'go', to: 'B' }],
  }
  const noTicksReport = runVerification(noTicks)
  if (noTicksReport.summary.errors !== 0) throw new Error('missing tickEvents must not error')
  const a14n = noTicksReport.checks.find((check) => check.id === 'A14')
  if (a14n === undefined || !a14n.findings.some((finding) => finding.code === 'A14_NO_TICK_EVENTS')) {
    throw new Error('expected A14_NO_TICK_EVENTS advisory')
  }
  assertNoUndefinedValues(noTicksReport)

  // deadline respected: every tick leaves the guarded state before the limit
  const ok = {
    schemaVersion: 1, init: 'IDLE',
    states: [{ id: 'IDLE' }, { id: 'BUSY', maxTicks: 2 }, { id: 'DONE', terminal: true }],
    transitions: [
      { from: 'IDLE', event: 'fault', to: 'BUSY' },
      { from: 'BUSY', event: 'tick', to: 'DONE' },
      { from: 'BUSY', event: 'recover', to: 'DONE' },
    ],
    tickEvents: ['tick'],
  }
  const okReport = runVerification(ok)
  const a14o = okReport.checks.find((check) => check.id === 'A14')
  if (a14o === undefined || a14o.findings.length !== 0) throw new Error('deadline-respecting watchdog must pass')
  assertNoUndefinedValues(okReport)

  // invalid maxTicks fails validation
  const bad = { schemaVersion: 1, init: 'A', states: [{ id: 'A', maxTicks: -1 }, { id: 'B', terminal: true }], transitions: [{ from: 'A', event: 'go', to: 'B' }] }
  if (runVerification(bad).ok) throw new Error('negative maxTicks must fail validation')
  console.log('PASS deadline-tests')
}

await runDeadlineTests()

// Textbook canon II: classic concurrent algorithms + biased Markov chains
async function runCanonTwoTests() {
  const code = (report, checkId, want) => {
    const c = report.checks.find((entry) => entry.id === checkId)
    return c !== undefined && c.findings.some((finding) => finding.code === want)
  }

  // Peterson mutual exclusion (classic): pc encodes each process state
  // 0 idle, 1 want/wait, 2 in CS, 3 done (terminal). flag_i is a 0/1 integer var.
  const peterson = (bug) => {
    const id = (a, b) => 'P1_' + a + '_P2_' + b
    const states = []
    for (let a = 0; a <= 3; a++) for (let b = 0; b <= 3; b++) {
      states.push({ id: id(a, b), terminal: a === 3 && b === 3 })
    }
    const transitions = []
    const flag1 = { variable: 'flag1', op: '==', value: 1 }
    const flag2 = { variable: 'flag2', op: '==', value: 1 }
    for (let a = 0; a <= 3; a++) for (let b = 0; b <= 3; b++) {
      const from = id(a, b)
      // process 1
      if (a === 0) {
        transitions.push({ from, event: 'p1step', to: id(1, b), updates: [{ variable: 'flag1', op: 'set', value: 1 }, { variable: 'turn', op: 'set', value: 2 }] })
      } else if (a === 1) {
        if (!bug) {
          transitions.push({ from, event: 'p1step', guard: { all: [flag2, { variable: 'turn', op: '==', value: 2 }] }, to: from })
        }
        transitions.push({ from, event: 'p1step', to: id(2, b) })
      } else if (a === 2) {
        transitions.push({ from, event: 'p1step', to: id(3, b), updates: [{ variable: 'flag1', op: 'set', value: 0 }] })
      }
      // process 2 (mirror; waits while flag1 && turn == 1)
      if (b === 0) {
        transitions.push({ from, event: 'p2step', to: id(a, 1), updates: [{ variable: 'flag2', op: 'set', value: 1 }, { variable: 'turn', op: 'set', value: 1 }] })
      } else if (b === 1) {
        if (!bug) {
          transitions.push({ from, event: 'p2step', guard: { all: [flag1, { variable: 'turn', op: '==', value: 1 }] }, to: from })
        }
        transitions.push({ from, event: 'p2step', to: id(a, 2) })
      } else if (b === 2) {
        transitions.push({ from, event: 'p2step', to: id(a, 3), updates: [{ variable: 'flag2', op: 'set', value: 0 }] })
      }
    }
    return {
      schemaVersion: 1, init: id(0, 0),
      states,
      transitions,
      variables: [
        { name: 'flag1', kind: 'integer', init: 0, min: 0, max: 1 },
        { name: 'flag2', kind: 'integer', init: 0, min: 0, max: 1 },
        { name: 'turn', kind: 'integer', init: 1, min: 1, max: 2 },
      ],
      invariants: [{ id: 'mutex', description: 'at most one process in the critical section', kind: 'never-states', states: [id(2, 2)] }],
    }
  }
  const correct = runVerification(peterson(false))
  if (correct.summary.errors !== 0) throw new Error('Peterson must be deadlock-free and mutually exclusive: ' + JSON.stringify(correct.checks.filter((c) => c.findings.some((f) => f.severity === 'error')).map((c) => c.id + ':' + c.findings.map((f) => f.code))))
  assertNoUndefinedValues(correct)
  const buggy = runVerification(peterson(true))
  if (!code(buggy, 'S7', 'S7_INVARIANT_VIOLATION')) throw new Error('Peterson without the wait condition must violate mutual exclusion')
  assertNoUndefinedValues(buggy)

  // Producer-consumer with a rendezvous 'put' (single-slot CSP style)
  const producer = { schemaVersion: 1, init: 'P0', states: [{ id: 'P0' }, { id: 'P1' }], transitions: [{ from: 'P0', event: 'make', to: 'P1' }, { from: 'P1', event: 'put', to: 'P0' }] }
  const consumer = { schemaVersion: 1, init: 'C0', states: [{ id: 'C0' }, { id: 'C1' }], transitions: [{ from: 'C0', event: 'put', to: 'C1' }, { from: 'C1', event: 'use', to: 'C0' }] }
  const pcOk = runCompositionVerification([producer, consumer], { rendezvous: ['put'] })
  if (!pcOk.ok || pcOk.summary.errors !== 0) throw new Error('producer-consumer rendezvous must pass: ' + JSON.stringify(pcOk.checks))
  assertNoUndefinedValues(pcOk)
  const stuckConsumer = { schemaVersion: 1, init: 'C0', states: [{ id: 'C0' }, { id: 'C1' }], transitions: [{ from: 'C0', event: 'put', to: 'C1' }] }
  const pcBad = runCompositionVerification([producer, stuckConsumer], { rendezvous: ['put'] })
  if (!code(pcBad, 'C1', 'C1_COMPOSITION_DEADLOCK')) throw new Error('consumer that never drains must deadlock the producer')
  assertNoUndefinedValues(pcBad)

  // Biased gambler: win weight 4, lose weight 6 (p_win = 0.4); P(broke first) from $1, N=$5 = 0.924...
  const ruin = JSON.parse(readFileSync(new URL('gamblers-ruin.json', root), 'utf8'))
  for (const t of ruin.transitions) {
    if (t.event === 'win') t.weight = 4
    if (t.event === 'lose') t.weight = 6
  }
  ruin.invariants = [
    { id: 'biased-ruin', description: 'P(broke) ~ 0.924 with p_win = 0.4', kind: 'probability', target: 'BROKE', op: '>=', p: 0.9 },
  ]
  const biasedOk = runVerification(ruin)
  if (biasedOk.summary.errors !== 0) throw new Error('biased ruin 0.924 >= 0.9 must pass: ' + JSON.stringify(biasedOk.checks.find((c) => c.id === 'A13')))
  const ruinClaim = JSON.parse(JSON.stringify(ruin))
  ruinClaim.invariants[0].p = 0.93
  if (!code(runVerification(ruinClaim), 'A13', 'A13_PROBABILITY_VIOLATION')) throw new Error('claiming P >= 0.93 must violate the true 0.924')
  console.log('PASS canon-two')
}

await runCanonTwoTests()

// Stress: larger machines must terminate and respect caps without hanging
async function runStressTests() {
  // 300-state linear chain, all checks
  const chain = { schemaVersion: 1, init: 's0', states: [], transitions: [] }
  for (let i = 0; i < 300; i++) chain.states.push({ id: 's' + i, terminal: i === 299 })
  for (let i = 0; i < 299; i++) chain.transitions.push({ from: 's' + i, event: 'next', to: 's' + (i + 1) })
  const chainReport = runVerification(chain)
  if (!chainReport.ok || chainReport.summary.errors !== 0) throw new Error('300-state chain must pass')
  assertNoUndefinedValues(chainReport)

  // composition of two 80-state machines, then force truncation with a small cap
  const make = (p) => { const m = { schemaVersion: 1, init: 'm' + p + '_0', states: [], transitions: [] }; for (let i = 0; i < 80; i++) m.states.push({ id: 'm' + p + '_' + i, terminal: i === 79 }); for (let i = 0; i < 79; i++) m.transitions.push({ from: 'm' + p + '_' + i, event: 'step' + p, to: 'm' + p + '_' + (i + 1) }); return m }
  const bigA = make('a'); const bigB = make('b')
  const composed = runCompositionVerification([bigA, bigB])
  if (!composed.ok || composed.summary.truncated) throw new Error('80x80 product should complete: ' + JSON.stringify(composed.summary))
  assertNoUndefinedValues(composed)
  const capped = runCompositionVerification([bigA, bigB], { maxStates: 500 })
  if (!capped.summary.truncated) throw new Error('small maxStates must truncate the product exploration')
  assertNoUndefinedValues(capped)

  // deep DTMC chain: value iteration must converge, not hang
  const deep = { schemaVersion: 1, init: 'n0', states: [], transitions: [], invariants: [] }
  for (let i = 0; i < 120; i++) deep.states.push({ id: 'n' + i, terminal: i === 119 })
  for (let i = 0; i < 119; i++) deep.transitions.push({ from: 'n' + i, event: 'next', to: 'n' + (i + 1), weight: 1 })
  deep.invariants.push({ id: 'reaches-end', description: 'deterministic chain reaches the end', kind: 'probability', target: 'n119', op: '>=', p: 0.999999 })
  const deepReport = runVerification(deep)
  const a13 = deepReport.checks.find((c) => c.id === 'A13')
  if (a13 === undefined || a13.findings.length !== 0) throw new Error('deep chain P=1 must pass: ' + JSON.stringify(a13?.findings))
  assertNoUndefinedValues(deepReport)
  console.log('PASS stress-tests')
}

await runStressTests()

// Textbook canon III: order dependence, dead-code reachability, guard coverage positives
async function runCanonThreeTests() {
  const code = (report, checkId, want) => {
    const c = report.checks.find((entry) => entry.id === checkId)
    return c !== undefined && c.findings.some((finding) => finding.code === want)
  }

  // Ledger example: book A then B ends in DONE1, B then A in DONE2 (order matters)
  const nonCommutative = {
    schemaVersion: 1, init: 'INIT',
    states: [{ id: 'INIT' }, { id: 'P' }, { id: 'Q' }, { id: 'DONE1', terminal: true }, { id: 'DONE2', terminal: true }],
    transitions: [
      { from: 'INIT', event: 'book_a', to: 'P' },
      { from: 'INIT', event: 'book_b', to: 'Q' },
      { from: 'P', event: 'book_b', to: 'DONE1' },
      { from: 'Q', event: 'book_a', to: 'DONE2' },
    ],
  }
  const orderReport = runVerification(nonCommutative)
  if (!code(orderReport, 'A3', 'A3_ORDER_DEPENDENT')) throw new Error('non-commutative bookings must be order-dependent (A3)')
  assertNoUndefinedValues(orderReport)

  // Commutative twin: either order ends in the same DONE
  const commutative = {
    schemaVersion: 1, init: 'INIT',
    states: [{ id: 'INIT' }, { id: 'M' }, { id: 'DONE', terminal: true }],
    transitions: [
      { from: 'INIT', event: 'book_a', to: 'M' },
      { from: 'INIT', event: 'book_b', to: 'M' },
      { from: 'M', event: 'book_a', to: 'DONE' },
      { from: 'M', event: 'book_b', to: 'DONE' },
    ],
  }
  const commReport = runVerification(commutative)
  const a3c = commReport.checks.find((entry) => entry.id === 'A3')
  if (a3c === undefined || a3c.findings.some((finding) => finding.code === 'A3_ORDER_DEPENDENT')) {
    throw new Error('commutative bookings must be order-independent')
  }
  assertNoUndefinedValues(commReport)

  // Refactoring dead code: the legacy V1 path is no longer reachable after the V2 migration
  const deadCode = {
    schemaVersion: 1, init: 'NEW_INIT',
    states: [{ id: 'NEW_INIT' }, { id: 'ACTIVE' }, { id: 'DONE', terminal: true }, { id: 'LEGACY_V1', terminal: true }],
    transitions: [
      { from: 'NEW_INIT', event: 'go', to: 'ACTIVE' },
      { from: 'ACTIVE', event: 'finish', to: 'DONE' },
    ],
  }
  const deadReport = runVerification(deadCode)
  if (!code(deadReport, 'S1', 'S1_UNREACHABLE_STATE')) throw new Error('LEGACY_V1 must be flagged unreachable')
  assertNoUndefinedValues(deadReport)

  console.log('PASS canon-three')
}

await runCanonThreeTests()







await runIdempotencyTests()

await runDiffTests()

async function runNarrativeValidationTests() {
  const complete = {
    schemaVersion: 1,
    init: 'A',
    states: [{ id: 'A' }, { id: 'B', terminal: true }],
    transitions: [{ from: 'A', event: 'go', to: 'B' }],
    narrative: {
      states: { A: 'start', B: 'done' },
      events: { go: 'go ahead' },
      scenarios: [{ from: 'A', event: 'go', scenario: 'start -> done' }],
    },
  }
  const okReport = runVerification(complete)
  if (!okReport.ok) throw new Error('complete narrative should validate: ' + JSON.stringify(okReport.checks[0]?.findings ?? []))
  if (JSON.stringify(okReport.narrative) !== JSON.stringify(complete.narrative)) {
    throw new Error('report must echo the narrative block')
  }
  assertNoUndefinedValues(okReport)

  const clone = (value) => JSON.parse(JSON.stringify(value))
  const missingScenario = clone(complete)
  missingScenario.narrative.scenarios = []
  const bad1 = runVerification(missingScenario)
  if (bad1.ok || bad1.checks[0]?.id !== 'MODEL' || !bad1.checks[0].findings.some((entry) => entry.message.includes('missing scenario'))) {
    throw new Error('missing scenario must fail MODEL validation: ' + JSON.stringify(bad1.checks[0]?.findings ?? []))
  }

  const unknownState = clone(complete)
  unknownState.narrative.states.Z = 'ghost state'
  const bad2 = runVerification(unknownState)
  if (bad2.ok || !bad2.checks[0].findings.some((entry) => entry.message.includes('unknown state'))) {
    throw new Error('unknown state in narrative must fail validation')
  }

  const missingEvent = clone(complete)
  missingEvent.narrative.events = {}
  const bad3 = runVerification(missingEvent)
  if (bad3.ok || !bad3.checks[0].findings.some((entry) => entry.message.includes('missing description for event'))) {
    throw new Error('missing event description must fail validation')
  }

  const duplicate = clone(complete)
  duplicate.narrative.scenarios = [
    { from: 'A', event: 'go', scenario: 'first' },
    { from: 'A', event: 'go', scenario: 'second' },
  ]
  const bad4 = runVerification(duplicate)
  if (bad4.ok || !bad4.checks[0].findings.some((entry) => entry.message.includes('duplicate scenario'))) {
    throw new Error('duplicate scenario must fail validation')
  }

  for (const bad of [bad1, bad2, bad3, bad4]) assertNoUndefinedValues(bad)
  console.log('PASS narrative-validation')
}

await runNarrativeValidationTests()
if (failures > 0) {
  console.log('engine fixtures failed:', failures)
  process.exit(1)
}
console.log('all engine fixtures passed')
