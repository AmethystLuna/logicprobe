// The report body: what the model reads must carry every actionable fact and nothing else.
//
// The measured case this pins: a 37,167-character verification report was 33.1% indentation,
// 21.7% repeated key names and 12.7% punctuation, and its 105 findings stated 47 facts —
// the same (state, event) fact reported by both S5 and A1, twenty race findings saying the
// same thing with different variable snapshots. Silencing a passing check, grouping the
// repeated facts and dropping warning evidence is work the harness can do once instead of
// the model doing it on every call.
import { runVerification } from '../../lib/engine.js'
import { diffReports } from '../../lib/baseline.js'
import { exportModel } from '../../lib/exporters.js'
import { renderReportText, factKey, toViewFinding } from '../../lib/report-view.js'

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
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

/** A model that leaves (state, event) pairs undefined, so S5 and A1 both report them. */
function sparseModel() {
  return {
    schemaVersion: 1,
    init: 'IDLE',
    states: [{ id: 'IDLE' }, { id: 'DECIDE' }, { id: 'VERIFYING' }],
    transitions: [
      { from: 'IDLE', event: 'candidate', to: 'VERIFYING' },
      { from: 'VERIFYING', event: 'verify_pass', to: 'DECIDE' },
    ],
  }
}

const report = runVerification(sparseModel())
const body = renderReportText(report)

test('the report object is not mutated by rendering', () => {
  const before = JSON.stringify(report)
  renderReportText(report)
  assert(JSON.stringify(report) === before, 'rendering changed the report object')
})

test('the reported object keeps every machine-readable field the diff contract needs', () => {
  assert(typeof report.modelHash === 'string' && report.modelHash.length === 64, 'modelHash must survive')
  assert(report.verdict === 'fail', 'this fixture is a failing review')
  for (const check of report.checks) {
    assert(typeof check.id === 'string' && typeof check.status === 'string', 'check identity must survive')
  }
})

test('ok=true with a failing verdict still reads as a failing review', () => {
  assert(report.ok === true && report.verdict === 'fail', 'fixture precondition')
  assert(/verdict=fail/.test(body), 'the header must carry the verdict, not just ok')
  assert(/ok=true/.test(body), 'the header must also show ok, which only means the engine ran')
})

test('passing checks are silenced but still inventoried', () => {
  const passed = report.checks.filter((check) => check.status === 'pass').map((check) => check.id)
  const failed = report.checks.filter((check) => check.status === 'fail').map((check) => check.id)
  assert(passed.length > 0 && failed.length > 0, 'fixture precondition: both outcomes present')
  const inventory = body.split('\n').find((line) => line.startsWith('CHECKS'))
  for (const id of [...passed, ...failed]) assert(inventory.includes(id), `check ${id} missing from the inventory line`)
  for (const id of passed) {
    assert(!new RegExp(`^PASS ${id} `, 'm').test(body), `passing check ${id} must not expand a body`)
  }
  for (const id of failed) {
    assert(new RegExp(`^FAIL ${id} `, 'm').test(body), `failing check ${id} must expand a body`)
  }
})

test('the same (state, event) fact is reported once, not once per check', () => {
  const s5 = report.checks.find((check) => check.id === 'S5')
  const a1 = report.checks.find((check) => check.id === 'A1')
  if (s5 === undefined || a1 === undefined || s5.findings.length === 0) return // nothing to dedupe here
  const keys = (check) => new Set(check.findings.map((finding) => factKey(toViewFinding(finding))))
  const overlap = [...keys(s5)].filter((key) => keys(a1).has(key))
  if (overlap.length === 0) return
  const repeated = a1.findings.filter((finding) => finding.severity !== 'error').length
  assert(
    body.includes(`${repeated} finding(s) here repeat facts already reported above`),
    'the later check must say it adds nothing instead of reprinting the facts',
  )
  const idles = body.split('\n').filter((line) => /^  IDLE \(\d+\) \[/.test(line))
  assert(idles.length <= 1, `the grouped IDLE line must appear once per check at most, saw ${idles.length}`)
})

test('identical finding lines collapse with a multiplier', () => {
  const many = {
    schema: 'logicprobe/verify/v1',
    ok: true,
    verdict: 'fail',
    verdictReason: '20 warning finding(s)',
    findings: Array.from({ length: 10 }, () => ({
      code: 'A2_ORDER_DEPENDENT',
      severity: 'warning',
      message: 'Events candidate and source_failed produce order-dependent outcomes from state COLLECT',
    })),
  }
  const rendered = renderReportText(many)
  // Finding lines start with the bracketed severity/code; the FINDINGS inventory line also
  // names the code, so match the body shape, not the code.
  const lines = rendered.split('\n').filter((line) => /^\s+\[[a-z]+\/A2_ORDER_DEPENDENT\]/.test(line))
  assert(lines.length === 1, `ten identical findings must render as one line, got ${lines.length}`)
  assert(lines[0].includes('(x10)'), `the collapsed line must carry the count: ${lines[0]}`)
})

test('warning evidence is not inlined, error evidence is', () => {
  const mixed = {
    schema: 'logicprobe/verify/v1',
    verdict: 'fail',
    checks: [
      {
        id: 'S6',
        name: 'Guard Completeness',
        status: 'fail',
        detail: '1 error',
        findings: [
          { code: 'S6_INCOMPLETE_GUARD', severity: 'error', message: 'guard missing', evidence: { assignment: { remaining: 0 } } },
          { code: 'A5_OUT_OF_DOMAIN', severity: 'warning', message: 'boundary value below min', evidence: { variable: 'remaining', value: -1 } },
        ],
      },
    ],
  }
  const rendered = renderReportText(mixed)
  assert(rendered.includes('evidence={"assignment":{"remaining":0}}'), 'an error finding keeps its evidence inline')
  assert(!rendered.includes('"value":-1'), 'a warning finding must not pay for its evidence')
})

test('a rendered diagram is printed verbatim exactly once', () => {
  const diagram = 'stateDiagram-v2\n  [*] --> IDLE\n  IDLE --> DECIDE: go\n'
  const rendered = renderReportText({
    schema: 'logicprobe/uml/render/v1',
    ok: true,
    verdict: 'pass',
    verdictReason: 'no findings',
    action: 'render',
    notation: 'mermaid',
    kind: 'state',
    diagram,
    warnings: [],
  })
  assert(rendered.split(diagram.trimEnd()).length === 2, 'the diagram body must appear once')
  assert(!rendered.includes('\\n'), 'the diagram must not be re-escaped as a JSON string')
})

test('an exported payload is printed verbatim, without JSON escaping', () => {
  const exported = exportModel(sparseModel(), 'uppaal')
  const rendered = renderReportText(exported)
  assert(typeof exported.primary === 'string' && exported.primary.length > 0, 'fixture precondition')
  assert(rendered.includes(exported.primary.trimEnd()), 'the generated file must appear verbatim')
  assert(!rendered.includes('\\n'), 'the generated file must not be re-escaped')
})

test('a baseline delta renders its three sections and the current verdict', () => {
  const before = runVerification(sparseModel())
  const after = runVerification({
    ...sparseModel(),
    transitions: [
      ...sparseModel().transitions,
      { from: 'IDLE', event: 'verify_pass', to: 'DECIDE' },
      { from: 'DECIDE', event: 'candidate', to: 'IDLE' },
      { from: 'DECIDE', event: 'verify_pass', to: 'IDLE' },
      { from: 'VERIFYING', event: 'candidate', to: 'IDLE' },
    ],
  })
  const delta = diffReports(before, after)
  const rendered = renderReportText(delta)
  assert(/^logicprobe\/baseline\/v1/m.test(rendered), 'the delta header must name its schema')
  assert(/CURRENT\s+verdict=/.test(rendered), 'the current verdict must stay readable')
  for (const key of ['added', 'removed', 'changed']) {
    const count = Array.isArray(delta[key]) ? delta[key].length : 0
    if (count > 0) assert(rendered.includes(`${key.toUpperCase()} (${count})`), `the ${key} section must be present`)
  }
})

test('an unrecognized shape still states its failure reason', () => {
  const rendered = renderReportText({
    ok: false,
    ran: false,
    verdict: 'fail',
    verdictReason: 'the tool did not run: model invalid',
    schema: 'logicprobe/verify/v1',
    errorCode: 'MODEL_INVALID',
    error: 'model: must be an object',
  })
  assert(rendered.includes('ERROR  model: must be an object [MODEL_INVALID]'), 'the refusal reason must be first-class')
  assert(rendered.includes('verdict=fail'), 'the verdict must survive the refusal path')
})

test('full is the escape hatch for a caller that needs the object itself', () => {
  const full = renderReportText(report, { full: true })
  assert(full === JSON.stringify(report, null, 2), 'full must reproduce the structured report byte for byte')
  assert(full.length > renderReportText(report).length, 'full is the expensive path, by construction')
})

test('rendering is deterministic', () => {
  assert(renderReportText(report) === renderReportText(report), 'two renders of one report must be identical')
})

test('the body costs a fraction of the pretty JSON it replaces', () => {
  const pretty = JSON.stringify(report, null, 2)
  assert(body.length < pretty.length, `body ${body.length} must beat pretty ${pretty.length}`)
  assert(body.length < pretty.length * 0.8, `body ${body.length} should be well under pretty ${pretty.length}`)
})

if (failures > 0) {
  console.error(`\n${failures} report-view test(s) failed`)
  process.exit(1)
}
console.log('\nreport-view: all assertions passed')
