import { readFile } from 'node:fs/promises'
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

await runDiffTests()
if (failures > 0) {
  console.log('engine fixtures failed:', failures)
  process.exit(1)
}
console.log('all engine fixtures passed')
