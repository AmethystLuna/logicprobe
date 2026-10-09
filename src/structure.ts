/**
 * Structure-diagram review: a dependency graph is not a state machine.
 *
 * The state-machine front end (`uml.ts`) reads a component, package, class or
 * deployment diagram as a *by-product* and says so (`UML_NOT_A_STATE_DIAGRAM`).
 * This module reads the same text as what it actually is — a directed graph of
 * nodes and dependency edges — and audits it against a declared dependency matrix.
 *
 * The checks are the structural ones a reader performs by eye and gets wrong:
 * an isolated node nobody notices, an arrow whose endpoint was never declared, a
 * dependency cycle, an edge that violates the allowed-dependency matrix, a child
 * depending on its parent, and an edge the matrix says must exist but the diagram
 * does not draw. Every finding names the rule id it hit, so the diagram and the
 * source-side checker can be reconciled rule by rule.
 *
 * @module logicprobe-structure
 */

import { verdictOfFindings, type Finding, type Verdict, type VerdictSummary } from './engine.js'

export type StructureNotation = 'plantuml' | 'mermaid'

/** What a node declares itself to be. Containers hold other nodes; they are not dependencies. */
export type StructureNodeKind = 'component' | 'class' | 'interface' | 'actor' | 'database' | 'node' | 'package' | 'rectangle' | 'cloud' | 'queue' | 'unknown'

export interface StructureNode {
  id: string
  /** Display label when the declaration carried one (`component "Order Service" as SVC`). */
  label?: string
  kind: StructureNodeKind
  /** True when the node is a container (package/rectangle/frame): it owns members and carries no dependency of its own. */
  container: boolean
  /** 1-based line of the declaration. Absent when the node was only ever named by an edge. */
  line?: number
  declared: boolean
  /** Container id this node was declared inside, if any. */
  parent?: string
}

export interface StructureEdge {
  from: string
  to: string
  /** Arrow label, e.g. `read` in `PAY --> DRV : read`. */
  label?: string
  line: number
}

export interface StructureGraph {
  notation: StructureNotation
  nodes: StructureNode[]
  edges: StructureEdge[]
  warnings: string[]
}

/** One dependency rule from the matrix document. */
export interface StructureRule {
  id: string
  /** Node id or glob the rule applies to; absent = applies to every source. */
  source?: string
  /** Permitted targets (glob or node id). Winning an allow match permits the edge. */
  allow?: string[]
  /** Forbidden targets. Deny always wins over allow. */
  deny?: string[]
  /** When true, at least one edge matching source→targets must exist (UML025). */
  require?: boolean
}

export interface StructureLayer {
  name: string
  /** Node ids or globs that belong to this layer. */
  members: string[]
}

/**
 * The dependency matrix: the single source of truth a diagram is checked against.
 * `default` decides the fate of an edge no rule mentions (`allow` = only explicit
 * rules judge, `deny` = anything unlisted is a violation).
 */
export interface DependencyMatrix {
  rules?: StructureRule[]
  layers?: StructureLayer[]
  default?: 'allow' | 'deny'
}

export interface StructureEdgeVerdict {
  from: string
  to: string
  line: number
  /** Rule ids whose `source` matched this edge, whether they allowed or denied it. */
  matchedRules: string[]
  allowed: boolean
  /** `allow` (a rule permitted it), `default` (nothing judged it), `deny` (a rule forbade it), `unlisted` (default=deny and no rule matched). */
  basis: 'allow' | 'default' | 'deny' | 'unlisted'
}

export interface StructureSummary {
  nodes: number
  edges: number
  containers: number
  isolated: number
  dangling: number
  cycles: number
  disallowedEdges: number
  layerViolations: number
  missingExpectedEdges: number
  errors: number
  warnings: number
  rules: number
}

export interface StructureReport {
  /** The tool ran and produced this report; read `verdict` for the outcome. */
  ok: boolean
  ran: boolean
  verdict: Verdict
  verdictReason: string
  notation: StructureNotation
  graph: StructureGraph
  /** Per-edge matrix verdict, present only when a matrix was supplied. */
  edgeVerdicts?: StructureEdgeVerdict[]
  findings: Finding[]
  summary: StructureSummary
  warnings: string[]
  nextSteps: string[]
}

/** A finding code in the structure family; the numbers continue the UML0xx series after UML019. */
export type StructureFindingCode =
  | 'UML020_ISOLATED_NODE'
  | 'UML021_DANGLING_REFERENCE'
  | 'UML022_CYCLE'
  | 'UML023_DISALLOWED_EDGE'
  | 'UML024_LAYER_VIOLATION'
  | 'UML025_MISSING_EXPECTED_EDGE'
  | 'UML026_NO_NODES'

const CONSTRUCT_KIND: Record<string, StructureNodeKind> = {
  component: 'component',
  class: 'class',
  interface: 'interface',
  abstract: 'class',
  enum: 'class',
  object: 'component',
  actor: 'actor',
  usecase: 'component',
  database: 'database',
  node: 'node',
  artifact: 'node',
  deployment: 'node',
  rectangle: 'rectangle',
  folder: 'package',
  frame: 'rectangle',
  cloud: 'cloud',
  queue: 'queue',
  stack: 'queue',
  storage: 'database',
  collections: 'queue',
  agent: 'component',
  boundary: 'component',
  control: 'component',
  entity: 'component',
  package: 'package',
  namespace: 'package',
  module: 'package',
  componentDiagram: 'component',
}

const CONTAINER_KINDS = new Set<StructureNodeKind>(['package'])

/** Constructs that declare a node in a PlantUML structure diagram. */
const DECLARATION = /^\s*(component|componentDiagram|class|abstract|interface|enum|object|actor|usecase|database|node|artifact|deployment|rectangle|folder|frame|cloud|queue|stack|storage|collections|agent|boundary|control|entity|package|namespace|module)\b\s*(.*)$/i

/** PlantUML arrow forms used between structure nodes. */
const PLANTUML_EDGE = /^\s*(.+?)\s*(-->|->|\.\.>|--|==>|<--|<\.\.)\s*(.+?)\s*$/

/** Mermaid class-diagram edge forms: `A --> B : label`, `A ..|> B`, `A -- B`. */
const MERMAID_CLASS_EDGE = /^\s*(.+?)\s*(-->|\.\.>|--\|>|\.\.\|>|--|\.\.)\s*(.+?)\s*$/

const MERMAID_CLASS_DECLARATION = /^\s*class\s+([A-Za-z_][A-Za-z0-9_.-]*)\s*(?:\["([^"]*)"\])?\s*$/
const MERMAID_CLASS_MEMBER = /^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*(?::|\{)/

/**
 * Parse a structure diagram (PlantUML component/package/class/deployment, Mermaid
 * class diagram) into nodes and dependency edges.
 *
 * A structure diagram is *not* refused here: refusing is the state-machine front
 * end's job (`parseUml`). This parser is the honest reading of the same text.
 */
export function parseStructure(text: string, notation: 'auto' | StructureNotation = 'auto'): StructureGraph {
  const resolved = notation === 'auto' ? detectStructureNotation(text) : notation
  return resolved === 'mermaid' ? parseMermaidClass(text) : parsePlantUmlStructure(text)
}

function detectStructureNotation(text: string): StructureNotation {
  if (/^\s*@start/m.test(text)) return 'plantuml'
  if (/^\s*classDiagram\b/m.test(text)) return 'mermaid'
  if (/^\s*(component|package|deployment)\b/im.test(text)) return 'plantuml'
  return 'plantuml'
}

/** Read `X as Y`, `"X" as Y`, `[X] as Y`, `X` → the node id (and its display label). */
function readDeclarationTarget(rest: string): { id?: string; label?: string } {
  const trimmed = rest.trim().replace(/[;{]\s*$/, '').trim()
  if (trimmed === '') return {}
  const aliased = /^(.*?)\s+as\s+([A-Za-z_][A-Za-z0-9_.-]*)\s*$/.exec(trimmed)
  if (aliased !== null) return { id: aliased[2], label: cleanLabel(aliased[1]) }
  const bare = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*$/.exec(trimmed)
  if (bare !== null) return { id: bare[1] }
  const quoted = /^"([^"]+)"\s*$/.exec(trimmed)
  if (quoted !== null) return { id: quoted[1], label: quoted[1] }
  // `[Order Service]` and other bracketed spellings become their own id when nothing
  // else is available: an unnamed node still has to appear in the graph.
  const bracketed = /^\[([^\]]+)\]\s*$/.exec(trimmed)
  if (bracketed !== null) return { id: bracketed[1].trim(), label: bracketed[1].trim() }
  return { label: cleanLabel(trimmed) }
}

function cleanLabel(value: string): string | undefined {
  const trimmed = value.trim().replace(/^\[|\]$/g, '').replace(/^"|"$/g, '').trim()
  return trimmed === '' ? undefined : trimmed
}

/** Strip a trailing `: label` from an edge target and return both halves. */
function splitEdgeTarget(text: string): { id: string; label?: string } {
  const colon = text.indexOf(':')
  if (colon < 0) return { id: text.trim() }
  return { id: text.slice(0, colon).trim(), label: text.slice(colon + 1).trim() }
}

function nodeIdFromReference(reference: string): string {
  const trimmed = reference.trim()
  const quoted = /^"([^"]+)"$/.exec(trimmed)
  if (quoted !== null) return quoted[1]
  const bracketed = /^\[([^\]]+)\]$/.exec(trimmed)
  if (bracketed !== null) return bracketed[1].trim()
  return trimmed.replace(/^"|"$/g, '')
}

interface GraphBuilder {
  nodes: Map<string, StructureNode>
  edges: StructureEdge[]
  warnings: string[]
  stack: string[]
}

function declareNode(builder: GraphBuilder, id: string, kind: StructureNodeKind, line: number, label?: string): void {
  const existing = builder.nodes.get(id)
  const container = CONTAINER_KINDS.has(kind)
  if (existing === undefined) {
    builder.nodes.set(id, {
      id,
      kind,
      container,
      line,
      declared: true,
      ...(label === undefined ? {} : { label }),
      ...(builder.stack.length === 0 ? {} : { parent: builder.stack[builder.stack.length - 1] }),
    })
    return
  }
  // A second declaration upgrades an implicitly-created node and keeps the first line.
  existing.declared = true
  existing.kind = kind
  existing.container = container
  if (label !== undefined && existing.label === undefined) existing.label = label
  if (existing.line === undefined) existing.line = line
}

/** A node that only an edge mentioned: kept, and reported as dangling (UML021). */
function referenceNode(builder: GraphBuilder, id: string, line: number): void {
  if (builder.nodes.has(id)) return
  builder.nodes.set(id, {
    id,
    kind: 'unknown',
    container: false,
    line,
    declared: false,
    ...(builder.stack.length === 0 ? {} : { parent: builder.stack[builder.stack.length - 1] }),
  })
}

function parsePlantUmlStructure(text: string): StructureGraph {
  const builder: GraphBuilder = { nodes: new Map(), edges: [], warnings: [], stack: [] }
  const lines = text.split(/\r?\n/)
  let inNote = false
  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1
    const line = rawLine.trim()
    if (line === '') return
    if (/^@start|^@end/.test(line)) return
    if (/^'/i.test(line) || /^\/\//.test(line)) return
    const noteStart = /^note\b/i.test(line)
    const noteEnd = /^end\s*note$/i.test(line)
    if (noteEnd) { inNote = false; return }
    if (inNote) return
    if (noteStart && !/:\s*.+$/.test(line)) { inNote = true; return }
    if (noteStart) return
    if (/^skinparam\b|^scale\b|^title\b|^hide\b|^left to right direction|^top to bottom direction|^!theme|^legend\b|^end legend$/i.test(line)) return
    if (/^\/'/.test(line) || /^'/i.test(line)) return
    if (line === '}') { builder.stack.pop(); return }
    const declaration = DECLARATION.exec(line)
    if (declaration !== null) {
      const kind = CONSTRUCT_KIND[declaration[1].toLowerCase()] ?? 'unknown'
      const target = readDeclarationTarget(declaration[2])
      const id = target.id ?? declaration[2].trim()
      if (id !== '') {
        declareNode(builder, id, kind, lineNumber, target.label)
        if (line.endsWith('{')) builder.stack.push(id)
      }
      return
    }
    const edge = PLANTUML_EDGE.exec(line)
    if (edge !== null) {
      const from = nodeIdFromReference(edge[1])
      const target = splitEdgeTarget(edge[3])
      const to = nodeIdFromReference(target.id)
      if (from === '' || to === '') return
      referenceNode(builder, from, lineNumber)
      referenceNode(builder, to, lineNumber)
      builder.edges.push({ from, to, line: lineNumber, ...(target.label === undefined ? {} : { label: target.label }) })
      return
    }
    builder.warnings.push('STRUCTURE_IGNORED_LINE: "' + line + '" is not a component, package, class or edge statement; it was ignored.')
  })
  return { notation: 'plantuml', nodes: [...builder.nodes.values()], edges: builder.edges, warnings: builder.warnings }
}

function parseMermaidClass(text: string): StructureGraph {
  const builder: GraphBuilder = { nodes: new Map(), edges: [], warnings: [], stack: [] }
  const lines = text.split(/\r?\n/)
  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1
    const line = rawLine.trim()
    if (line === '' || /^classDiagram\b/.test(line) || /^%%/.test(line)) continue
    if (line === '}') { builder.stack.pop(); continue }
    const declaration = MERMAID_CLASS_DECLARATION.exec(line)
    if (declaration !== null) {
      declareNode(builder, declaration[1], 'class', lineNumber, declaration[2])
      continue
    }
    // `class OrderService { ... }` opens a member block; members are not dependency nodes.
    const block = /^class\s+([A-Za-z_][A-Za-z0-9_.-]*)\s*\{$/.exec(line)
    if (block !== null) {
      declareNode(builder, block[1], 'class', lineNumber)
      builder.stack.push(block[1])
      continue
    }
    const edge = MERMAID_CLASS_EDGE.exec(line)
    if (edge !== null) {
      const from = nodeIdFromReference(edge[1])
      const target = splitEdgeTarget(edge[3])
      const to = nodeIdFromReference(target.id)
      if (from === '' || to === '') continue
      referenceNode(builder, from, lineNumber)
      referenceNode(builder, to, lineNumber)
      builder.edges.push({ from, to, line: lineNumber, ...(target.label === undefined ? {} : { label: target.label }) })
      continue
    }
    if (builder.stack.length > 0) continue // a member line inside `class X { ... }`
    if (MERMAID_CLASS_MEMBER.test(line)) {
      // `Service : +read()` declares a node with a member description.
      const id = MERMAID_CLASS_MEMBER.exec(line)![1]
      declareNode(builder, id, 'class', lineNumber)
      continue
    }
    builder.warnings.push('STRUCTURE_IGNORED_LINE: "' + line + '" is not a class or edge statement; it was ignored.')
  }
  return { notation: 'mermaid', nodes: [...builder.nodes.values()], edges: builder.edges, warnings: builder.warnings }
}

// ---------------------------------------------------------------------------
// Dependency matrix
// ---------------------------------------------------------------------------

/** `*` matches any run of characters, `?` exactly one. Ids keep their own punctuation. */
export function globMatches(pattern: string, value: string): boolean {
  if (pattern === value) return true
  if (!pattern.includes('*') && !pattern.includes('?')) return false
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp('^' + escaped + '$').test(value)
}

function matchesAny(patterns: string[] | undefined, value: string): string | undefined {
  if (patterns === undefined) return undefined
  return patterns.find((pattern) => globMatches(pattern, value))
}

export function validateMatrix(input: unknown): { ok: true; matrix: DependencyMatrix } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['matrix: must be an object'] }
  }
  const root = input as Record<string, unknown>
  const allowed = new Set(['rules', 'layers', 'default'])
  for (const key of Object.keys(root)) {
    if (!allowed.has(key)) errors.push('matrix.' + key + ': unknown field (allowed: rules, layers, default)')
  }
  if (root.default !== undefined && root.default !== 'allow' && root.default !== 'deny') {
    errors.push("matrix.default: must be 'allow' or 'deny'")
  }
  if (root.rules !== undefined) {
    if (!Array.isArray(root.rules)) errors.push('matrix.rules: must be an array')
    else {
      const seen = new Set<string>()
      root.rules.forEach((entry, index) => {
        const path = 'matrix.rules[' + String(index) + ']'
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) { errors.push(path + ': must be an object'); return }
        const rule = entry as Record<string, unknown>
        for (const key of Object.keys(rule)) {
          if (!['id', 'source', 'allow', 'deny', 'require'].includes(key)) errors.push(path + '.' + key + ': unknown field (allowed: id, source, allow, deny, require)')
        }
        if (typeof rule.id !== 'string' || rule.id === '') errors.push(path + '.id: must be a non-empty string')
        else if (seen.has(rule.id)) errors.push(path + '.id: duplicate rule id ' + rule.id)
        else seen.add(rule.id)
        if (rule.source !== undefined && typeof rule.source !== 'string') errors.push(path + '.source: must be a string')
        for (const list of ['allow', 'deny'] as const) {
          if (rule[list] === undefined) continue
          if (!Array.isArray(rule[list]) || (rule[list] as unknown[]).length === 0) errors.push(path + '.' + list + ': must be a non-empty array')
          else if ((rule[list] as unknown[]).some((value) => typeof value !== 'string' || value === '')) errors.push(path + '.' + list + ': every entry must be a non-empty string')
        }
        if (rule.require !== undefined && typeof rule.require !== 'boolean') errors.push(path + '.require: must be a boolean')
        if (rule.require === true && rule.allow === undefined) errors.push(path + '.require: needs `allow` to say which edges must exist')
      })
    }
  }
  if (root.layers !== undefined) {
    if (!Array.isArray(root.layers)) errors.push('matrix.layers: must be an array')
    else {
      root.layers.forEach((entry, index) => {
        const path = 'matrix.layers[' + String(index) + ']'
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) { errors.push(path + ': must be an object'); return }
        const layer = entry as Record<string, unknown>
        for (const key of Object.keys(layer)) {
          if (!['name', 'members'].includes(key)) errors.push(path + '.' + key + ': unknown field (allowed: name, members)')
        }
        if (typeof layer.name !== 'string' || layer.name === '') errors.push(path + '.name: must be a non-empty string')
        if (!Array.isArray(layer.members) || layer.members.length === 0) errors.push(path + '.members: must be a non-empty array')
        else if ((layer.members as unknown[]).some((value) => typeof value !== 'string' || value === '')) errors.push(path + '.members: every entry must be a non-empty string')
      })
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, matrix: root as DependencyMatrix }
}

/** The layer index of a node id, or undefined when no layer claims it. */
function layerOf(layers: StructureLayer[], id: string): number | undefined {
  for (const [index, layer] of layers.entries()) {
    if (matchesAny(layer.members, id) !== undefined) return index
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** Shortest directed cycle through the graph, as a node path with the start repeated. */
export function shortestCycle(nodes: string[], edges: StructureEdge[]): string[] | undefined {
  const adjacency = new Map<string, string[]>()
  for (const node of nodes) adjacency.set(node, [])
  for (const edge of edges) {
    if (edge.from === edge.to) return [edge.from, edge.from]
    const list = adjacency.get(edge.from)
    if (list !== undefined && !list.includes(edge.to)) list.push(edge.to)
  }
  let best: string[] | undefined
  for (const start of nodes) {
    // BFS from `start` back to `start`; the first hit is the shortest cycle through it.
    const previous = new Map<string, string>()
    const queue: string[] = [start]
    const seen = new Set<string>([start])
    let found = false
    while (queue.length > 0 && !found) {
      const current = queue.shift() as string
      for (const next of adjacency.get(current) ?? []) {
        if (next === start) {
          // `previous` holds back-pointers from `start`, so walk them to `current`,
          // reverse into forward order, then close the loop.
          const chain: string[] = []
          let cursor = current
          while (cursor !== start) { chain.push(cursor); cursor = previous.get(cursor) as string }
          const path = [start, ...chain.reverse(), start]
          if (best === undefined || path.length < best.length) best = path
          found = true
          break
        }
        if (seen.has(next)) continue
        seen.add(next)
        previous.set(next, current)
        queue.push(next)
      }
    }
  }
  return best
}

export interface StructureReviewOptions {
  /** Diagram text to review. */
  diagram: string
  notation?: 'auto' | StructureNotation
  /** Dependency matrix: allowed/denied edges, layers, required edges. */
  matrix?: unknown
}

/**
 * Audit a structure diagram. Every check is structural: it reads the drawn graph and
 * the declared matrix, and never claims anything about the code behind them.
 */
export function reviewStructure(options: StructureReviewOptions): StructureReport {
  const graph = parseStructure(options.diagram, options.notation ?? 'auto')
  const warnings = [...graph.warnings]
  const findings: Finding[] = []
  const nodes = graph.nodes
  const nodeIds = nodes.map((node) => node.id)
  const byId = new Map(nodes.map((node) => [node.id, node]))

  if (nodes.length === 0) {
    findings.push({
      code: 'UML026_NO_NODES',
      severity: 'error',
      message: 'no node was declared in this text, so there is no structure to review.',
      evidence: { notation: graph.notation },
    })
  }

  // -- UML021 dangling references: an endpoint no declaration ever introduced -----
  const dangling = nodes.filter((node) => !node.declared)
  if (dangling.length > 0) {
    findings.push({
      code: 'UML021_DANGLING_REFERENCE',
      severity: 'error',
      message: String(dangling.length) + ' arrow endpoint(s) are used without ever being declared: ' + dangling.map((node) => node.id).join(', ') + '. In a component diagram this is how a dependency on a component that does not exist stays invisible.',
      evidence: { nodes: dangling.map((node) => ({ id: node.id, line: node.line })) },
    })
  }

  // -- UML020 isolated nodes: declared, but nothing depends on it and it depends on nothing --
  const degree = new Map<string, number>()
  for (const id of nodeIds) degree.set(id, 0)
  for (const edge of graph.edges) {
    // A container's members are not its dependencies, so only real edges count.
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1)
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1)
  }
  const isolated = nodes.filter((node) => !node.container && node.declared && (degree.get(node.id) ?? 0) === 0)
  if (isolated.length > 0) {
    findings.push({
      code: 'UML020_ISOLATED_NODE',
      severity: 'warning',
      message: String(isolated.length) + ' node(s) have no edge at all: ' + isolated.map((node) => node.id).join(', ') + '. Either they are dead entries or the diagram is missing their dependencies.',
      evidence: { nodes: isolated.map((node) => ({ id: node.id, line: node.line })) },
    })
  }

  // -- UML022 cycles --------------------------------------------------------------
  const cycle = shortestCycle(nodeIds, graph.edges)
  if (cycle !== undefined) {
    findings.push({
      code: 'UML022_CYCLE',
      severity: 'error',
      message: 'the dependency graph has a directed cycle: ' + cycle.join(' → ') + '. A cycle means no build order and no layering can hold.',
      path: cycle.slice(0, -1).map((from, index) => ({ from, event: 'depends-on', to: cycle[index + 1] })),
      evidence: { cycle },
    })
  }

  // -- Matrix checks: UML023 disallowed edge, UML024 layer violation, UML025 missing edge --
  const edgeVerdicts: StructureEdgeVerdict[] = []
  let rules: StructureRule[] = []
  let layers: StructureLayer[] = []
  let matrixDefault: 'allow' | 'deny' = 'allow'
  if (options.matrix !== undefined) {
    const validation = validateMatrix(options.matrix)
    if (!validation.ok) {
      const matrixFindings: Finding[] = validation.errors.map((message) => ({ code: 'MATRIX_INVALID', severity: 'error', message }))
      findings.push(...matrixFindings)
    } else {
      rules = validation.matrix.rules ?? []
      layers = validation.matrix.layers ?? []
      matrixDefault = validation.matrix.default ?? 'allow'
    }
  }

  for (const edge of graph.edges) {
    const matchedRules: string[] = []
    let deniedBy: StructureRule | undefined
    let allowedBy: StructureRule | undefined
    for (const rule of rules) {
      if (rule.source === undefined) continue
      if (matchesAny([rule.source], edge.from) === undefined) continue
      matchedRules.push(rule.id)
      if (matchesAny(rule.deny, edge.to) !== undefined && deniedBy === undefined) deniedBy = rule
      if (matchesAny(rule.allow, edge.to) !== undefined && allowedBy === undefined) allowedBy = rule
    }
    // Deny wins globally: a later rule's allow must not resurrect an edge an earlier
    // rule forbade, or the matrix would depend on rule order.
    let allowed: boolean
    let basis: StructureEdgeVerdict['basis']
    if (deniedBy !== undefined) { allowed = false; basis = 'deny' }
    else if (allowedBy !== undefined) { allowed = true; basis = 'allow' }
    else if (matrixDefault === 'deny') { allowed = false; basis = 'unlisted' }
    else { allowed = true; basis = 'default' }
    edgeVerdicts.push({ from: edge.from, to: edge.to, line: edge.line, matchedRules, allowed, basis })
    if (!allowed) {
      const rule = deniedBy
      findings.push({
        code: 'UML023_DISALLOWED_EDGE',
        severity: 'error',
        message: rule === undefined
          ? 'edge ' + edge.from + ' → ' + edge.to + ' is not permitted: no rule allows it and the matrix default is deny.'
          : 'edge ' + edge.from + ' → ' + edge.to + ' violates rule ' + rule.id + (rule.deny === undefined ? '' : ' (deny ' + rule.deny.join(', ') + ')') + '.',
        // `rule` is omitted rather than set to undefined: a tool result must stay lossless JSON.
        evidence: { edge: { from: edge.from, to: edge.to, line: edge.line }, matchedRules, basis, ...(rule === undefined ? {} : { rule: rule.id }) },
      })
    }
  }

  // UML024: an edge from a lower layer into a higher one (a child depending on its parent).
  const layerViolations: Array<{ from: string; to: string; fromLayer: string; toLayer: string; line: number }> = []
  if (layers.length > 0) {
    for (const edge of graph.edges) {
      const fromLayer = layerOf(layers, edge.from)
      const toLayer = layerOf(layers, edge.to)
      if (fromLayer === undefined || toLayer === undefined) continue
      if (fromLayer > toLayer) {
        layerViolations.push({ from: edge.from, to: edge.to, fromLayer: layers[fromLayer].name, toLayer: layers[toLayer].name, line: edge.line })
      }
    }
    if (layerViolations.length > 0) {
      findings.push({
        code: 'UML024_LAYER_VIOLATION',
        severity: 'error',
        message: String(layerViolations.length) + ' edge(s) point from a lower layer into a higher one: ' + layerViolations.map((entry) => entry.from + ' (' + entry.fromLayer + ') → ' + entry.to + ' (' + entry.toLayer + ')').join('; ') + '. Declared layers allow downward dependencies only.',
        evidence: { violations: layerViolations },
      })
    }
  }

  // UML025: an edge the matrix requires but the diagram does not draw. The check is
  // pattern-based on purpose: a required target that the diagram does not contain at
  // all is the strongest form of "missing", and deriving the expectation from declared
  // nodes would hide exactly that case.
  const missing: Array<{ rule: string; source: string; expected: string[]; unsatisfiedFrom: string[]; noSourceMatch: boolean }> = []
  for (const rule of rules) {
    if (rule.require !== true || rule.source === undefined || rule.allow === undefined) continue
    const sources = nodeIds.filter((id) => matchesAny([rule.source as string], id) !== undefined)
    if (sources.length === 0) {
      missing.push({ rule: rule.id, source: rule.source, expected: rule.allow, unsatisfiedFrom: [], noSourceMatch: true })
      continue
    }
    const unsatisfied = sources.filter((source) => !graph.edges.some((edge) => edge.from === source && matchesAny(rule.allow, edge.to) !== undefined))
    if (unsatisfied.length > 0) missing.push({ rule: rule.id, source: rule.source, expected: rule.allow, unsatisfiedFrom: unsatisfied, noSourceMatch: false })
  }
  if (missing.length > 0) {
    findings.push({
      code: 'UML025_MISSING_EXPECTED_EDGE',
      severity: 'warning',
      message: String(missing.length) + ' required edge(s) are absent from the diagram: ' + missing.map((entry) => entry.noSourceMatch
        ? entry.rule + ' requires an edge from ' + entry.source + ' to ' + entry.expected.join(', ') + ', but no node matches ' + entry.source
        : entry.rule + ' requires an edge from ' + entry.unsatisfiedFrom.join(', ') + ' to ' + entry.expected.join(', ') + ', and the diagram draws none').join('; ') + '. The matrix and the diagram disagree.',
      evidence: { missing },
    })
  }

  const errors = findings.filter((finding) => finding.severity === 'error').length
  const warningCount = findings.filter((finding) => finding.severity === 'warning').length
  const summary: StructureSummary = {
    nodes: nodes.length,
    edges: graph.edges.length,
    containers: nodes.filter((node) => node.container).length,
    isolated: isolated.length,
    dangling: dangling.length,
    cycles: cycle === undefined ? 0 : 1,
    disallowedEdges: edgeVerdicts.filter((verdict) => !verdict.allowed).length,
    layerViolations: layerViolations.length,
    missingExpectedEdges: missing.length,
    errors,
    warnings: warningCount,
    rules: rules.length,
  }

  const nextSteps: string[] = []
  if (errors > 0) nextSteps.push('Resolve the error findings first: a dangling endpoint or a layer violation means the diagram and the intended architecture disagree.')
  if (rules.length === 0) nextSteps.push('Supply a dependency matrix (rules/layers) to have every edge judged and named; without one only the structural checks run.')
  nextSteps.push('Reconcile the result with the source-side checker: this audits the diagram, an include/graph scan audits the code, and the difference between them is the finding worth chasing.')
  if (graph.notation === 'plantuml') nextSteps.push('State machines are a different question — for a state or activity diagram use logicprobe_uml action=review and logicprobe_verify.')

  return {
    ok: true,
    ran: true,
    ...verdictOfFindings(findings),
    notation: graph.notation,
    graph,
    ...(options.matrix === undefined ? {} : { edgeVerdicts }),
    findings,
    summary,
    warnings,
    nextSteps,
  }
}

/** The finding codes this module can emit, for documentation and tests. */
export const STRUCTURE_FINDING_CODES: readonly StructureFindingCode[] = [
  'UML020_ISOLATED_NODE',
  'UML021_DANGLING_REFERENCE',
  'UML022_CYCLE',
  'UML023_DISALLOWED_EDGE',
  'UML024_LAYER_VIOLATION',
  'UML025_MISSING_EXPECTED_EDGE',
  'UML026_NO_NODES',
]

export type { VerdictSummary }
