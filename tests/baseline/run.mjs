// Baseline diffing: the "violations must not increase" acceptance criterion, computed.
// The cases that matter are the ones a human comparison gets wrong: a reworded finding
// that is not new, a resolved finding that must not read as clean, a new warning that
// must not pass as nothing, and a clean delta over a still-failing report.
import { diffReports, findingIdentity, flattenReportFindings } from '../../lib/baseline.js'
import { runVerification, runCompositionVerification, modelHash } from '../../lib/engine.js'
import { reviewStructure } from '../../lib/structure.js'

let failures = 0
function test(name, fn) {
  try {
    fn()
    console.log('PASS', name)
  } catch (error) {
    failures += 1
    console.log('FAIL', name, '-', error instanceof Error ? error.message : String(error))
  }
}

function assertNoUndefinedValues(value, path = 'root') {
  if (value === undefined) throw new Error(`lossless JSON violation: undefined at ${path}`)
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoUndefinedValues(entry, `${path}[${index}]`))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) assertNoUndefinedValues(entry, `${path}.${key}`)
  }
}

const clean = { schemaVersion: 1, init: 'A', states: [{ id: 'A' }, { id: 'B', terminal: true }], transitions: [{ from: 'A', event: 'go', to: 'B' }] }
const deadlocked = { schemaVersion: 1, init: 'A', states: [{ id: 'A' }], transitions: [] }

test('self-baseline: the same report adds nothing and removes nothing', () => {
  const report = runVerification(clean)
  const diff = diffReports(report, runVerification(clean))
  if (diff.verdict !== 'pass') throw new Error('a self-baseline must pass: ' + diff.verdictReason)
  if (diff.summary.added !== 0 || diff.summary.removed !== 0 || diff.summary.changed !== 0) {
    throw new Error('a self-baseline must be empty: ' + JSON.stringify(diff.summary))
  }
  if (diff.schema !== 'logicprobe/baseline/v1') throw new Error('schema: ' + diff.schema)
  if (diff.currentVerdict !== report.verdict) throw new Error('the current verdict must be echoed')
  if (diff.nextSteps.length === 0) throw new Error('nextSteps must not be empty')
  assertNoUndefinedValues(diff)
})

test('a new error finding fails the delta and names it', () => {
  const diff = diffReports(runVerification(clean), runVerification(deadlocked))
  if (diff.verdict !== 'fail') throw new Error('a new error must fail the delta: ' + diff.verdict)
  if (diff.summary.addedErrors !== 1) throw new Error('addedErrors: ' + diff.summary.addedErrors)
  if (!diff.verdictReason.includes('S2_NO_TRANSITIONS')) throw new Error('the first added error must be named: ' + diff.verdictReason)
  if (diff.added[0].check !== 'S2') throw new Error('the emitting check must survive flattening: ' + JSON.stringify(diff.added[0]))
  if (diff.currentVerdict !== 'fail') throw new Error('the absolute verdict must stay visible')
  if (!diff.nextSteps.some((step) => step.includes('new error finding'))) throw new Error('nextSteps must name the new errors')
})

test('resolved findings are reported as removed, not as a clean sweep', () => {
  const diff = diffReports(runVerification(deadlocked), runVerification(clean))
  if (diff.verdict !== 'pass') throw new Error('resolving an error is a pass on the delta')
  if (!diff.verdictReason.includes('1 finding(s) resolved')) throw new Error('reason: ' + diff.verdictReason)
  if (diff.summary.removed === 0) throw new Error('the removed finding must be listed')
  if (!diff.nextSteps.some((step) => step.includes('confirm they were fixed'))) throw new Error('a removal must be confirmed, not assumed')
})

test('a new warning is pass_with_findings, never a silent pass', () => {
  // Two structure reports over the same graph, one with an added isolated node.
  const diagram = ['@startuml', 'component [A] as A', 'component [B] as B', 'A --> B', '@enduml'].join('\n')
  const withOrphan = ['@startuml', 'component [A] as A', 'component [B] as B', 'component [C] as C', 'A --> B', '@enduml'].join('\n')
  const diff = diffReports(reviewStructure({ diagram }), reviewStructure({ diagram: withOrphan }))
  if (diff.verdict !== 'pass_with_findings') throw new Error('new warnings: ' + diff.verdict + ' (' + diff.verdictReason + ')')
  if (diff.summary.addedWarnings === 0 || diff.summary.addedErrors !== 0) throw new Error('summary: ' + JSON.stringify(diff.summary))
})

test('identity keeps the locator and ignores prose', () => {
  const withEvidence = { code: 'X', severity: 'error', message: 'first wording', evidence: { node: 'A' } }
  const reworded = { code: 'X', severity: 'error', message: 'second wording', evidence: { node: 'A' } }
  if (findingIdentity(withEvidence) !== findingIdentity(reworded)) throw new Error('a reworded finding is the same finding')
  const otherNode = { code: 'X', severity: 'error', message: 'first wording', evidence: { node: 'B' } }
  if (findingIdentity(withEvidence) === findingIdentity(otherNode)) throw new Error('a different locator is a different finding')
  const checkBound = { code: 'X', severity: 'error', message: 'm', check: 'S1' }
  const otherCheck = { code: 'X', severity: 'error', message: 'm', check: 'S2' }
  if (findingIdentity(checkBound) === findingIdentity(otherCheck)) throw new Error('the emitting check separates identities')
  const bare = { code: 'X', severity: 'warning', message: 'no locator at all' }
  if (!findingIdentity(bare).includes('message:no locator at all')) throw new Error('a finding with no locator falls back to its message')
  // Key order inside evidence must not change the identity.
  if (findingIdentity({ code: 'X', severity: 'error', message: 'm', evidence: { a: 1, b: 2 } })
    !== findingIdentity({ code: 'X', severity: 'error', message: 'm', evidence: { b: 2, a: 1 } })) {
    throw new Error('evidence key order must not matter')
  }
})

test('a reworded finding reads as changed, not as added plus removed', () => {
  const baseline = { findings: [{ code: 'X', severity: 'error', message: 'old wording', evidence: { node: 'A' } }] }
  const current = { findings: [{ code: 'X', severity: 'error', message: 'new wording', evidence: { node: 'A' } }] }
  const diff = diffReports(baseline, current)
  if (diff.summary.added !== 0 || diff.summary.removed !== 0) throw new Error('a reword must not add or remove: ' + JSON.stringify(diff.summary))
  if (diff.summary.changed !== 1) throw new Error('expected one changed finding')
  if (diff.changed[0].before.message !== 'old wording' || diff.changed[0].after.message !== 'new wording') {
    throw new Error('the change must quote both sides: ' + JSON.stringify(diff.changed[0]))
  }
  if (diff.verdict !== 'pass') throw new Error('a reword alone is not a failure')
})

test('an escalated severity is a change, and the delta stays clean with a failing current run', () => {
  const baseline = { findings: [{ code: 'X', severity: 'warning', message: 'm', evidence: { node: 'A' } }] }
  const current = { findings: [{ code: 'X', severity: 'error', message: 'm', evidence: { node: 'A' } }] }
  const diff = diffReports(baseline, current)
  if (diff.summary.changed !== 1 || diff.summary.added !== 0) throw new Error('severity escalation is a change, not an addition')
  const failing = diffReports(runVerification(clean), runVerification(deadlocked))
  const same = diffReports(runVerification(deadlocked), runVerification(deadlocked))
  if (same.verdict !== 'pass' || same.currentVerdict !== 'fail') throw new Error('a clean delta over a failing run must say both')
  if (!same.nextSteps.some((step) => step.includes('still fails on its own terms'))) {
    throw new Error('the report must refuse to call a failing run clean')
  }
  if (failing.summary.added === same.summary.added) throw new Error('the two comparisons must differ')
})

test('flattening reads checks[].findings and findings[] alike', () => {
  const checks = flattenReportFindings(runVerification(deadlocked))
  if (checks.length === 0 || checks[0].check !== 'S2') throw new Error('a flat check finding keeps its check id: ' + JSON.stringify(checks))
  const invalid = flattenReportFindings(runVerification({ schemaVersion: 2, init: 'A', states: [{ id: 'A' }], transitions: [] }))
  if (invalid.length === 0 || invalid[0].check !== 'MODEL' || invalid[0].code !== 'MODEL_INVALID') {
    throw new Error('a validation failure flattens under MODEL: ' + JSON.stringify(invalid))
  }
  const flat = flattenReportFindings({ findings: [{ code: 'A', severity: 'warning', message: 'm' }] })
  if (flat.length !== 1 || flat[0].check !== undefined) throw new Error('a flat family has no check id')
  if (flattenReportFindings(null).length !== 0) throw new Error('a non-report flattens to nothing')
})

test('the structure family diffs too (diagram hashes included in the reports)', () => {
  const diagram = ['@startuml', 'component [A] as A', 'component [B] as B', 'A --> B', '@enduml'].join('\n')
  const worse = ['@startuml', 'component [A] as A', 'component [B] as B', 'component [C] as C', 'A --> B', '@enduml'].join('\n')
  const baseline = reviewStructure({ diagram })
  const current = reviewStructure({ diagram: worse })
  const diff = diffReports(baseline, current)
  if (diff.verdict !== 'pass_with_findings') throw new Error('a new isolated node is a new warning: ' + diff.verdict)
  if (diff.added[0].code !== 'UML020_ISOLATED_NODE') throw new Error('added: ' + JSON.stringify(diff.added.map((finding) => finding.code)))
  if (baseline.hashes.diagram === current.hashes.diagram) throw new Error('the diagram hash must differ')
  assertNoUndefinedValues(diff)
})

test('modelHash stays the run identity while findings drive the diff', () => {
  const report = runVerification(clean)
  if (report.hashes.modelHash !== modelHash(clean)) throw new Error('the report hash must match the engine hash')
  const diff = diffReports(report, report)
  if (diff.summary.baseline !== diff.summary.current) throw new Error('a self-diff has equal counts')
})

if (failures > 0) { console.log('baseline tests failed:', failures); process.exit(1) }
console.log('all baseline tests passed')
