/**
 * Multi-granularity structure review: one architecture, several levels of detail.
 *
 * A module diagram and the repository-wide diagram it belongs to are two views of one
 * fact, and nothing keeps them in step — the child grows a dependency the parent never
 * had, or the parent keeps an arrow the child quietly stopped drawing. This module
 * checks that a child diagram is a **refinement** of its declared parent:
 *
 * - every dependency the child draws between two nodes the parent also has must exist in
 *   the parent (nothing appears out of nowhere);
 * - an edge the parent draws and the child does not must be *expanded* in the child, i.e.
 *   a child path must connect the same two ends;
 * - the declared parent relation must be a forest, not a cycle.
 *
 * Every per-diagram structural check still runs, and its findings are tagged with the
 * diagram they came from (`file`), so one report can carry several diagrams without the
 * findings becoming anonymous.
 *
 * @module logicprobe-granularity
 */

import { createHash } from 'node:crypto'
import { REPORT_SCHEMAS, canonicalJson, verdictOfFindings, type Finding, type ReportSchema, type Verdict, type VerdictSummary } from './engine.js'
import { parseStructure, reviewStructure, type StructureGraph, type StructureNotation } from './structure.js'

export interface GranularityDiagram {
  /** Name of this level, e.g. `L2/motion` or `repo`. Referenced by a child's `parent`. */
  name: string
  /** Diagram source text. */
  diagram: string
  /** Name of the diagram this one refines; absent for a root. */
  parent?: string
}

export interface GranularityOptions {
  diagrams: GranularityDiagram[]
  notation?: 'auto' | StructureNotation
  /** Optional dependency matrix, applied to every diagram. */
  matrix?: unknown
}

export interface GranularityEdgeRef {
  from: string
  to: string
  line?: number
}

export interface GranularityPairSummary {
  parent: string
  child: string
  parentNodes: number
  childNodes: number
  parentEdges: number
  childEdges: number
  /** Child edges whose endpoints both exist in the parent and which the parent also draws. */
  inheritedEdges: number
  /** Child edges with at least one endpoint the parent does not have (the refinement's own detail). */
  newEdges: number
  /** Parent edges with no direct child counterpart, but a child path connects the same ends. */
  expandedEdges: GranularityEdgeRef[]
  /** Parent edges with no direct counterpart and no connecting path — the refinement lost them. */
  missingEdges: GranularityEdgeRef[]
  /** Child edges between two parent nodes that the parent does not draw — invented dependencies. */
  inventedEdges: GranularityEdgeRef[]
}

export interface GranularityDiagramSummary {
  name: string
  parent?: string
  notation: StructureNotation
  nodes: number
  edges: number
  verdict: Verdict
  findings: number
}

export interface GranularityReport {
  ok: boolean
  ran: boolean
  verdict: Verdict
  verdictReason: string
  schema: ReportSchema
  diagrams: GranularityDiagramSummary[]
  pairs: GranularityPairSummary[]
  findings: Finding[]
  summary: {
    diagrams: number
    roots: number
    pairs: number
    nodes: number
    edges: number
    inventedEdges: number
    missingEdges: number
    expandedEdges: number
    errors: number
    warnings: number
  }
  hashes: { diagrams: Array<{ name: string; hash: string }> }
  warnings: string[]
  nextSteps: string[]
}

/** Reachability in one diagram, ignoring edge direction? No: a dependency path is directed. */
function reaches(graph: StructureGraph, from: string, to: string): boolean {
  const adjacency = new Map<string, string[]>()
  for (const node of graph.nodes) adjacency.set(node.id, [])
  for (const edge of graph.edges) adjacency.get(edge.from)?.push(edge.to)
  const seen = new Set<string>([from])
  const queue: string[] = [from]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const next of adjacency.get(current) ?? []) {
      if (next === to) return true
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return false
}

/** The parent relation must be a forest: report the first cycle it contains, if any. */
function parentCycle(diagrams: GranularityDiagram[]): string[] | undefined {
  const byName = new Map(diagrams.map((entry) => [entry.name, entry]))
  for (const start of diagrams) {
    const path: string[] = [start.name]
    const seen = new Set<string>([start.name])
    let cursor = start.parent
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        path.push(cursor)
        return path
      }
      seen.add(cursor)
      path.push(cursor)
      cursor = byName.get(cursor)?.parent
    }
  }
  return undefined
}

/**
 * Review a set of structure diagrams with declared parent relations. Per-diagram
 * structural checks run first; the cross-diagram refinement checks follow.
 */
export function reviewGranularity(options: GranularityOptions): GranularityReport {
  const diagrams = options.diagrams
  const findings: Finding[] = []
  const warnings: string[] = []
  const diagramSummaries: GranularityDiagramSummary[] = []
  const graphs = new Map<string, StructureGraph>()

  if (diagrams.length === 0) {
    findings.push({ code: 'UML031_NO_DIAGRAMS', severity: 'error', message: 'no diagram was supplied, so there are no granularity levels to compare.' })
  }

  const cycle = parentCycle(diagrams)
  if (cycle !== undefined) {
    findings.push({
      code: 'UML030_PARENT_CYCLE',
      severity: 'error',
      message: 'the declared parent relation has a cycle: ' + cycle.join(' → ') + '. A refinement hierarchy must be a forest, or "which level owns this dependency" has no answer.',
      evidence: { cycle },
    })
  }

  const knownNames = new Set(diagrams.map((entry) => entry.name))
  for (const entry of diagrams) {
    if (entry.parent !== undefined && !knownNames.has(entry.parent)) {
      findings.push({
        code: 'UML028_UNKNOWN_PARENT',
        severity: 'error',
        message: 'diagram "' + entry.name + '" declares parent "' + entry.parent + '", which is not part of this set.',
        file: entry.name,
        evidence: { diagram: entry.name, parent: entry.parent, known: [...knownNames].sort() },
      })
    }
    const report = reviewStructure({
      diagram: entry.diagram,
      notation: options.notation ?? 'auto',
      ...(options.matrix === undefined ? {} : { matrix: options.matrix }),
    })
    graphs.set(entry.name, report.graph)
    // Tag every finding with the diagram it came from: with several diagrams in one
    // report, an untagged finding is unactionable.
    for (const finding of report.findings) {
      findings.push({ ...finding, file: entry.name, ...(finding.evidence === undefined ? {} : {}) })
    }
    warnings.push(...report.warnings.map((warning) => entry.name + ': ' + warning))
    diagramSummaries.push({
      name: entry.name,
      ...(entry.parent === undefined ? {} : { parent: entry.parent }),
      notation: report.notation,
      nodes: report.summary.nodes,
      edges: report.summary.edges,
      verdict: report.verdict,
      findings: report.findings.length,
    })
  }

  const pairs: GranularityPairSummary[] = []
  for (const child of diagrams) {
    if (child.parent === undefined) continue
    const parent = diagrams.find((entry) => entry.name === child.parent)
    const parentGraph = graphs.get(child.parent)
    const childGraph = graphs.get(child.name)
    if (parent === undefined || parentGraph === undefined || childGraph === undefined) continue
    const parentNodes = new Set(parentGraph.nodes.map((node) => node.id))
    const childNodes = new Set(childGraph.nodes.map((node) => node.id))
    const parentEdges = new Set(parentGraph.edges.map((edge) => edge.from + '\u0000' + edge.to))
    const childEdges = new Set(childGraph.edges.map((edge) => edge.from + '\u0000' + edge.to))

    let inheritedEdges = 0
    let newEdges = 0
    const inventedEdges: GranularityEdgeRef[] = []
    for (const edge of childGraph.edges) {
      const hasFrom = parentNodes.has(edge.from)
      const hasTo = parentNodes.has(edge.to)
      if (!hasFrom || !hasTo) { newEdges += 1; continue }
      if (parentEdges.has(edge.from + '\u0000' + edge.to)) { inheritedEdges += 1; continue }
      inventedEdges.push({ from: edge.from, to: edge.to, line: edge.line })
    }

    const expandedEdges: GranularityEdgeRef[] = []
    const missingEdges: GranularityEdgeRef[] = []
    for (const edge of parentGraph.edges) {
      const key = edge.from + '\u0000' + edge.to
      if (childEdges.has(key)) continue
      // The child only has to answer for a parent edge whose ends it also carries; a child
      // may legitimately cover a subtree of the parent.
      if (!childNodes.has(edge.from) || !childNodes.has(edge.to)) continue
      if (reaches(childGraph, edge.from, edge.to)) expandedEdges.push({ from: edge.from, to: edge.to, line: edge.line })
      else missingEdges.push({ from: edge.from, to: edge.to, line: edge.line })
    }

    if (inventedEdges.length > 0) {
      findings.push({
        code: 'UML029_REFINEMENT_VIOLATION',
        severity: 'error',
        message: 'diagram "' + child.name + '" draws ' + String(inventedEdges.length) + ' dependency(ies) between nodes its parent "' + parent.name + '" also has, but the parent does not: ' + inventedEdges.map((edge) => edge.from + ' → ' + edge.to).join(', ') + '. A refinement may add detail below the parent level, never a dependency at the parent level.',
        file: child.name,
        evidence: { kind: 'invented-edge', parent: parent.name, edges: inventedEdges },
      })
    }
    if (missingEdges.length > 0) {
      findings.push({
        code: 'UML029_REFINEMENT_VIOLATION',
        severity: 'error',
        message: 'diagram "' + child.name + '" drops ' + String(missingEdges.length) + ' dependency(ies) its parent "' + parent.name + '" draws, without expanding them into a path: ' + missingEdges.map((edge) => edge.from + ' → ' + edge.to).join(', ') + '.',
        file: child.name,
        evidence: { kind: 'unexpanded-edge', parent: parent.name, edges: missingEdges },
      })
    }
    pairs.push({
      parent: parent.name,
      child: child.name,
      parentNodes: parentNodes.size,
      childNodes: childNodes.size,
      parentEdges: parentGraph.edges.length,
      childEdges: childGraph.edges.length,
      inheritedEdges,
      newEdges,
      expandedEdges,
      missingEdges,
      inventedEdges,
    })
  }

  const errors = findings.filter((finding) => finding.severity === 'error').length
  const warningCount = findings.filter((finding) => finding.severity === 'warning').length
  const invented = pairs.reduce((sum, pair) => sum + pair.inventedEdges.length, 0)
  const missing = pairs.reduce((sum, pair) => sum + pair.missingEdges.length, 0)
  const expanded = pairs.reduce((sum, pair) => sum + pair.expandedEdges.length, 0)

  const nextSteps: string[] = []
  if (errors > 0) nextSteps.push('Fix the refinement violations first: a level that invents or drops a parent-level dependency makes the hierarchy unusable as a rule source.')
  if (pairs.length === 0 && diagrams.length > 0) nextSteps.push('Give the levels a `parent` so the refinement can be checked; a set of unrelated diagrams has no consistency property to verify.')
  if (expanded > 0) nextSteps.push(String(expanded) + ' parent edge(s) are drawn as a path in the child — that is a legitimate expansion, and it is listed per pair so a reviewer can confirm each one.')
  nextSteps.push('Reconcile the levels with the source-side scan: the diagram pair is consistent or not, and neither says anything about the code until it is scanned.')

  return {
    ok: true,
    ran: true,
    ...verdictOfFindings(findings),
    schema: REPORT_SCHEMAS.granularity,
    diagrams: diagramSummaries,
    pairs,
    findings,
    summary: {
      diagrams: diagrams.length,
      roots: diagrams.filter((entry) => entry.parent === undefined).length,
      pairs: pairs.length,
      nodes: diagrams.reduce((sum, entry) => sum + (graphs.get(entry.name)?.nodes.length ?? 0), 0),
      edges: diagrams.reduce((sum, entry) => sum + (graphs.get(entry.name)?.edges.length ?? 0), 0),
      inventedEdges: invented,
      missingEdges: missing,
      expandedEdges: expanded,
      errors,
      warnings: warningCount,
    },
    hashes: { diagrams: diagrams.map((entry) => ({ name: entry.name, hash: createHash('sha256').update(entry.diagram).digest('hex') })) },
    warnings,
    nextSteps,
  }
}

/** Deterministic JSON of a granularity report's pair table, for a stable summary line. */
export function granularityDigest(pairs: GranularityPairSummary[]): string {
  return canonicalJson(pairs)
}

export type { VerdictSummary }
