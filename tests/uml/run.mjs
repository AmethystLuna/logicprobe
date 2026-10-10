// UML front-end tests: rendering (model → diagram source), parsing (diagram
// source → model) and the modelling review, whose fidelity half is the render →
// parse round trip. A diagram that does not read back as the model it was drawn
// from is the defect this suite exists to catch, so every supported notation is
// round-tripped rather than only asserted on its output text.
import { renderUml, parseUml, parseFindings, reviewUml, diffModels, explainLabels, guardText, parseGuardText, UmlError } from '../../lib/uml.js'

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
  if (value === undefined) throw new Error(`undefined at ${path}`)
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoUndefinedValues(entry, `${path}[${index}]`))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) assertNoUndefinedValues(entry, `${path}.${key}`)
  }
}

function codes(report) {
  return report.findings.map((finding) => finding.code)
}

function findFinding(report, code) {
  return report.findings.filter((finding) => finding.code === code)
}

const model = {
  schemaVersion: 1,
  init: 'INIT',
  states: [{ id: 'INIT' }, { id: 'STARTING' }, { id: 'ACTIVE' }, { id: 'ERROR' }, { id: 'FATAL', terminal: true }],
  transitions: [
    { from: 'INIT', event: 'power_ready', to: 'STARTING' },
    { from: 'STARTING', event: 'ack', to: 'ACTIVE' },
    { from: 'ACTIVE', event: 'stop', to: 'FATAL' },
    { from: 'STARTING', event: 'timeout', guard: { variable: 'retry', op: '<', value: 3 }, to: 'ERROR', updates: [{ variable: 'retry', op: 'inc' }] },
    { from: 'STARTING', event: 'timeout', guard: { variable: 'retry', op: '>=', value: 3 }, to: 'FATAL' },
    { from: 'ERROR', event: 'cooldown', to: 'STARTING' },
  ],
  variables: [{ name: 'retry', kind: 'integer', init: 0, min: 0, max: 3 }],
}

const narrated = {
  ...model,
  narrative: {
    states: { INIT: 'power-on, not ready', STARTING: 'handshake in flight', ACTIVE: 'running', ERROR: 'retryable failure', FATAL: 'unrecoverable' },
    events: { power_ready: 'supply is up', ack: 'peer acknowledged', stop: 'operator stop', timeout: 'handshake timed out', cooldown: 'cooldown elapsed' },
    scenarios: [
      { from: 'INIT', event: 'power_ready', scenario: 'supply up, start handshake' },
      { from: 'STARTING', event: 'ack', scenario: 'peer acknowledged, run' },
      { from: 'ACTIVE', event: 'stop', scenario: 'operator stops the machine' },
      { from: 'STARTING', event: 'timeout', scenario: 'handshake times out, retry or fail' },
      { from: 'ERROR', event: 'cooldown', scenario: 'retry after cooldown' },
    ],
  },
}

// ---------------------------------------------------------------- rendering --

test('render: mermaid state diagram carries directives, guards and terminal marks', () => {
  const out = renderUml(model, 'mermaid', 'state')
  for (const needle of ['%%logicprobe:uml v1 notation=mermaid diagram=state', '%%logicprobe:init INIT', '%%logicprobe:terminal FATAL', 'stateDiagram-v2', '[*] --> INIT', 'STARTING --> ERROR : timeout [retry < 3] / retry := retry + 1', 'FATAL --> [*]']) {
    if (!out.primary.includes(needle)) throw new Error('missing ' + needle + '\n' + out.primary)
  }
  if (out.warnings.length !== 0) throw new Error('unexpected warnings: ' + out.warnings.join(' | '))
})

test('render: plantuml state diagram is fenced and directive-commented', () => {
  const out = renderUml(model, 'plantuml', 'state')
  for (const needle of ['@startuml', '@enduml', "'logicprobe:init INIT", '[*] --> INIT', 'STARTING --> FATAL : timeout [retry >= 3]', 'FATAL --> [*]']) {
    if (!out.primary.includes(needle)) throw new Error('missing ' + needle + '\n' + out.primary)
  }
})

test('render: mermaid activity flowchart labels every edge with event [guard] / actions', () => {
  const out = renderUml(model, 'mermaid', 'activity')
  for (const needle of ['flowchart TD', 'FATAL(["FATAL"])', 'INIT["INIT"]', 'STARTING -->|"timeout [retry < 3] / retry := retry + 1"| ERROR']) {
    if (!out.primary.includes(needle)) throw new Error('missing ' + needle + '\n' + out.primary)
  }
  if (out.diagram !== 'activity') throw new Error('diagram kind not reported')
})

test('render: sequence view is a capped trace and says so', () => {
  const out = renderUml(model, 'mermaid', 'sequence')
  for (const needle of ['sequenceDiagram', 'participant ENV as Environment', 'ENV->>M: power_ready', 'Note over M: INIT -> STARTING']) {
    if (!out.primary.includes(needle)) throw new Error('missing ' + needle + '\n' + out.primary)
  }
  if (!out.warnings.some((warning) => warning.includes('UML_RENDER_SEQUENCE_IS_TRACE'))) throw new Error('a trace must be labelled a trace')
  const capped = renderUml(model, 'mermaid', 'sequence', 2)
  if (!capped.warnings.some((warning) => warning.includes('UML_RENDER_SEQUENCE_TRUNCATED'))) throw new Error('expected truncation warning')
})

test('render: plantuml activity is refused instead of mislabelled', () => {
  let message = ''
  try { renderUml(model, 'plantuml', 'activity') } catch (error) { message = error instanceof Error ? error.message : String(error) }
  if (!message.includes('activity')) throw new Error('expected a refusal naming the missing view, got: ' + message)
})

test('render: narrative meanings appear in the diagram labels', () => {
  const state = renderUml(narrated, 'mermaid', 'state')
  if (!state.primary.includes('state "INIT（power-on, not ready）" as INIT')) throw new Error('state label missing\n' + state.primary)
  const activity = renderUml(narrated, 'mermaid', 'activity')
  if (!activity.primary.includes('INIT["INIT（power-on, not ready）"]')) throw new Error('activity label missing\n' + activity.primary)
})

// ------------------------------------------------------------------ parsing --

test('round trip: mermaid/plantuml state and mermaid activity read back structure-for-structure', () => {
  for (const [notation, kind] of [['mermaid', 'state'], ['mermaid', 'activity'], ['plantuml', 'state']]) {
    const rendered = renderUml(model, notation, kind)
    const parsed = parseUml(rendered.primary)
    const diffs = diffModels(model, parsed.model)
    if (diffs.length > 0) throw new Error(`${notation}/${kind} round trip: ` + diffs.join(' | '))
    if (parsed.notation !== notation) throw new Error(`${notation}/${kind}: notation misdetected as ${parsed.notation}`)
  }
})

test('round trip: nested guards and several actions survive the notation', () => {
  const nested = {
    schemaVersion: 1,
    init: 'A',
    states: [{ id: 'A' }, { id: 'B', terminal: true }],
    transitions: [
      { from: 'A', event: 'go', guard: { any: [{ all: [{ variable: 'k', op: '<', value: 2 }, { variable: 'armed', op: '==', value: true }] }, { not: { variable: 'locked', op: '==', value: true } }] }, to: 'B', updates: [{ variable: 'k', op: 'inc', value: 2 }, { variable: 'armed', op: 'set', value: 0 }, { variable: 'n', op: 'dec' }] },
      { from: 'A', event: 'go', to: 'B' },
    ],
    variables: [{ name: 'k', kind: 'integer', init: 0, min: 0, max: 9 }, { name: 'armed', kind: 'boolean', init: false }, { name: 'locked', kind: 'boolean', init: false }, { name: 'n', kind: 'integer', init: 5, min: 0, max: 5 }],
  }
  for (const notation of ['mermaid', 'plantuml']) {
    const rendered = renderUml(nested, notation, 'state')
    const parsed = parseUml(rendered.primary)
    const diffs = diffModels(nested, parsed.model)
    if (diffs.length > 0) throw new Error(notation + ' nested round trip: ' + diffs.join(' | '))
  }
})

test('round trip: ids the notation cannot spell are restored through alias directives', () => {
  const odd = {
    schemaVersion: 1,
    init: '1st',
    states: [{ id: '1st' }, { id: 'has space' }, { id: 'A-B' }, { id: 'A_B' }, { id: 'done!', terminal: true }],
    transitions: [
      { from: '1st', event: 'go on', to: 'has space' },
      { from: 'has space', event: 'branch', to: 'A-B' },
      { from: 'has space', event: 'branch2', to: 'A_B' },
      { from: 'A-B', event: 'finish', to: 'done!' },
      { from: 'A_B', event: 'finish2', to: 'done!' },
    ],
  }
  const rendered = renderUml(odd, 'mermaid', 'state')
  if (!rendered.warnings.some((warning) => warning.includes('UML_RENDER_ID_SANITIZED'))) throw new Error('expected a sanitization warning')
  const parsed = parseUml(rendered.primary)
  const diffs = diffModels(odd, parsed.model)
  if (diffs.length > 0) throw new Error('sanitized-id round trip: ' + diffs.join(' | '))
})

test('round trip: states no transition touches survive (isolated start, isolated terminal)', () => {
  // The sweep over tests/engine/fixtures/ caught this: a terminal state with no
  // incoming edge is named only by `X --> [*]`, and a machine with no transitions
  // at all names its start state only by `[*] --> X`. Neither may be dropped.
  const sparse = {
    schemaVersion: 1,
    init: 'BOOT',
    states: [{ id: 'BOOT' }, { id: 'LONE' }, { id: 'HALT', terminal: true }],
    transitions: [{ from: 'BOOT', event: 'halt', to: 'HALT' }],
  }
  for (const [notation, kind] of [['mermaid', 'state'], ['plantuml', 'state'], ['mermaid', 'activity']]) {
    const parsed = parseUml(renderUml(sparse, notation, kind).primary)
    const diffs = diffModels(sparse, parsed.model)
    if (diffs.length > 0) throw new Error(`${notation}/${kind} lost an isolated state: ` + diffs.join(' | '))
  }
  const edgeless = { schemaVersion: 1, init: 'ONLY', states: [{ id: 'ONLY', terminal: true }], transitions: [] }
  const parsed = parseUml(renderUml(edgeless, 'mermaid', 'state').primary)
  const diffs = diffModels(edgeless, parsed.model)
  if (diffs.length > 0) throw new Error('an edgeless machine must still parse: ' + diffs.join(' | '))
})

test('parse: a hand-written mermaid diagram without directives infers init, terminals and names unlabelled arrows', () => {
  const text = [
    'stateDiagram-v2',
    '  [*] --> IDLE',
    '  IDLE --> BUSY : start',
    '  IDLE --> IDLE : tick',
    '  BUSY --> IDLE',
    '  BUSY --> [*]',
    '  IDLE : waiting for work',
  ].join('\n')
  const parsed = parseUml(text)
  if (parsed.model.init !== 'IDLE') throw new Error('init not read from the initial pseudostate')
  const busy = parsed.model.states.find((state) => state.id === 'BUSY')
  if (busy === undefined || busy.terminal !== true) throw new Error('terminal state not marked')
  const synthetic = parsed.model.transitions.find((transition) => transition.from === 'BUSY')
  if (synthetic === undefined || !synthetic.event.startsWith('t_BUSY_IDLE')) throw new Error('unlabelled arrow must get a synthetic event, got ' + JSON.stringify(synthetic))
  if (!parsed.warnings.some((warning) => warning.includes('UML_PARSE_SYNTHETIC_EVENT'))) throw new Error('synthetic events must be reported')
  if (parsed.labels.IDLE !== 'waiting for work') throw new Error('state description not captured as a label')
})

test('parse: a hand-written flowchart uses the init/terminal directives', () => {
  const text = [
    '%%logicprobe:init START',
    '%%logicprobe:terminal END',
    'flowchart TD',
    '  START["start"] --> WORK["work"]',
    '  WORK --> END["end"]',
    '  WORK --> WORK',
  ].join('\n')
  const parsed = parseUml(text)
  if (parsed.model.init !== 'START') throw new Error('init directive ignored')
  const end = parsed.model.states.find((state) => state.id === 'END')
  if (end === undefined || end.terminal !== true) throw new Error('terminal directive ignored')
  if (parsed.diagram !== 'activity') throw new Error('flowchart must parse as the activity view')
})

test('parse: several initial pseudostates are reported, not silently merged', () => {
  const text = ['stateDiagram-v2', '  [*] --> A', '  [*] --> B', '  A --> B : go', '  B --> [*]'].join('\n')
  const parsed = parseUml(text)
  if (parsed.model.init !== 'A') throw new Error('the first entry state must win')
  if (!parsed.warnings.some((warning) => warning.includes('UML_PARSE_MULTIPLE_INIT'))) throw new Error('multiple init states must be reported')
})

test('parse: a sequence diagram is refused, because a trace cannot reconstruct a machine', () => {
  let message = ''
  try { parseUml(renderUml(model, 'mermaid', 'sequence').primary) } catch (error) { message = error instanceof Error ? error.message : String(error) }
  if (!message.includes('trace')) throw new Error('expected the trace refusal, got: ' + message)
})

test('parse: an unreadable guard fails loudly instead of dropping the branch condition', () => {
  const text = ['stateDiagram-v2', '  [*] --> A', '  A --> B : go [retry ~~ 3]', '  B --> [*]'].join('\n')
  let message = ''
  try { parseUml(text) } catch (error) { message = error instanceof Error ? error.message : String(error) }
  if (!message.includes('guard')) throw new Error('expected a guard error, got: ' + message)
})

test('guard text: render and parse are inverse for nested guards', () => {
  const guard = { any: [{ all: [{ variable: 'k', op: '<', value: 2 }, { variable: 'armed', op: '==', value: true }] }, { not: { variable: 'locked', op: '!=', value: false } }] }
  const text = guardText(guard)
  const back = parseGuardText(text)
  if (guardText(back) !== text) throw new Error('guard round trip changed the expression: ' + text + ' -> ' + guardText(back))
})

// ------------------------------------------------------------------- review --

test('review: a well-formed model reports no errors and a passing round trip', () => {
  const report = reviewUml({ model: narrated })
  if (!report.ok) throw new Error('review refused a valid model')
  if (report.summary.errors !== 0) throw new Error('unexpected errors: ' + JSON.stringify(findFinding(report, 'UML002_UNREACHABLE_STATE')))
  if (report.roundTrip === null || !report.roundTrip.ok) throw new Error('round trip should pass: ' + JSON.stringify(report.roundTrip))
  if (report.summary.reachableStates !== 5) throw new Error('reachability summary wrong')
  if (report.summary.documentedStates !== 5) throw new Error('narrative should document every state, got ' + report.summary.documentedStates)
  if (report.primary === undefined || !report.primary.includes('stateDiagram-v2')) throw new Error('review must return the diagram it checked')
  assertNoUndefinedValues(report)
})

test('review: structural modelling defects are named, with the states that carry them', () => {
  const broken = {
    schemaVersion: 1,
    init: 'START',
    states: [{ id: 'START' }, { id: 'ORPHAN' }, { id: 'DEAD' }, { id: 'LOOP' }, { id: 'TWICE' }],
    transitions: [
      { from: 'START', event: 'go', to: 'TWICE' },
      { from: 'START', event: 'go', to: 'DEAD' },
      { from: 'TWICE', event: 'go', to: 'TWICE' },
      { from: 'TWICE', event: 'go', to: 'DEAD' },
      { from: 'LOOP', event: 'spin', to: 'LOOP' },
      { from: 'ORPHAN', event: 'never', to: 'DEAD' },
    ],
    variables: [{ name: 'unused_counter', kind: 'integer', init: 0 }],
  }
  const report = reviewUml({ model: broken })
  const expected = [
    'UML002_UNREACHABLE_STATE',
    'UML003_DEAD_END_STATE',
    'UML004_AMBIGUOUS_BRANCH',
    'UML007_UNUSED_EVENT',
    'UML008_SELF_LOOP_NO_EXIT',
    'UML010_UNUSED_VARIABLE',
    'UML011_UNBOUNDED_VARIABLE',
    'UML012_NO_TERMINAL',
    'UML013_NO_NARRATIVE',
  ]
  for (const code of expected) {
    if (findFinding(report, code).length === 0) throw new Error('missing ' + code + ' in ' + JSON.stringify(codes(report)))
  }
  const unreachable = findFinding(report, 'UML002_UNREACHABLE_STATE')[0]
  if (!unreachable.states.includes('ORPHAN') || !unreachable.states.includes('LOOP')) throw new Error('unreachable findings must name the states: ' + JSON.stringify(unreachable.states))
  if (report.roundTrip === null || !report.roundTrip.ok) throw new Error('the diagram still carries this model; the findings are about the model')
})

test('review: duplicate transitions and unbounded variables are separate findings', () => {
  const duplicated = {
    schemaVersion: 1,
    init: 'A',
    states: [{ id: 'A' }, { id: 'B', terminal: true }],
    transitions: [
      { from: 'A', event: 'go', to: 'B' },
      { from: 'A', event: 'go', to: 'B' },
    ],
    variables: [{ name: 'k', kind: 'integer', init: 0, min: 0, max: 4 }],
  }
  const report = reviewUml({ model: duplicated })
  if (findFinding(report, 'UML009_DUPLICATE_TRANSITION').length === 0) throw new Error('duplicate transition not reported')
  if (findFinding(report, 'UML004_AMBIGUOUS_BRANCH').length === 0) throw new Error('two unguarded branches of one event are ambiguous')
  if (findFinding(report, 'UML011_UNBOUNDED_VARIABLE').length !== 0) throw new Error('a bounded variable must not be flagged')
})

test('review: complementary guards downgrade the missing-else warning, plain guards keep it', () => {
  const complementary = {
    schemaVersion: 1,
    init: 'A',
    states: [{ id: 'A' }, { id: 'B', terminal: true }, { id: 'C', terminal: true }],
    transitions: [
      { from: 'A', event: 'go', guard: { variable: 'k', op: '<', value: 3 }, to: 'B' },
      { from: 'A', event: 'go', guard: { variable: 'k', op: '>=', value: 3 }, to: 'C' },
    ],
    variables: [{ name: 'k', kind: 'integer', init: 0, min: 0, max: 9 }],
  }
  const report = reviewUml({ model: complementary })
  const finding = findFinding(report, 'UML006_INEXHAUSTIVE_BRANCH')[0]
  if (finding === undefined) throw new Error('expected a branch-coverage finding')
  if (finding.severity !== 'info') throw new Error('a complementary pair is probably exhaustive; expected info, got ' + finding.severity)

  const partial = {
    ...complementary,
    transitions: [
      { from: 'A', event: 'go', guard: { variable: 'k', op: '<', value: 3 }, to: 'B' },
      { from: 'A', event: 'go', guard: { variable: 'k', op: '>', value: 5 }, to: 'C' },
    ],
  }
  const partialReport = reviewUml({ model: partial })
  const warning = findFinding(partialReport, 'UML006_INEXHAUSTIVE_BRANCH')[0]
  if (warning === undefined || warning.severity !== 'warning') throw new Error('a guard gap must stay a warning')
})

test('review: a diagram that carries a different machine fails the fidelity check', () => {
  const other = { ...model, transitions: model.transitions.slice(0, 4) }
  const diagram = renderUml(other, 'mermaid', 'state').primary
  const report = reviewUml({ model, diagram })
  if (report.source !== 'model+diagram') throw new Error('source not reported')
  if (report.roundTrip === null || report.roundTrip.ok) throw new Error('a mismatched diagram must fail the round trip')
  const finding = findFinding(report, 'UML017_ROUND_TRIP_MISMATCH')[0]
  if (finding === undefined || finding.severity !== 'error') throw new Error('expected a round-trip error finding')
  if (report.summary.errors === 0) throw new Error('the summary must count the mismatch as an error')
})

test('review: a diagram label that disagrees with the model narrative is drift', () => {
  const drifted = renderUml(narrated, 'mermaid', 'state').primary.replace('state "INIT（power-on, not ready）" as INIT', 'state "INIT（supply is down）" as INIT')
  const report = reviewUml({ model: narrated, diagram: drifted })
  if (report.roundTrip === null || !report.roundTrip.ok) throw new Error('relabelling is not a structural change; the round trip must still pass')
  const finding = findFinding(report, 'UML015_LABEL_DRIFT')[0]
  if (finding === undefined) throw new Error('expected label drift, got ' + JSON.stringify(codes(report)))
  if (!finding.detail.includes('supply is down')) throw new Error('drift must quote both labels: ' + finding.detail)
})

test('review: a diagram-only review reads the diagram as the model and says fidelity is unchecked', () => {
  const diagram = ['%%logicprobe:init A', '%%logicprobe:terminal B', 'flowchart TD', '  A --> B : go'].join('\n')
  const report = reviewUml({ diagram })
  if (report.source !== 'diagram') throw new Error('source not reported')
  if (report.model === undefined || report.model.init !== 'A') throw new Error('the parsed model must be echoed')
  if (findFinding(report, 'UML018_FIDELITY_UNCHECKED').length === 0) throw new Error('fidelity must be declared unchecked')
  if (findFinding(report, 'UML014_UNDOCUMENTED_STATE').length === 0) throw new Error('unlabelled states must be reported as undocumented')
  if (report.summary.documentedStates !== 0) throw new Error('no state carries a meaning here')
})

test('review: an unreadable diagram is an error report, not a crash', () => {
  const report = reviewUml({ diagram: 'this is not a diagram' })
  if (report.ok) throw new Error('an unreadable diagram must not report ok')
  if (findFinding(report, 'UML001_DIAGRAM_UNREADABLE').length === 0) throw new Error('expected UML001, got ' + JSON.stringify(codes(report)))
  assertNoUndefinedValues(report)
})

test('review: asking for nothing is refused', () => {
  let thrown = false
  try { reviewUml({}) } catch (error) { thrown = error instanceof UmlError }
  if (!thrown) throw new Error('expected a UmlError')
})

test('review: maxSteps reaches the fidelity check when the view is a trace', () => {
  // A dead option is worse than a missing one: the caller sets a cap, the report
  // says nothing about it, and the truncated trace is presented as the whole flow.
  const report = reviewUml({ model: narrated, diagramKind: 'sequence', maxSteps: 1 })
  if (!report.warnings.some((warning) => warning.includes('UML_RENDER_SEQUENCE_TRUNCATED'))) {
    throw new Error('maxSteps must reach the rendered trace: ' + JSON.stringify(report.warnings))
  }
  if (report.primary === undefined || !report.primary.includes('sequenceDiagram')) throw new Error('the sequence view must be rendered')
  if (report.roundTrip !== null) throw new Error('a trace view cannot be fidelity-checked; roundTrip must stay null')
  const skipped = findFinding(report, 'UML019_ROUND_TRIP_SKIPPED')[0]
  if (skipped === undefined || !skipped.message.includes('trace')) throw new Error('the report must say why the check does not apply')
})

test('review: next steps route to the engine checks that settle what the review cannot', () => {
  const report = reviewUml({ model })
  if (!report.nextSteps.some((step) => step.includes('logicprobe_verify'))) throw new Error('the review must route to logicprobe_verify')
  if (!report.nextSteps.some((step) => step.includes('narrative'))) throw new Error('a model without narrative must be told to add one')
})

// ------------------------------------------- structure diagrams are not models --

// The worst failure this front end can have: a component / package / class diagram
// declares no diagram kind, so a state parser meets its keywords line by line and
// returns a plausible-looking machine. It parsed cleanly before this contract existed —
// `ok: true`, two states, one transition — and "the structure diagram was reviewed"
// was pure fabrication. A parse of such a file must now be loud and must not pass.
const componentDiagram = [
  '@startuml',
  'component [Order Service] as SVC',
  'component [Payment Adapter] as PAY',
  'package "HAL" {',
  '  component [Storage Driver] as DRV',
  '}',
  'SVC --> PAY : request',
  'PAY --> DRV : read',
  '@enduml',
].join('\n')

test('parse: a component diagram reports the constructs it cannot represent', () => {
  const parsed = parseUml(componentDiagram)
  // The by-product is still returned (callers may want to see it) — but it is labelled.
  if (parsed.model.states.length !== 3) throw new Error('the by-product has 3 pseudo-states: ' + JSON.stringify(parsed.model.states))
  const summary = parsed.discardedConstructs.map((entry) => entry.construct + '@' + entry.line).sort()
  if (JSON.stringify(summary) !== JSON.stringify(['component@2', 'component@3', 'component@5', 'package@4'])) {
    throw new Error('discarded constructs not reported with their lines: ' + JSON.stringify(summary))
  }
  if (parsed.discardedEdges !== 2) throw new Error('both arrows touch discarded nodes: ' + parsed.discardedEdges)
  const findings = parseFindings(parsed)
  if (findings.length !== 1 || findings[0].code !== 'UML_NOT_A_STATE_DIAGRAM' || findings[0].severity !== 'error') {
    throw new Error('expected one error finding UML_NOT_A_STATE_DIAGRAM, got ' + JSON.stringify(findings))
  }
  if (!findings[0].message.includes('4 declaration(s)') || !findings[0].message.includes('component ×3') || !findings[0].message.includes('package ×1')) {
    throw new Error('the message must carry the counts: ' + findings[0].message)
  }
  if (!findings[0].message.includes('2 arrow(s)')) throw new Error('the message must carry the discarded edge count')
  if (!findings[0].detail.includes('line 2: component [Order Service] as SVC')) throw new Error('the detail must quote the source lines')
})

test('review: a component diagram never passes, and echoes what it discarded', () => {
  const report = reviewUml({ diagram: componentDiagram })
  if (report.ok !== true || report.ran !== true) throw new Error('the review ran')
  if (report.verdict !== 'fail') throw new Error('a structure diagram must not pass: ' + report.verdict)
  if (findFinding(report, 'UML_NOT_A_STATE_DIAGRAM').length !== 1) throw new Error('expected the parse finding in the review')
  if (report.summary.errors < 1) throw new Error('the summary must count it as an error')
  if ((report.discardedConstructs ?? []).length !== 4 || report.discardedEdges !== 2) {
    throw new Error('the review must echo the discarded constructs: ' + JSON.stringify(report.discardedConstructs))
  }
  if (!report.nextSteps.some((step) => step.includes('not a state or activity diagram'))) {
    throw new Error('the next steps must say the file is the wrong diagram family')
  }
  assertNoUndefinedValues(report)
})

test('review: a component diagram presented as a model is a failed review too', () => {
  const report = reviewUml({ model, diagram: componentDiagram })
  if (report.source !== 'model+diagram') throw new Error('source not reported')
  if (report.verdict !== 'fail') throw new Error('a mismatched, non-state diagram must fail: ' + report.verdict)
  if (report.roundTrip === null || report.roundTrip.ok) throw new Error('the round trip must fail against a real machine')
  if (report.roundTrip.hashSpec !== 'v1') throw new Error('the round-trip report must name its hash spec')
})

test('parse: another Mermaid family is refused by name, with a code', () => {
  let refusal
  try { parseUml(['classDiagram', '  class OrderService', '  OrderService --> PaymentAdapter'].join('\n')) } catch (error) { refusal = error }
  if (!(refusal instanceof UmlError)) throw new Error('expected a UmlError refusal')
  if (refusal.code !== 'UML_NOT_A_STATE_DIAGRAM') throw new Error('refusal code: ' + refusal.code)
  if (!refusal.message.includes('`classDiagram`')) throw new Error('the refusal must name the family: ' + refusal.message)
})

test('review: an unreadable family is an error report with a failing verdict', () => {
  const report = reviewUml({ diagram: ['erDiagram', '  USER ||--o{ ORDER : places'].join('\n') })
  if (report.ok !== false || report.verdict !== 'fail') throw new Error('expected ok:false and verdict fail')
  if (findFinding(report, 'UML001_DIAGRAM_UNREADABLE').length !== 1) throw new Error('expected UML001')
  if (!report.findings[0].message.includes('erDiagram')) throw new Error('the message must name the family: ' + report.findings[0].message)
})

test('parse: a multi-line note is not mistaken for an unsupported construct', () => {
  // The construct keywords are ordinary English words. A note block that mentions one
  // must not turn a legitimately parsed state diagram into a failed review — and it must
  // not be read as the construct its body happens to name. R7: the block itself is reported
  // once as `note`, at its start line.
  const text = [
    'stateDiagram-v2',
    '  [*] --> IDLE',
    '  IDLE --> BUSY : start',
    '  BUSY --> IDLE : done',
    '  note left of IDLE',
    '    the component layer owns this state',
    '    package boundaries do not apply here',
    '  end note',
  ].join('\n')
  const parsed = parseUml(text)
  const foreign = parsed.discardedConstructs.filter((entry) => entry.construct !== 'note')
  if (foreign.length !== 0) throw new Error('a note body must not be read as a construct: ' + JSON.stringify(foreign))
  if (parsed.discardedConstructs.length !== 1 || parsed.discardedConstructs[0].line !== 5) {
    throw new Error('the note block itself must be reported once, at its start line: ' + JSON.stringify(parsed.discardedConstructs))
  }
  const report = reviewUml({ diagram: text })
  if (report.verdict === 'fail') throw new Error('a note mentioning a construct keyword must not fail the review: ' + report.verdictReason)
})

test('review: a well-modelled machine still passes (the contract did not overreach)', () => {
  const report = reviewUml({ model })
  if (report.ran !== true) throw new Error('ran must be reported')
  if (report.verdict === 'fail') throw new Error('no error finding here: ' + report.verdictReason)
  if (report.summary.errors !== 0) throw new Error('expected no error findings')
})

test('review: names its contract, carries its hashes and reports narrative coverage', () => {
  const full = reviewUml({ model: narrated })
  if (full.schema !== 'logicprobe/uml/review/v1') throw new Error('schema: ' + full.schema)
  if (full.hashes.hashSpec !== 'v1') throw new Error('hashSpec: ' + JSON.stringify(full.hashes))
  if (full.roundTrip !== null && (full.hashes.modelHash === undefined || full.hashes.parsedHash === undefined)) {
    throw new Error('a round-tripped review must carry both hashes: ' + JSON.stringify(full.hashes))
  }
  if (full.narrativeCoverage === undefined || full.narrativeCoverage.states !== '5/5' || full.narrativeCoverage.events !== '5/5' || full.narrativeCoverage.scenarios !== '5/5') {
    throw new Error('a present narrative always reports its coverage: ' + JSON.stringify(full.narrativeCoverage))
  }
  if (full.nextSteps.length === 0) throw new Error('nextSteps must not be empty')
  assertNoUndefinedValues(full)

  // P1-9: a partial narrative is valid, its gap is reported as coverage and as UML027.
  const partial = { ...model, narrative: { states: { INIT: 'power-on, not ready' } } }
  const report = reviewUml({ model: partial })
  if (report.ok !== true || report.summary.errors !== 0) throw new Error('a partial narrative must not fail the review')
  if (JSON.stringify(report.narrativeCoverage) !== JSON.stringify({ states: '1/5', events: '0/5', scenarios: '0/5' })) {
    throw new Error('coverage: ' + JSON.stringify(report.narrativeCoverage))
  }
  const finding = findFinding(report, 'UML027_NARRATIVE_PARTIAL')[0]
  if (finding === undefined || finding.severity !== 'info') throw new Error('expected an info-level UML027, got ' + JSON.stringify(codes(report)))
  if (finding.evidence.narrativeCoverage.states !== '1/5') throw new Error('the finding must carry the coverage')
  if (findFinding(report, 'UML013_NO_NARRATIVE').length !== 0) throw new Error('a partial narrative is not "no narrative"')
  assertNoUndefinedValues(report)
})

test('review: full narrative coverage silences UML027, and absence keeps UML013', () => {
  const complete = reviewUml({ model: { ...narrated, narrative: {
    states: { INIT: 'a', STARTING: 'b', ACTIVE: 'c', ERROR: 'd', FATAL: 'e' },
    events: { power_ready: 'a', ack: 'b', stop: 'c', timeout: 'd', cooldown: 'e' },
    scenarios: [
      { from: 'INIT', event: 'power_ready', scenario: 'a' },
      { from: 'STARTING', event: 'ack', scenario: 'b' },
      { from: 'ACTIVE', event: 'stop', scenario: 'c' },
      { from: 'STARTING', event: 'timeout', scenario: 'd' },
      { from: 'ERROR', event: 'cooldown', scenario: 'e' },
    ],
  } } })
  if (findFinding(complete, 'UML027_NARRATIVE_PARTIAL').length !== 0) throw new Error('full coverage must not be partial')
  if (complete.narrativeCoverage.states !== '5/5' || complete.narrativeCoverage.scenarios !== '5/5') {
    throw new Error('coverage: ' + JSON.stringify(complete.narrativeCoverage))
  }
  const absent = reviewUml({ model })
  if (findFinding(absent, 'UML013_NO_NARRATIVE').length !== 1) throw new Error('an absent narrative keeps UML013')
  if ('narrativeCoverage' in absent) throw new Error('an absent narrative has no coverage to report')
})

test('explain-labels: every documented claim is true of the parser', () => {
  const explanation = explainLabels('mermaid')
  const narrative = { ...model, narrative: { states: { INIT: 'power-on, not ready', STARTING: 'handshake in flight', ACTIVE: 'running', ERROR: 'retryable failure', FATAL: 'unrecoverable' }, events: { power_ready: 'a', ack: 'b', stop: 'c', timeout: 'd', cooldown: 'e' }, scenarios: [
    { from: 'INIT', event: 'power_ready', scenario: 's1' }, { from: 'STARTING', event: 'ack', scenario: 's2' },
    { from: 'ACTIVE', event: 'stop', scenario: 's3' }, { from: 'STARTING', event: 'timeout', scenario: 's4' },
    { from: 'ERROR', event: 'cooldown', scenario: 's5' },
  ] } }
  const rendered = renderUml(narrative, 'mermaid', 'state').primary
  if (!rendered.includes(explanation.renderedForm.replace('ID（meaning）', 'INIT（power-on, not ready）').replace(' as ID', ' as INIT'))) {
    throw new Error('the documented rendered form is not what the renderer writes:\n' + rendered)
  }

  // Each accepted label form must be read as the same meaning (no UML015 drift).
  const withLabel = (line) => ['%%logicprobe:init INIT', '%%logicprobe:terminal FATAL', 'stateDiagram-v2', '  [*] --> INIT', '  ' + line, '  INIT --> STARTING : power_ready', '  STARTING --> ACTIVE : ack', '  ACTIVE --> FATAL : stop', '  STARTING --> ERROR : timeout', '  ERROR --> STARTING : cooldown', '  FATAL --> [*]'].join('\n')
  const accepted = explanation.acceptedLabelForms.filter((form) => form.form !== 'bare id' && form.form !== 'a description line' && form.form !== 'a single-line note')
  for (const form of accepted) {
    const report = reviewUml({ model: narrative, diagram: withLabel(form.example.replace('IDLE', 'INIT').replace('waiting for power', 'power-on, not ready')) })
    if (findFinding(report, 'UML015_LABEL_DRIFT').length !== 0) {
      throw new Error('the documented form "' + form.form + '" must not be drift: ' + JSON.stringify(findFinding(report, 'UML015_LABEL_DRIFT')[0]?.detail))
    }
  }
  // The bare id is documented as "no meaning", i.e. undocumented rather than drift.
  const bare = reviewUml({ model: narrative, diagram: withLabel('state "INIT" as INIT') })
  if (findFinding(bare, 'UML014_UNDOCUMENTED_STATE').length === 0) throw new Error('a bare id must count as undocumented')
  if (findFinding(bare, 'UML015_LABEL_DRIFT').length !== 0) throw new Error('a bare id is not drift')

  // A description line and a single-line note are the same meaning in another spelling.
  for (const line of ['INIT : power-on, not ready', 'note right of INIT : power-on, not ready']) {
    const report = reviewUml({ model: narrative, diagram: withLabel(line) })
    if (findFinding(report, 'UML014_UNDOCUMENTED_STATE').length !== 0 && findFinding(report, 'UML015_LABEL_DRIFT').length !== 0) {
      throw new Error('"' + line + '" must be read as a meaning')
    }
  }

  // Ignored lines: a plain comment warns, a multi-line note block does not — but R7 makes it
  // reported rather than invisible, so the two channels stay distinguishable.
  const commented = reviewUml({ model: narrative, diagram: withLabel('%% this comment carries nothing') })
  if (!commented.warnings.some((warning) => warning.includes('UML_PARSE_IGNORED_LINE'))) {
    throw new Error('a non-directive comment must be reported: ' + JSON.stringify(commented.warnings))
  }
  const noted = reviewUml({ model: narrative, diagram: withLabel(['note left of INIT', '  several lines', 'end note'].join('\n')) })
  if (noted.warnings.some((warning) => warning.includes('UML_PARSE_IGNORED_LINE'))) {
    throw new Error('a multi-line note block must not warn line by line: ' + JSON.stringify(noted.warnings))
  }
  if (!(noted.discardedConstructs ?? []).some((entry) => entry.construct === 'note')) {
    throw new Error('a multi-line note block must be reported in discardedConstructs: ' + JSON.stringify(noted.discardedConstructs))
  }
  // The claim and the behaviour are asserted together: R7 changed the behaviour, and a
  // self-description that still said "skipped silently" would be exactly the drift this
  // test exists to prevent.
  const noteClaim = explanation.ignoredLines.find((entry) => entry.pattern.includes('note'))
  if (noteClaim === undefined) throw new Error('the note block must be described in ignoredLines')
  if (!noteClaim.behaviour.includes('discardedConstructs')) {
    throw new Error('the documented behaviour of a note block disagrees with the parser: ' + noteClaim.behaviour)
  }

  // The directive prefix is the one the parser consumes, in both notations.
  if (explainLabels('mermaid').directivePrefix !== '%%logicprobe:') throw new Error('mermaid directive prefix')
  if (explainLabels('plantuml').directivePrefix !== "'logicprobe:") throw new Error('plantuml directive prefix')
  const plantuml = parseUml(["'logicprobe:uml v1 notation=plantuml diagram=state", "'logicprobe:init INIT", '@startuml', 'state "INIT" as INIT', 'state "DONE" as DONE', "[*] --> INIT", 'INIT --> DONE : go', 'DONE --> [*]', '@enduml'].join('\n'))
  if (plantuml.model.init !== 'INIT') throw new Error('the documented directive form must be consumed')
  assertNoUndefinedValues(explanation)
})

if (failures > 0) { console.log('uml tests failed:', failures); process.exit(1) }
console.log('all uml tests passed')
