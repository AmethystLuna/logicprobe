import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { runVerification } from '../../lib/engine.js'

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
