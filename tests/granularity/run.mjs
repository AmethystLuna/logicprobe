// Multi-granularity review: one architecture at several levels of detail. The property
// under test is refinement — a child may add detail BELOW the parent level, never a
// dependency AT the parent level, and never silently drop one.
import { reviewGranularity, granularityDigest } from '../../lib/granularity.js'

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

const puml = (...lines) => ['@startuml', ...lines, '@enduml'].join('\n')

// L0 (repository level) and a child that expands one of its edges through a new node.
const l0 = puml('component [SVC] as SVC', 'component [PAY] as PAY', 'component [DB] as DB', 'SVC --> PAY', 'PAY --> DB')
const expanded = puml('component [SVC] as SVC', 'component [PAY] as PAY', 'component [DB] as DB', 'component [Retry] as RETRY', 'SVC --> RETRY', 'RETRY --> PAY', 'PAY --> DB')

function codes(report) {
  return report.findings.map((finding) => finding.code)
}

function findFinding(report, code) {
  return report.findings.filter((finding) => finding.code === code)
}

test('a proper refinement passes and reports the expansion per pair', () => {
  const report = reviewGranularity({ diagrams: [{ name: 'L0', diagram: l0 }, { name: 'L1', diagram: expanded, parent: 'L0' }] })
  if (report.verdict !== 'pass') throw new Error('a refinement must pass: ' + report.verdictReason + ' ' + JSON.stringify(codes(report)))
  const pair = report.pairs[0]
  if (pair.parent !== 'L0' || pair.child !== 'L1') throw new Error('pair identity: ' + JSON.stringify(pair))
  if (pair.parentNodes !== 3 || pair.childNodes !== 4) throw new Error('node counts: ' + JSON.stringify(pair))
  if (pair.inheritedEdges !== 1) throw new Error('PAY→DB is inherited: ' + JSON.stringify(pair))
  if (pair.newEdges !== 2) throw new Error('the two arrows through RETRY are the child-level detail: ' + JSON.stringify(pair))
  if (pair.expandedEdges.length !== 1 || pair.expandedEdges[0].from !== 'SVC' || pair.expandedEdges[0].to !== 'PAY') {
    throw new Error('SVC→PAY is a legitimate expansion: ' + JSON.stringify(pair.expandedEdges))
  }
  if (pair.inventedEdges.length !== 0 || pair.missingEdges.length !== 0) throw new Error('nothing invented or dropped: ' + JSON.stringify(pair))
  if (report.summary.expandedEdges !== 1 || report.summary.pairs !== 1) throw new Error('summary: ' + JSON.stringify(report.summary))
  if (report.schema !== 'logicprobe/granularity/v1') throw new Error('schema: ' + report.schema)
  if (report.hashes.diagrams.length !== 2 || report.hashes.diagrams[0].hash.length !== 64) throw new Error('hashes: ' + JSON.stringify(report.hashes))
  if (report.nextSteps.length === 0) throw new Error('nextSteps must not be empty')
  assertNoUndefinedValues(report)
})

test('a dependency the parent does not have is a refinement violation', () => {
  const invented = puml('component [SVC] as SVC', 'component [PAY] as PAY', 'component [DB] as DB', 'SVC --> PAY', 'PAY --> DB', 'PAY --> SVC')
  const report = reviewGranularity({ diagrams: [{ name: 'L0', diagram: l0 }, { name: 'L1', diagram: invented, parent: 'L0' }] })
  const finding = findFinding(report, 'UML029_REFINEMENT_VIOLATION')[0]
  if (finding === undefined) throw new Error('expected UML029, got ' + JSON.stringify(codes(report)))
  if (finding.evidence.kind !== 'invented-edge') throw new Error('kind: ' + JSON.stringify(finding.evidence))
  if (finding.file !== 'L1') throw new Error('the finding must name the diagram: ' + finding.file)
  if (!finding.message.includes('PAY → SVC')) throw new Error('the edge must be named: ' + finding.message)
  if (report.summary.inventedEdges !== 1 || report.verdict !== 'fail') throw new Error('summary/verdict: ' + JSON.stringify(report.summary))
})

test('dropping a parent edge without expanding it is a refinement violation', () => {
  const dropped = puml('component [SVC] as SVC', 'component [PAY] as PAY', 'component [DB] as DB', 'SVC --> PAY')
  const report = reviewGranularity({ diagrams: [{ name: 'L0', diagram: l0 }, { name: 'L1', diagram: dropped, parent: 'L0' }] })
  const finding = findFinding(report, 'UML029_REFINEMENT_VIOLATION')[0]
  if (finding === undefined) throw new Error('expected UML029, got ' + JSON.stringify(codes(report)))
  if (finding.evidence.kind !== 'unexpanded-edge') throw new Error('kind: ' + JSON.stringify(finding.evidence))
  if (!finding.message.includes('PAY → DB')) throw new Error('the dropped edge must be named: ' + finding.message)
  if (report.pairs[0].missingEdges.length !== 1) throw new Error('missingEdges: ' + JSON.stringify(report.pairs[0]))
})

test('a child that covers a subtree is not accused of dropping the rest', () => {
  // The child only carries PAY and DB: the parent's SVC→PAY has an end the child does not
  // have, so it is out of scope for this level rather than dropped.
  const subtree = puml('component [PAY] as PAY', 'component [DB] as DB', 'PAY --> DB')
  const report = reviewGranularity({ diagrams: [{ name: 'L0', diagram: l0 }, { name: 'L1', diagram: subtree, parent: 'L0' }] })
  if (findFinding(report, 'UML029_REFINEMENT_VIOLATION').length !== 0) {
    throw new Error('a subtree refinement is legitimate: ' + JSON.stringify(report.findings.map((finding) => finding.message)))
  }
})

test('an unknown parent and a parent cycle are reported', () => {
  const orphan = reviewGranularity({ diagrams: [{ name: 'L1', diagram: expanded, parent: 'NOPE' }] })
  const unknown = findFinding(orphan, 'UML028_UNKNOWN_PARENT')[0]
  if (unknown === undefined) throw new Error('expected UML028')
  if (!unknown.message.includes('NOPE')) throw new Error('the parent must be named: ' + unknown.message)
  const cycle = reviewGranularity({ diagrams: [{ name: 'a', diagram: l0, parent: 'b' }, { name: 'b', diagram: l0, parent: 'a' }] })
  const cyclic = findFinding(cycle, 'UML030_PARENT_CYCLE')[0]
  if (cyclic === undefined) throw new Error('expected UML030, got ' + JSON.stringify(codes(cycle)))
  if (cyclic.evidence.cycle.length < 3) throw new Error('the cycle path must be reported: ' + JSON.stringify(cyclic.evidence))
  if (cycle.verdict !== 'fail') throw new Error('a cyclic hierarchy fails')
})

test('per-diagram checks still run, tagged with the diagram they came from', () => {
  const withOrphan = puml('component [SVC] as SVC', 'component [PAY] as PAY', 'component [Ghost] as GHOST', 'SVC --> PAY')
  const report = reviewGranularity({ diagrams: [{ name: 'L0', diagram: l0 }, { name: 'L1', diagram: withOrphan, parent: 'L0' }] })
  const isolated = findFinding(report, 'UML020_ISOLATED_NODE')[0]
  if (isolated === undefined) throw new Error('the per-diagram structural checks must run')
  if (isolated.file !== 'L1') throw new Error('the finding must be tagged with its diagram: ' + isolated.file)
  const fromParent = report.findings.filter((finding) => finding.file === 'L0')
  if (fromParent.length !== 0) throw new Error('L0 is clean here: ' + JSON.stringify(fromParent))
  if (!report.diagrams.some((entry) => entry.name === 'L1' && entry.findings > 0)) throw new Error('the per-diagram summary must count them')
})

test('an empty set and a missing parent relation are called out', () => {
  const empty = reviewGranularity({ diagrams: [] })
  if (findFinding(empty, 'UML031_NO_DIAGRAMS').length !== 1) throw new Error('expected UML031')
  const rootsOnly = reviewGranularity({ diagrams: [{ name: 'L0', diagram: l0 }, { name: 'L2', diagram: expanded }] })
  if (rootsOnly.pairs.length !== 0) throw new Error('no parent, no pair')
  if (!rootsOnly.nextSteps.some((step) => step.includes('`parent`'))) throw new Error('the report must ask for the relation: ' + JSON.stringify(rootsOnly.nextSteps))
})

test('the report is deterministic and its pair table digests stably', () => {
  const options = { diagrams: [{ name: 'L0', diagram: l0 }, { name: 'L1', diagram: expanded, parent: 'L0' }] }
  const first = reviewGranularity(options)
  const second = reviewGranularity(options)
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error('the report must be deterministic')
  if (granularityDigest(first.pairs) !== granularityDigest(second.pairs)) throw new Error('the digest must be stable')
  // Key order inside the digest input must not matter.
  if (granularityDigest([{ parent: 'a', child: 'b', parentNodes: 1, childNodes: 2, parentEdges: 3, childEdges: 4, inheritedEdges: 5, newEdges: 6, expandedEdges: [], missingEdges: [], inventedEdges: [] }])
    !== granularityDigest([{ inventedEdges: [], missingEdges: [], expandedEdges: [], newEdges: 6, inheritedEdges: 5, childEdges: 4, parentEdges: 3, childNodes: 2, parentNodes: 1, child: 'b', parent: 'a' }])) {
    throw new Error('the digest must be canonical')
  }
})

test('a three-level hierarchy checks every declared pair', () => {
  const l2 = puml('component [SVC] as SVC', 'component [PAY] as PAY', 'component [Retry] as RETRY', 'component [Idem] as IDEM', 'SVC --> RETRY', 'RETRY --> IDEM', 'IDEM --> PAY')
  const report = reviewGranularity({
    diagrams: [
      { name: 'L0', diagram: l0 },
      { name: 'L1', diagram: expanded, parent: 'L0' },
      { name: 'L2', diagram: l2, parent: 'L1' },
    ],
  })
  if (report.pairs.length !== 2) throw new Error('two declared pairs, got ' + report.pairs.length)
  if (report.summary.roots !== 1) throw new Error('one root')
  const l2Pair = report.pairs.find((pair) => pair.child === 'L2')
  if (l2Pair.expandedEdges.length === 0) throw new Error('L1→L2 expands an edge: ' + JSON.stringify(l2Pair))
  assertNoUndefinedValues(report)
})

if (failures > 0) { console.log('granularity tests failed:', failures); process.exit(1) }
console.log('all granularity tests passed')
