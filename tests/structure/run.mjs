// Structure-diagram review: a component diagram is a dependency graph, not a state
// machine. This suite pins the parser, the six structural checks, the dependency
// matrix semantics (deny wins globally, default allow/deny, required edges) and the
// report contract. Every case is a shape a reader gets wrong by eye, which is the
// only reason the check exists.
import { readFileSync } from 'node:fs'
import { parseStructure, reviewStructure, shortestCycle, globMatches, validateMatrix } from '../../lib/structure.js'

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

function codes(report) {
  return report.findings.map((finding) => finding.code)
}

function findFinding(report, code) {
  return report.findings.filter((finding) => finding.code === code)
}

// The diagram from the worked example: two packages, an orphan, a back edge and an
// endpoint nobody declared.
const componentDiagram = [
  '@startuml',
  'package "app" {',
  '  component [Order Service] as SVC',
  '  component [Payment Adapter] as PAY',
  '}',
  'package "hal" {',
  '  component [Storage Driver] as DRV',
  '}',
  'component [Orphan Cache] as CACHE',
  'component [Persistence] as DB',
  'SVC --> PAY : plan',
  'PAY --> DRV : read',
  'DRV --> SVC : fault',
  'SVC --> GHOST : unknown',
  'PAY --> DB : store',
  '@enduml',
].join('\n')

// ---------------------------------------------------------------- parsing --

test('parse: declarations, aliases, labels, containers and nesting', () => {
  const graph = parseStructure(componentDiagram)
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  if (byId.size !== 8) throw new Error('expected 8 nodes, got ' + [...byId.keys()].join(','))
  const ms = byId.get('SVC')
  if (ms.label !== 'Order Service') throw new Error('alias label lost: ' + JSON.stringify(ms))
  if (ms.parent !== 'app') throw new Error('package nesting lost: ' + JSON.stringify(ms))
  if (byId.get('app').container !== true) throw new Error('a package is a container')
  if (byId.get('CACHE').parent !== undefined) throw new Error('a top-level node has no parent')
  if (graph.edges.length !== 5) throw new Error('expected 5 edges, got ' + graph.edges.length)
  const read = graph.edges.find((edge) => edge.from === 'PAY' && edge.to === 'DRV')
  if (read.label !== 'read') throw new Error('edge label lost: ' + JSON.stringify(read))
  if (read.line !== 12) throw new Error('edge line should be 12, got ' + read.line)
})

test('parse: an undeclared endpoint is kept and marked', () => {
  const graph = parseStructure(componentDiagram)
  const ghost = graph.nodes.find((node) => node.id === 'GHOST')
  if (ghost === undefined || ghost.declared !== false) throw new Error('GHOST must exist and be undeclared')
})

test('parse: note blocks are not dependencies', () => {
  const text = [
    '@startuml',
    'component [A] as A',
    'component [B] as B',
    'note left of A',
    '  the B component owns this path',
    'end note',
    'A --> B',
    '@enduml',
  ].join('\n')
  const graph = parseStructure(text)
  if (graph.edges.length !== 1) throw new Error('a note body must not become an edge: ' + JSON.stringify(graph.edges))
  if (graph.nodes.length !== 2) throw new Error('a note body must not become a node')
})

test('parse: a mermaid class diagram reads classes and arrows', () => {
  const text = ['classDiagram', '  class OrderService', '  class PaymentAdapter', '  OrderService --> PaymentAdapter : uses'].join('\n')
  const graph = parseStructure(text)
  if (graph.notation !== 'mermaid') throw new Error('notation not reported')
  if (graph.nodes.length !== 2 || graph.edges.length !== 1) throw new Error('mermaid class parse: ' + JSON.stringify(graph))
  if (graph.edges[0].label !== 'uses') throw new Error('edge label lost')
})

test('parse: an unmodelled statement is warned about, never dropped', () => {
  const graph = parseStructure(['@startuml', 'component [A] as A', 'component [B] as B', 'A --> B', 'this line is not a statement', '@enduml'].join('\n'))
  if (!graph.warnings.some((warning) => warning.startsWith('STRUCTURE_IGNORED_LINE'))) {
    throw new Error('the ignored line must be reported: ' + JSON.stringify(graph.warnings))
  }
})

// ------------------------------------------------------------- graph maths --

test('shortest cycle: forward path, self-loop, and none', () => {
  const three = shortestCycle(['A', 'B', 'C'], [{ from: 'A', to: 'B', line: 1 }, { from: 'B', to: 'C', line: 2 }, { from: 'C', to: 'A', line: 3 }])
  if (JSON.stringify(three) !== JSON.stringify(['A', 'B', 'C', 'A'])) throw new Error('cycle path: ' + JSON.stringify(three))
  const self = shortestCycle(['A'], [{ from: 'A', to: 'A', line: 1 }])
  if (JSON.stringify(self) !== JSON.stringify(['A', 'A'])) throw new Error('self loop: ' + JSON.stringify(self))
  if (shortestCycle(['A', 'B'], [{ from: 'A', to: 'B', line: 1 }]) !== undefined) throw new Error('a DAG has no cycle')
})

test('shortest cycle: picks the shorter of two cycles', () => {
  const edges = [
    { from: 'A', to: 'B', line: 1 },
    { from: 'B', to: 'C', line: 2 },
    { from: 'C', to: 'D', line: 3 },
    { from: 'D', to: 'A', line: 4 },
    { from: 'A', to: 'E', line: 5 },
    { from: 'E', to: 'A', line: 6 },
  ]
  const cycle = shortestCycle(['A', 'B', 'C', 'D', 'E'], edges)
  if (JSON.stringify(cycle) !== JSON.stringify(['A', 'E', 'A'])) throw new Error('expected the 2-edge cycle, got ' + JSON.stringify(cycle))
})

test('glob: * spans separators, ? is one character, a literal matches itself', () => {
  if (!globMatches('app.*', 'app.motion')) throw new Error('app.* must match app.motion')
  if (globMatches('app.*', 'hal.app')) throw new Error('app.* must not match hal.app')
  if (!globMatches('*', 'anything.at.all')) throw new Error('* matches everything')
  if (!globMatches('S?', 'SV')) throw new Error('? matches one character')
  if (globMatches('S?', 'SVC')) throw new Error('? matches exactly one character')
  if (!globMatches('SVC', 'SVC')) throw new Error('a literal matches itself')
  if (globMatches('SVC', 'SVCX')) throw new Error('a literal is not a prefix match')
})

// ------------------------------------------------------------ structural --

test('review: the two-isolated-node case is reported as UML020', () => {
  // The requirements this came from: two component nodes with no edge, missed by eye.
  const text = ['@startuml', 'component [A] as A', 'component [B] as B', 'component [C] as C', 'A --> B', '@enduml'].join('\n')
  const report = reviewStructure({ diagram: text })
  const finding = findFinding(report, 'UML020_ISOLATED_NODE')[0]
  if (finding === undefined) throw new Error('expected UML020, got ' + JSON.stringify(codes(report)))
  if (finding.evidence.nodes.map((node) => node.id).join(',') !== 'C') throw new Error('the isolated node must be named')
  if (report.summary.isolated !== 1) throw new Error('summary.isolated: ' + report.summary.isolated)
  if (report.verdict !== 'pass_with_findings') throw new Error('a warning alone is pass_with_findings, got ' + report.verdict)
})

test('review: a container with no edge is not an isolated node', () => {
  const text = ['@startuml', 'package "empty" {', '  component [A] as A', '}', 'component [B] as B', 'A --> B', '@enduml'].join('\n')
  const report = reviewStructure({ diagram: text })
  if (findFinding(report, 'UML020_ISOLATED_NODE').length !== 0) throw new Error('a package carries members, not dependencies')
})

test('review: dangling endpoint, cycle and orphan all fire on one diagram', () => {
  const report = reviewStructure({ diagram: componentDiagram })
  for (const code of ['UML021_DANGLING_REFERENCE', 'UML020_ISOLATED_NODE', 'UML022_CYCLE']) {
    if (findFinding(report, code).length === 0) throw new Error('missing ' + code + ' in ' + JSON.stringify(codes(report)))
  }
  const cycle = findFinding(report, 'UML022_CYCLE')[0]
  if (JSON.stringify(cycle.evidence.cycle) !== JSON.stringify(['SVC', 'PAY', 'DRV', 'SVC'])) {
    throw new Error('cycle path: ' + JSON.stringify(cycle.evidence.cycle))
  }
  if (report.verdict !== 'fail') throw new Error('an error finding fails the review')
  assertNoUndefinedValues(report)
})

test('review: text with no node is an error report, not an empty pass', () => {
  const report = reviewStructure({ diagram: 'this is not a diagram' })
  if (findFinding(report, 'UML026_NO_NODES').length !== 1) throw new Error('expected UML026, got ' + JSON.stringify(codes(report)))
  if (report.verdict !== 'fail') throw new Error('nothing to review is a failure')
})

// ----------------------------------------------------------------- matrix --

const matrix = {
  rules: [
    { id: 'R1-app-may-use-hal', source: 'SVC', allow: ['PAY'], deny: ['DRV'] },
    { id: 'R2-adapter-owns-hal', source: 'PAY', allow: ['DRV'], deny: ['SVC'] },
    { id: 'R3-no-back-edges', source: '*', deny: ['SVC'] },
    { id: 'R4-persistence-required', source: 'PAY', allow: ['DB'], require: true },
  ],
  layers: [
    { name: 'app', members: ['SVC', 'PAY'] },
    { name: 'hal', members: ['DRV'] },
  ],
  default: 'deny',
}

test('matrix: every edge is judged and names the rules it matched', () => {
  const report = reviewStructure({ diagram: componentDiagram, matrix })
  const verdicts = new Map(report.edgeVerdicts.map((verdict) => [verdict.from + '->' + verdict.to, verdict]))
  const back = verdicts.get('DRV->SVC')
  if (back.allowed !== false || back.basis !== 'deny') throw new Error('R3 must deny DRV→SVC: ' + JSON.stringify(back))
  if (!back.matchedRules.includes('R3-no-back-edges')) throw new Error('the denying rule id must be reported')
  const unknown = verdicts.get('SVC->GHOST')
  if (unknown.allowed !== false || unknown.basis !== 'unlisted') throw new Error('default deny must close the matrix: ' + JSON.stringify(unknown))
  const read = verdicts.get('PAY->DRV')
  if (read.allowed !== true || read.basis !== 'allow') throw new Error('R2 must allow PAY→DRV: ' + JSON.stringify(read))
  if (report.summary.disallowedEdges !== 2) throw new Error('disallowedEdges: ' + report.summary.disallowedEdges)
  assertNoUndefinedValues(report)
})

test('matrix: deny wins globally, whatever the rule order', () => {
  const diagram = ['@startuml', 'component [A] as A', 'component [B] as B', 'A --> B', '@enduml'].join('\n')
  const denyFirst = reviewStructure({ diagram, matrix: { rules: [{ id: 'D', source: 'A', deny: ['B'] }, { id: 'A1', source: 'A', allow: ['B'] }] } })
  const allowFirst = reviewStructure({ diagram, matrix: { rules: [{ id: 'A1', source: 'A', allow: ['B'] }, { id: 'D', source: 'A', deny: ['B'] }] } })
  if (denyFirst.verdict !== 'fail' || allowFirst.verdict !== 'fail') {
    throw new Error('a deny must not depend on rule order: ' + denyFirst.verdict + ' / ' + allowFirst.verdict)
  }
  if (denyFirst.edgeVerdicts[0].basis !== allowFirst.edgeVerdicts[0].basis) throw new Error('basis must agree')
})

test('matrix: allow and deny in one rule is a deny exception list', () => {
  const diagram = ['@startuml', 'component [A] as A', 'component [B] as B', 'component [C] as C', 'A --> B', 'A --> C', '@enduml'].join('\n')
  const report = reviewStructure({ diagram, matrix: { rules: [{ id: 'R', source: 'A', allow: ['*'], deny: ['C'] }] } })
  const verdicts = new Map(report.edgeVerdicts.map((verdict) => [verdict.to, verdict]))
  if (verdicts.get('B').basis !== 'allow') throw new Error('B must be allowed by the wildcard')
  if (verdicts.get('C').basis !== 'deny') throw new Error('C must be denied by the exception')
})

test('matrix: default allow lets unlisted edges through as `default`', () => {
  const diagram = ['@startuml', 'component [A] as A', 'component [B] as B', 'A --> B', '@enduml'].join('\n')
  const report = reviewStructure({ diagram, matrix: { rules: [{ id: 'R', source: 'X', allow: ['Y'] }] } })
  if (report.edgeVerdicts[0].basis !== 'default' || report.edgeVerdicts[0].allowed !== true) {
    throw new Error('default allow: ' + JSON.stringify(report.edgeVerdicts[0]))
  }
  if (report.verdict !== 'pass') throw new Error('an unjudged edge is not a finding, got ' + report.verdict)
})

test('matrix: a layer violation is an upward edge between declared layers', () => {
  const report = reviewStructure({ diagram: componentDiagram, matrix })
  const violation = findFinding(report, 'UML024_LAYER_VIOLATION')[0]
  if (violation === undefined) throw new Error('expected UML024, got ' + JSON.stringify(codes(report)))
  const entry = violation.evidence.violations[0]
  if (entry.from !== 'DRV' || entry.to !== 'SVC' || entry.fromLayer !== 'hal' || entry.toLayer !== 'app') {
    throw new Error('violation detail: ' + JSON.stringify(entry))
  }
})

test('matrix: a downward edge is not a layer violation', () => {
  const diagram = ['@startuml', 'component [A] as A', 'component [B] as B', 'A --> B', '@enduml'].join('\n')
  const report = reviewStructure({ diagram, matrix: { layers: [{ name: 'app', members: ['A'] }, { name: 'hal', members: ['B'] }] } })
  if (findFinding(report, 'UML024_LAYER_VIOLATION').length !== 0) throw new Error('top→bottom is the allowed direction')
})

test('matrix: a required edge that is absent is UML025, including a missing target node', () => {
  const diagram = ['@startuml', 'component [SVC] as SVC', 'component [DRV] as DRV', 'SVC --> DRV', '@enduml'].join('\n')
  const absentTarget = reviewStructure({ diagram, matrix: { rules: [{ id: 'R9', source: 'SVC', allow: ['DB'], require: true }] } })
  const finding = findFinding(absentTarget, 'UML025_MISSING_EXPECTED_EDGE')[0]
  if (finding === undefined) throw new Error('a required edge with no such target node must be reported')
  if (finding.evidence.missing[0].unsatisfiedFrom.join(',') !== 'SVC') throw new Error('the unsatisfied source must be named: ' + JSON.stringify(finding.evidence))
  const noSource = reviewStructure({ diagram, matrix: { rules: [{ id: 'R9', source: 'NOPE', allow: ['DRV'], require: true }] } })
  if (noSource.findings[0].evidence.missing[0].noSourceMatch !== true) throw new Error('a source pattern matching nothing must be distinguished')
  const satisfied = reviewStructure({ diagram, matrix: { rules: [{ id: 'R9', source: 'SVC', allow: ['DRV'], require: true }] } })
  if (findFinding(satisfied, 'UML025_MISSING_EXPECTED_EDGE').length !== 0) throw new Error('a satisfied requirement must be silent')
  if (absentTarget.verdict !== 'pass_with_findings') throw new Error('UML025 is a warning: ' + absentTarget.verdict)
})

test('matrix: an invalid matrix is a hard error and applies no rules', () => {
  const diagram = ['@startuml', 'component [A] as A', 'component [B] as B', 'A --> B', '@enduml'].join('\n')
  for (const [label, matrix, needle] of [
    ['typo', { rules: [{ id: 'R', sorce: 'A' }] }, 'unknown field'],
    ['duplicate id', { rules: [{ id: 'R', source: 'A' }, { id: 'R', source: 'B' }] }, 'duplicate rule id'],
    ['require without allow', { rules: [{ id: 'R', source: 'A', require: true }] }, 'needs `allow`'],
    ['bad default', { default: 'maybe' }, "must be 'allow' or 'deny'"],
    ['empty members', { layers: [{ name: 'x', members: [] }] }, 'non-empty array'],
  ]) {
    const report = reviewStructure({ diagram, matrix })
    const code = findFinding(report, 'MATRIX_INVALID')
    if (code.length === 0) throw new Error(label + ': expected MATRIX_INVALID, got ' + JSON.stringify(codes(report)))
    if (!code[0].message.includes(needle)) throw new Error(label + ': message should mention ' + needle + ', got ' + code[0].message)
    if (report.verdict !== 'fail') throw new Error(label + ': an invalid matrix must fail the review')
    if (report.edgeVerdicts.some((verdict) => verdict.basis !== 'default')) throw new Error(label + ': no rule may apply')
  }
})

test('matrix: validateMatrix rejects unknown top-level keys and accepts a rule with allow and deny', () => {
  const bad = validateMatrix({ rule: [] })
  if (bad.ok || !bad.errors[0].includes('unknown field')) throw new Error('unknown top-level key must be rejected: ' + JSON.stringify(bad))
  const good = validateMatrix({ rules: [{ id: 'R', source: 'A', allow: ['B'], deny: ['C'] }] })
  if (!good.ok) throw new Error('allow + deny in one rule is legitimate: ' + JSON.stringify(good))
})

// ------------------------------------------------------------- contract --

test('review: the report contract holds (verdict, ran, summary, nextSteps)', () => {
  const report = reviewStructure({ diagram: componentDiagram })
  if (report.ok !== true || report.ran !== true) throw new Error('ok/ran must both be true')
  if (typeof report.verdictReason !== 'string' || report.verdictReason === '') throw new Error('verdictReason required')
  if (report.summary.nodes !== 8 || report.summary.edges !== 5 || report.summary.containers !== 2) {
    throw new Error('summary: ' + JSON.stringify(report.summary))
  }
  if (!report.nextSteps.some((step) => step.includes('dependency matrix'))) throw new Error('the report must ask for a matrix when none was given')
  if (!report.nextSteps.some((step) => step.includes('source-side'))) throw new Error('the report must route to the source-side reconciliation')
  assertNoUndefinedValues(report)
})

test('review: without a matrix no edge is judged and edgeVerdicts is absent', () => {
  const report = reviewStructure({ diagram: componentDiagram })
  if ('edgeVerdicts' in report) throw new Error('edgeVerdicts must be absent without a matrix')
  if (report.summary.rules !== 0) throw new Error('no rules may be counted')
})

// The guide documents this fixture's exact findings; keep the two in step.
test('guide fixture: the documented example still produces the documented codes', () => {
  const report = reviewStructure({ diagram: componentDiagram, matrix })
  const expected = ['UML021_DANGLING_REFERENCE', 'UML020_ISOLATED_NODE', 'UML022_CYCLE', 'UML023_DISALLOWED_EDGE', 'UML023_DISALLOWED_EDGE', 'UML024_LAYER_VIOLATION']
  if (JSON.stringify(codes(report)) !== JSON.stringify(expected)) {
    throw new Error('finding order changed, update references/structure-review-guide.md: ' + JSON.stringify(codes(report)))
  }
})

// The engine is the same in both hosts; this file is read by the Python parity suite.
test('fixtures on disk parse', () => {
  const path = new URL('./fixtures/component-diagram.puml', import.meta.url)
  const report = reviewStructure({ diagram: readFileSync(path, 'utf8') })
  if (report.summary.nodes < 4) throw new Error('fixture did not parse into a graph')
})

if (failures > 0) { console.log('structure tests failed:', failures); process.exit(1) }
console.log('all structure tests passed')
