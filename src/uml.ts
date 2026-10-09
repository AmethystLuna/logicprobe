/**
 * UML front end for LogicModelV1 — model a code flow as a UML diagram, then
 * review the modelling itself.
 *
 * Two halves, one data flow:
 *
 *   1. `renderUml` turns a validated LogicModelV1 into Mermaid or PlantUML text
 *      (state machine, activity/flow, or sequence trace). The diagram is a
 *      *view*: it never invents structure the model does not have, and anything
 *      the notation cannot express is reported as a warning instead of being
 *      dropped silently.
 *   2. `parseUml` reads that text back into a LogicModelV1, and `reviewUml`
 *      compares the two. That comparison is the point of the feature: a UML
 *      diagram of a code flow is itself a model, and a model can be wrong —
 *      ambiguous branches, dead ends, flows nobody can enter, symbols the
 *      source never names. A diagram that does not round-trip to the model it
 *      was drawn from is mis-modelled, and the review says so.
 *
 * Why the round trip is the fidelity check: rendering and parsing are inverse
 * only if every construct survives the notation. The generated text carries
 * `logicprobe:` directives (ignored by Mermaid/PlantUML renderers) that pin the
 * initial state, the terminal states and any state id the notation cannot spell
 * verbatim, so an exact comparison is possible rather than a fuzzy one.
 *
 * The review deliberately does NOT replace `logicprobe_verify`: it checks the
 * modelling (structure the diagram claims, documentation coverage, notation
 * fidelity), while S1-S8/A1-A14 check the machine's behaviour (guard
 * exhaustiveness under real valuations, invariant paths, deadlock/liveness in
 * the runtime state space). Findings name the engine check to run next.
 *
 * @module logicprobe-uml
 */

import { REPORT_SCHEMAS, validateModel, modelHash, metadataKeysOf, narrativeComplete, narrativeCoverageOf, verdictOfFindings, DEFAULT_HASH_SPEC, type HashSpec, type NarrativeCoverage, type ReportSchema, type Verdict } from './engine.js'
import type { GuardNode, GuardOp, LeafGuard, LogicModelV1, StateSpec, TransitionSpec, UpdateSpec, VariableSpec } from './engine.js'

export type UmlNotation = 'mermaid' | 'plantuml'

export type UmlDiagram = 'state' | 'activity' | 'sequence'

export const UML_NOTATIONS: readonly UmlNotation[] = ['mermaid', 'plantuml']

export const UML_DIAGRAMS: readonly UmlDiagram[] = ['state', 'activity', 'sequence']

/** Marker every generated diagram carries; renderers ignore it, the parser uses it. */
const DIRECTIVE_NAMESPACE = 'logicprobe:'

/** State id / event name characters that would break the generated label syntax. */
const UNSAFE_LABEL = /[[\]/\n\r\t]/

/** Mermaid flowchart keywords that cannot stand alone as a node id. */
const RESERVED_NODE_IDS = new Set(['end', 'graph', 'subgraph', 'class', 'classDef', 'click', 'style', 'linkStyle', 'direction'])

/** Ids the notation can spell without an alias. */
const PLAIN_ID = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface UmlRenderResult {
  notation: UmlNotation
  diagram: UmlDiagram
  /** The diagram source; hand this to the user or a renderer as-is. */
  primary: string
  warnings: string[]
}

export interface UmlParseResult {
  notation: UmlNotation
  diagram: UmlDiagram
  model: LogicModelV1
  /**
   * Display labels found in the diagram, keyed by state id. They are how a
   * reader learns what a symbol means; a missing entry is an undocumented
   * symbol, which the review reports.
   */
  labels: Record<string, string>
  /**
   * Declarations found in the text that LogicModelV1 cannot represent. A non-empty
   * list means the parsed model is NOT this diagram: the text belongs to another
   * diagram family (component, package, class, deployment, …), so whatever came
   * out is a by-product of reading keywords the parser does not own.
   */
  discardedConstructs: DiscardedConstruct[]
  /**
   * Arrows whose endpoints were declared by a discarded construct. They survive
   * parsing as state transitions, which is exactly why they are counted out loud.
   */
  discardedEdges: number
  warnings: string[]
}

/** One declaration the parser could not represent, with the source line that carried it. */
export interface DiscardedConstruct {
  /** The construct keyword, lower-cased (`component`, `package`, `classDiagram`). */
  construct: string
  /** 1-based line number in the diagram source. */
  line: number
  /** The source line, trimmed. */
  text: string
}

export interface UmlFinding {
  code: string
  severity: 'error' | 'warning' | 'info'
  message: string
  states?: string[]
  events?: string[]
  transitions?: Array<{ from: string; event: string; to: string }>
  detail?: string
  /** Machine-readable context for the finding (ids, coverage, rule matches), same shape as the engine's findings. */
  evidence?: Record<string, unknown>
}

export interface UmlRoundTripReport {
  notation: UmlNotation
  diagram: UmlDiagram
  ok: boolean
  /** Which published hash specification the two hashes follow (see references/hash-spec.md). */
  hashSpec: HashSpec
  modelHash: string
  parsedHash: string
  diffs: string[]
  warnings: string[]
}

export interface UmlReviewReport {
  /** The review ran and produced this report. It does NOT mean the modelling passed — read `verdict`. */
  ok: boolean
  ran: boolean
  verdict: Verdict
  verdictReason: string
  /** The versioned report contract this result follows. */
  schema: ReportSchema
  source: 'model' | 'diagram' | 'model+diagram'
  summary: {
    errors: number
    warnings: number
    info: number
    states: number
    events: number
    transitions: number
    terminalStates: number
    reachableStates: number
    documentedStates: number
  }
  findings: UmlFinding[]
  roundTrip: UmlRoundTripReport | null
  /** Diagram display labels, when a diagram took part in the review. */
  labels?: Record<string, string>
  /** Model parsed from the diagram, when a diagram was given (feed it to `logicprobe_verify`). */
  model?: LogicModelV1
  /** Diagram rendered from the model, when only a model was given. */
  primary?: string
  /** Paths of the `_`-prefixed metadata keys found in the supplied model, when it carried any. */
  metadataKeys?: string[]
  /** How much of the model the narrative documents; absent when there is no narrative. */
  narrativeCoverage?: NarrativeCoverage
  /** Hashes of what was reviewed, in one place. */
  hashes: { hashSpec: HashSpec; modelHash?: string; parsedHash?: string }
  /** Declarations the parser could not represent; a non-empty list fails the review. */
  discardedConstructs?: DiscardedConstruct[]
  /** Arrows whose endpoints came from a discarded construct. */
  discardedEdges?: number
  warnings: string[]
  nextSteps: string[]
}

/**
 * A UML front-end refusal. `code` lets the tool report *why* it refused instead of
 * collapsing every refusal into a generic input error.
 */
export class UmlError extends Error {
  readonly code: string
  constructor(message: string, code = 'UML_INPUT') {
    super(message)
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function literalText(value: number | boolean): string {
  return typeof value === 'boolean' ? String(value) : String(value)
}

/** Canonical guard text. Rendering wraps every composite node in parentheses, and the parser flattens same-operator chains, so render∘parse is the identity. */
export function guardText(node: GuardNode): string {
  if ('variable' in node) return node.variable + ' ' + node.op + ' ' + literalText(node.value)
  if ('all' in node) return '(' + node.all.map((guard) => guardText(guard)).join(' && ') + ')'
  if ('any' in node) return '(' + node.any.map((guard) => guardText(guard)).join(' || ') + ')'
  return '!(' + guardText(node.not) + ')'
}

function updatesText(updates: UpdateSpec[]): string {
  return updates.map((update) => {
    const value = update.value ?? (update.op === 'set' ? 0 : 1)
    if (update.op === 'set') return update.variable + ' := ' + literalText(value)
    if (update.op === 'inc') return update.variable + ' := ' + update.variable + ' + ' + literalText(value)
    return update.variable + ' := ' + update.variable + ' - ' + literalText(value)
  }).join(', ')
}

function transitionText(transition: TransitionSpec): string {
  let text = transition.event
  if (transition.guard !== undefined) text += ' [' + guardText(transition.guard) + ']'
  if (transition.updates !== undefined && transition.updates.length > 0) text += ' / ' + updatesText(transition.updates)
  return text
}

function displayText(text: string): string {
  return text.replace(/[\r\n\t]+/g, ' ').replace(/"/g, '\'').trim()
}

interface RenderContext {
  model: LogicModelV1
  /** state id -> alias usable in the notation */
  alias: Map<string, string>
  /** state id -> display label (narrative meaning when present) */
  display: Map<string, string>
  terminal: Set<string>
  warnings: string[]
}

function prepareRender(input: unknown): RenderContext {
  const validation = validateModel(input)
  if (!validation.ok) throw new UmlError('model invalid: ' + validation.errors.join('; '))
  const model = validation.model
  const warnings: string[] = []
  const used = new Set<string>()
  const alias = new Map<string, string>()
  const display = new Map<string, string>()
  for (const state of model.states) {
    let candidate = state.id
    if (!PLAIN_ID.test(candidate)) {
      candidate = candidate.replace(/[^A-Za-z0-9_]/g, '_')
      if (candidate === '' || /^[0-9]/.test(candidate)) candidate = 'S_' + candidate
      warnings.push('UML_RENDER_ID_SANITIZED: state id "' + state.id + '" is not a plain identifier; the diagram draws it as "' + candidate + '" and pins the original with a ' + DIRECTIVE_NAMESPACE + 'alias directive.')
    }
    if (RESERVED_NODE_IDS.has(candidate)) warnings.push('UML_RENDER_RESERVED_ID: state alias "' + candidate + '" collides with a diagram keyword; Mermaid renders it, but a hand edit may not.')
    let unique = candidate
    let suffix = 2
    while (used.has(unique)) { unique = candidate + '_' + String(suffix); suffix += 1 }
    if (unique !== candidate) warnings.push('UML_RENDER_ALIAS_COLLISION: state id "' + state.id + '" shares an alias with another state; the diagram uses "' + unique + '".')
    used.add(unique)
    alias.set(state.id, unique)
    const meaning = model.narrative?.states?.[state.id]
    display.set(state.id, meaning === undefined ? state.id : displayText(state.id + '（' + meaning + '）'))
  }
  for (const transition of model.transitions) {
    if (UNSAFE_LABEL.test(transition.event)) {
      warnings.push('UML_RENDER_LABEL_UNSAFE: event "' + transition.event + '" contains a character (one of [ ] / or a line break) that the diagram label syntax uses; the rendered diagram cannot be read back verbatim.')
    }
  }
  const terminal = new Set(model.states.filter((state) => state.terminal === true).map((state) => state.id))
  return { model, alias, display, terminal, warnings }
}

function directiveLines(notation: UmlNotation, diagram: UmlDiagram, context: RenderContext): string[] {
  const prefix = notation === 'mermaid' ? '%%' : "'"
  const lines = [prefix + DIRECTIVE_NAMESPACE + 'uml v1 notation=' + notation + ' diagram=' + diagram]
  lines.push(prefix + DIRECTIVE_NAMESPACE + 'init ' + context.model.init)
  const terminals = context.model.states.filter((state) => state.terminal === true).map((state) => state.id)
  if (terminals.length > 0) lines.push(prefix + DIRECTIVE_NAMESPACE + 'terminal ' + terminals.join(','))
  for (const state of context.model.states) {
    if (context.alias.get(state.id) !== state.id) {
      lines.push(prefix + DIRECTIVE_NAMESPACE + 'alias ' + String(context.alias.get(state.id)) + ' ' + state.id)
    }
  }
  // Variable kinds are not recoverable from the notation: `armed := 1` reads as an
  // integer assignment whichever kind the model declared, and a variable no guard
  // reads and no action writes leaves no trace at all. Pinning them keeps the
  // round trip exact instead of reporting a fidelity loss that is really a
  // notation limit.
  for (const variable of context.model.variables ?? []) {
    lines.push(prefix + DIRECTIVE_NAMESPACE + 'variable ' + variable.name + ' ' + variable.kind)
  }
  return lines
}

function groupedTransitions(model: LogicModelV1): Array<{ from: string; transitions: TransitionSpec[] }> {
  const order: string[] = []
  const groups = new Map<string, TransitionSpec[]>()
  for (const transition of model.transitions) {
    const list = groups.get(transition.from)
    if (list === undefined) { groups.set(transition.from, [transition]); order.push(transition.from) }
    else list.push(transition)
  }
  return order.map((from) => ({ from, transitions: groups.get(from) ?? [] }))
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderMermaidState(context: RenderContext): string {
  const lines = directiveLines('mermaid', 'state', context)
  lines.push('stateDiagram-v2')
  lines.push('  [*] --> ' + String(context.alias.get(context.model.init)))
  for (const state of context.model.states) {
    const alias = String(context.alias.get(state.id))
    const label = context.display.get(state.id) ?? state.id
    // Every state is declared, even when its label equals its alias. A state that
    // no transition touches (an isolated terminal, a start state with no edge yet)
    // would otherwise leave no trace in the text at all, and the round-trip check
    // would have to report a loss the notation never caused.
    lines.push('  state "' + label + '" as ' + alias)
  }
  for (const group of groupedTransitions(context.model)) {
    for (const transition of group.transitions) {
      lines.push('  ' + String(context.alias.get(transition.from)) + ' --> ' + String(context.alias.get(transition.to)) + ' : ' + transitionText(transition))
    }
  }
  for (const state of context.model.states) {
    if (state.terminal === true) lines.push('  ' + String(context.alias.get(state.id)) + ' --> [*]')
  }
  return lines.join('\n') + '\n'
}

function renderPlantUmlState(context: RenderContext): string {
  const lines = ['@startuml']
  lines.push(...directiveLines('plantuml', 'state', context))
  lines.push('[*] --> ' + String(context.alias.get(context.model.init)))
  for (const state of context.model.states) {
    const alias = String(context.alias.get(state.id))
    const label = context.display.get(state.id) ?? state.id
    lines.push('state "' + label + '" as ' + alias)
  }
  for (const group of groupedTransitions(context.model)) {
    for (const transition of group.transitions) {
      lines.push(String(context.alias.get(transition.from)) + ' --> ' + String(context.alias.get(transition.to)) + ' : ' + transitionText(transition))
    }
  }
  for (const state of context.model.states) {
    if (state.terminal === true) lines.push(String(context.alias.get(state.id)) + ' --> [*]')
  }
  lines.push('@enduml')
  return lines.join('\n') + '\n'
}

function renderMermaidActivity(context: RenderContext): string {
  const lines = directiveLines('mermaid', 'activity', context)
  lines.push('flowchart TD')
  for (const state of context.model.states) {
    const alias = String(context.alias.get(state.id))
    const text = context.display.get(state.id) ?? state.id
    lines.push('  ' + alias + (state.terminal === true ? '(["' + text + '"])' : '["' + text + '"]'))
  }
  for (const group of groupedTransitions(context.model)) {
    for (const transition of group.transitions) {
      lines.push('  ' + String(context.alias.get(transition.from)) + ' -->|"' + transitionText(transition) + '"| ' + String(context.alias.get(transition.to)))
    }
  }
  return lines.join('\n') + '\n'
}

/**
 * One BFS trace of the machine, written as a sequence diagram. A sequence
 * diagram is a trace by construction — branches are messages with guards, and
 * the diagram is explicitly capped so a cyclic machine cannot produce an
 * unbounded file.
 */
function renderSequence(context: RenderContext, notation: UmlNotation, maxSteps: number): { text: string; truncated: boolean } {
  const lines: string[] = []
  if (notation === 'mermaid') {
    lines.push(...directiveLines('mermaid', 'sequence', context))
    lines.push('sequenceDiagram')
    lines.push('  participant ENV as Environment')
    lines.push('  participant M as Machine')
  } else {
    lines.push('@startuml')
    lines.push(...directiveLines('plantuml', 'sequence', context))
    lines.push('participant ENV as Environment')
    lines.push('participant M as Machine')
  }
  const byFrom = new Map<string, TransitionSpec[]>()
  for (const transition of context.model.transitions) {
    const list = byFrom.get(transition.from)
    if (list === undefined) byFrom.set(transition.from, [transition])
    else list.push(transition)
  }
  const seen = new Set<string>([context.model.init])
  const queue: string[] = [context.model.init]
  const arrow = notation === 'mermaid' ? 'ENV->>M: ' : 'ENV -> M : '
  const note = notation === 'mermaid' ? '  Note over M: ' : 'note over M : '
  lines.push((notation === 'mermaid' ? '  ' : '') + 'Note over M: init ' + context.model.init)
  let steps = 0
  let truncated = false
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const transition of byFrom.get(current) ?? []) {
      if (steps >= maxSteps) { truncated = true; break }
      steps += 1
      const label = transitionText(transition)
      lines.push((notation === 'mermaid' ? '  ' : '') + arrow + label)
      lines.push(note + String(context.alias.get(transition.from)) + ' -> ' + String(context.alias.get(transition.to)))
      if (!seen.has(transition.to)) { seen.add(transition.to); queue.push(transition.to) }
    }
    if (truncated) break
  }
  if (notation === 'plantuml') lines.push('@enduml')
  return { text: lines.join('\n') + '\n', truncated }
}

/**
 * Render a LogicModelV1 as UML.
 *
 * PlantUML has no faithful activity view here: its activity syntax is a
 * structured flowchart language, so a graph with merges or cycles needs a
 * while/if reconstruction this module does not perform. Refusing is the honest
 * outcome — quietly emitting a state diagram under an "activity" request would
 * mislabel the model. Mermaid covers all three views.
 *
 * @param input - candidate LogicModelV1.
 * @param notation - `mermaid` (default) or `plantuml`.
 * @param diagram - `state` (default), `activity`, or `sequence`.
 * @param maxSteps - cap on the sequence trace length.
 */
export function renderUml(input: unknown, notation: UmlNotation = 'mermaid', diagram: UmlDiagram = 'state', maxSteps = 60): UmlRenderResult {
  if (!UML_NOTATIONS.includes(notation)) throw new UmlError('unknown notation "' + String(notation) + '"; expected ' + UML_NOTATIONS.join(' | '))
  if (!UML_DIAGRAMS.includes(diagram)) throw new UmlError('unknown diagram "' + String(diagram) + '"; expected ' + UML_DIAGRAMS.join(' | '))
  if (notation === 'plantuml' && diagram === 'activity') {
    throw new UmlError('plantuml has no faithful activity view here (its activity syntax is a structured flowchart language; a graph with merges or cycles needs a while/if reconstruction logicprobe does not perform) — use notation "mermaid" for the activity view, or diagram "state"')
  }
  const context = prepareRender(input)
  const warnings = [...context.warnings]
  let primary: string
  if (diagram === 'state') primary = notation === 'mermaid' ? renderMermaidState(context) : renderPlantUmlState(context)
  else if (diagram === 'activity') primary = renderMermaidActivity(context)
  else {
    const rendered = renderSequence(context, notation, maxSteps)
    primary = rendered.text
    if (rendered.truncated) warnings.push('UML_RENDER_SEQUENCE_TRUNCATED: the trace was capped at ' + String(maxSteps) + ' steps; a sequence diagram is one trace, not the whole machine — use diagram "state" for the full topology.')
    warnings.push('UML_RENDER_SEQUENCE_IS_TRACE: a sequence diagram shows one BFS trace; branches appear as separate guarded messages and unreachable branches are absent by construction.')
  }
  return { notation, diagram, primary, warnings }
}

// ---------------------------------------------------------------------------
// Parsing — guard expressions
// ---------------------------------------------------------------------------

interface GuardToken {
  kind: 'ident' | 'number' | 'boolean' | 'op' | 'not' | 'and' | 'or' | 'lparen' | 'rparen'
  text: string
}

function tokenizeGuard(text: string): GuardToken[] {
  const tokens: GuardToken[] = []
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (/\s/.test(char)) { index += 1; continue }
    if (char === '(') { tokens.push({ kind: 'lparen', text: char }); index += 1; continue }
    if (char === ')') { tokens.push({ kind: 'rparen', text: char }); index += 1; continue }
    if (char === '&' && text[index + 1] === '&') { tokens.push({ kind: 'and', text: '&&' }); index += 2; continue }
    if (char === '|' && text[index + 1] === '|') { tokens.push({ kind: 'or', text: '||' }); index += 2; continue }
    if (char === '!') {
      if (text[index + 1] === '=') { tokens.push({ kind: 'op', text: '!=' }); index += 2; continue }
      tokens.push({ kind: 'not', text: '!' }); index += 1; continue
    }
    const two = text.slice(index, index + 2)
    if (two === '==' || two === '<=' || two === '>=') { tokens.push({ kind: 'op', text: two }); index += 2; continue }
    if (char === '<' || char === '>') { tokens.push({ kind: 'op', text: char }); index += 1; continue }
    if (char === '=') { tokens.push({ kind: 'op', text: '==' }); index += 1; continue }
    if (/[0-9]/.test(char) || (char === '-' && /[0-9]/.test(text[index + 1] ?? ''))) {
      let end = index + 1
      while (end < text.length && /[0-9]/.test(text[end])) end += 1
      tokens.push({ kind: 'number', text: text.slice(index, end) })
      index = end
      continue
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1
      while (end < text.length && /[A-Za-z0-9_.]/.test(text[end])) end += 1
      const word = text.slice(index, end)
      index = end
      if (word === 'and') tokens.push({ kind: 'and', text: word })
      else if (word === 'or') tokens.push({ kind: 'or', text: word })
      else if (word === 'not') tokens.push({ kind: 'not', text: word })
      else if (word === 'true' || word === 'false') tokens.push({ kind: 'boolean', text: word })
      else tokens.push({ kind: 'ident', text: word })
      continue
    }
    throw new UmlError('guard text not understood near "' + text.slice(index) + '"')
  }
  return tokens
}

class GuardReader {
  private position = 0

  constructor(private readonly tokens: GuardToken[], private readonly source: string) {}

  parse(): GuardNode {
    const node = this.parseOr()
    if (this.position !== this.tokens.length) throw new UmlError('trailing tokens in guard "' + this.source + '"')
    return node
  }

  private peek(): GuardToken | undefined {
    return this.tokens[this.position]
  }

  private parseOr(): GuardNode {
    const parts: GuardNode[] = [this.parseAnd()]
    while (this.peek()?.kind === 'or') { this.position += 1; parts.push(this.parseAnd()) }
    return parts.length === 1 ? parts[0] : { any: parts }
  }

  private parseAnd(): GuardNode {
    const parts: GuardNode[] = [this.parseUnary()]
    while (this.peek()?.kind === 'and') { this.position += 1; parts.push(this.parseUnary()) }
    return parts.length === 1 ? parts[0] : { all: parts }
  }

  private parseUnary(): GuardNode {
    if (this.peek()?.kind === 'not') { this.position += 1; return { not: this.parseUnary() } }
    return this.parsePrimary()
  }

  private parsePrimary(): GuardNode {
    const token = this.peek()
    if (token?.kind === 'lparen') {
      this.position += 1
      const inner = this.parseOr()
      if (this.peek()?.kind !== 'rparen') throw new UmlError('unbalanced parentheses in guard "' + this.source + '"')
      this.position += 1
      return inner
    }
    if (token?.kind !== 'ident') throw new UmlError('expected a variable name in guard "' + this.source + '"')
    this.position += 1
    const op = this.peek()
    if (op?.kind !== 'op') throw new UmlError('expected a comparison operator after "' + token.text + '" in guard "' + this.source + '"')
    this.position += 1
    const value = this.peek()
    if (value?.kind === 'number') { this.position += 1; return { variable: token.text, op: op.text as GuardOp, value: Number(value.text) } }
    if (value?.kind === 'boolean') {
      if (op.text !== '==' && op.text !== '!=') throw new UmlError('boolean variable "' + token.text + '" only supports == / != (guard "' + this.source + '")')
      this.position += 1
      return { variable: token.text, op: op.text, value: value.text === 'true' }
    }
    throw new UmlError('expected a literal value for "' + token.text + '" in guard "' + this.source + '"')
  }
}

/** Parse a guard expression such as `(retry < 3 && armed == true)`. */
export function parseGuardText(text: string): GuardNode {
  return new GuardReader(tokenizeGuard(text), text).parse()
}

/** Parse a UML action clause such as `retry := retry + 1, armed := true`. */
export function parseUpdatesText(text: string, warnings: string[]): UpdateSpec[] {
  const out: UpdateSpec[] = []
  for (const raw of text.split(',')) {
    const clause = raw.trim()
    if (clause === '') continue
    const shim = /^([A-Za-z_][A-Za-z0-9_]*)\s*(\+\+|--)$/.exec(clause)
    if (shim !== null) { out.push({ variable: shim[1], op: shim[2] === '++' ? 'inc' : 'dec', value: 1 }); continue }
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*:?=\s*(.+)$/.exec(clause)
    if (assignment === null) throw new UmlError('action clause not understood: "' + clause + '" (expected "var := value")')
    const name = assignment[1]
    const value = assignment[2].trim()
    if (value === name) { warnings.push('UML_PARSE_NOOP_UPDATE: action "' + clause + '" assigns the variable to itself; dropped.'); continue }
    if (/^(true|false)$/.test(value)) { out.push({ variable: name, op: 'set', value: value === 'true' ? 1 : 0 }); continue }
    if (/^-?[0-9]+$/.test(value)) { out.push({ variable: name, op: 'set', value: Number(value) }); continue }
    const arithmetic = /^([A-Za-z_][A-Za-z0-9_]*)\s*([+-])\s*([0-9]+)$/.exec(value)
    if (arithmetic === null) throw new UmlError('action value not understood: "' + value + '" (expected a literal, or "var + n" / "var - n")')
    if (arithmetic[1] !== name) throw new UmlError('action "' + clause + '" reads a different variable; LogicModelV1 updates touch one variable')
    out.push({ variable: name, op: arithmetic[2] === '+' ? 'inc' : 'dec', value: Number(arithmetic[3]) })
  }
  return out
}

// ---------------------------------------------------------------------------
// Parsing — diagram text
// ---------------------------------------------------------------------------

interface ParsedTransitionLabel {
  event: string
  guard?: GuardNode
  updates?: UpdateSpec[]
}

function parseTransitionLabel(label: string, warnings: string[]): ParsedTransitionLabel {
  let rest = label.trim()
  let guard: GuardNode | undefined
  const bracket = rest.indexOf('[')
  if (bracket >= 0) {
    const close = rest.lastIndexOf(']')
    if (close < bracket) throw new UmlError('unbalanced guard brackets in transition label "' + label + '"')
    guard = parseGuardText(rest.slice(bracket + 1, close).trim())
    rest = (rest.slice(0, bracket) + ' ' + rest.slice(close + 1)).trim()
  }
  let updates: UpdateSpec[] | undefined
  const slash = rest.indexOf('/')
  if (slash >= 0) {
    const actionText = rest.slice(slash + 1).trim()
    updates = parseUpdatesText(actionText, warnings)
    if (updates.length === 0) updates = undefined
    rest = rest.slice(0, slash).trim()
  }
  const event = rest.trim()
  if (event === '') throw new UmlError('transition label "' + label + '" carries no event name; label the arrow as `event [guard] / actions`')
  return { event, ...(guard === undefined ? {} : { guard }), ...(updates === undefined ? {} : { updates }) }
}

interface DiagramLine {
  text: string
  diagram: 'state' | 'activity' | 'sequence'
}

/**
 * Mermaid diagram-family headers that are neither a state machine nor a flow.
 * Recognizing them matters twice: the text must not be reported as "cannot tell
 * whether this is Mermaid or PlantUML", and it must not be parsed as a state
 * diagram — every line of it would be ignored or misread, and the empty model that
 * comes out would be presented as if it described the file.
 */
const MERMAID_OTHER_FAMILIES: readonly string[] = [
  'classDiagram', 'erDiagram', 'gantt', 'pie', 'journey', 'mindmap', 'gitGraph',
  'C4Context', 'C4Container', 'C4Component', 'C4Dynamic', 'C4Deployment',
  'requirementDiagram', 'timeline', 'quadrantChart', 'sankey-beta', 'block-beta',
  'packet-beta', 'architecture-beta', 'radar-beta', 'treemap-beta', 'xychart-beta',
]

/** The other-family header this text declares, if any. */
function otherMermaidFamily(text: string): string | undefined {
  for (const family of MERMAID_OTHER_FAMILIES) {
    if (new RegExp('^\\s*' + family + '\\b', 'm').test(text)) return family
  }
  return undefined
}

function detectNotation(text: string): UmlNotation {
  if (/^\s*@start/m.test(text)) return 'plantuml'
  if (/^\s*(stateDiagram|stateDiagram-v2|flowchart|graph|sequenceDiagram)\b/m.test(text)) return 'mermaid'
  // A known Mermaid family is still Mermaid: say so, and let detectDiagram refuse it
  // by name instead of blaming the notation.
  if (otherMermaidFamily(text) !== undefined) return 'mermaid'
  throw new UmlError('cannot tell whether this is Mermaid or PlantUML text: expected `stateDiagram-v2` / `flowchart` / `sequenceDiagram`, or `@startuml`')
}

function detectDiagram(text: string): 'state' | 'activity' | 'sequence' {
  if (/^\s*stateDiagram/m.test(text)) return 'state'
  if (/^\s*(flowchart|graph)\b/m.test(text)) return 'activity'
  if (/^\s*sequenceDiagram\b/m.test(text)) return 'sequence'
  const family = otherMermaidFamily(text)
  if (family !== undefined) {
    throw new UmlError('`' + family + '` is not a state or activity diagram: logicprobe models state machines and flows, so this diagram family cannot be parsed into a LogicModelV1. Discarded: ' + family + ' ×1. Render the machine with logicprobe_uml action=render and keep this diagram as its own view.', 'UML_NOT_A_STATE_DIAGRAM')
  }
  if (/^\s*@startuml/m.test(text)) {
    // PlantUML declares the diagram kind by its body; the state keyword is the only
    // structural one logicprobe emits, everything else in that family is a state diagram too.
    if (/^\s*participant\b/m.test(text) || /->>\s*/.test(text)) return 'sequence'
    return 'state'
  }
  throw new UmlError('cannot tell which diagram kind this text declares')
}

function commentPrefix(notation: UmlNotation): string {
  return notation === 'mermaid' ? '%%' : "'"
}

function directiveBody(line: string, notation: UmlNotation): string | null {
  const prefix = commentPrefix(notation)
  const trimmed = line.trim()
  if (!trimmed.startsWith(prefix)) return null
  const body = trimmed.slice(prefix.length).trim()
  if (!body.startsWith(DIRECTIVE_NAMESPACE)) return null
  return body.slice(DIRECTIVE_NAMESPACE.length)
}

interface Directives {
  init?: string
  terminals: string[]
  aliases: Map<string, string>
  variables: Map<string, 'integer' | 'boolean'>
  declared?: { notation?: string; diagram?: string }
}

function readDirectives(lines: string[], notation: UmlNotation): { directives: Directives; kindHint?: string; body: string[] } {
  const directives: Directives = { terminals: [], aliases: new Map(), variables: new Map() }
  const body: string[] = []
  for (const line of lines) {
    const text = directiveBody(line, notation)
    if (text === null) { body.push(line); continue }
    if (text.startsWith('uml ')) {
      const notationMatch = /notation=([a-z]+)/.exec(text)
      const diagramMatch = /diagram=([a-z]+)/.exec(text)
      directives.declared = { ...(notationMatch === null ? {} : { notation: notationMatch[1] }), ...(diagramMatch === null ? {} : { diagram: diagramMatch[1] }) }
      continue
    }
    if (text.startsWith('init ')) { directives.init = text.slice(5).trim(); continue }
    if (text.startsWith('terminal ')) {
      for (const id of text.slice(9).split(',')) { const trimmed = id.trim(); if (trimmed !== '') directives.terminals.push(trimmed) }
      continue
    }
    if (text.startsWith('alias ')) {
      const rest = text.slice(6).trim()
      const split = rest.indexOf(' ')
      if (split > 0) directives.aliases.set(rest.slice(0, split), rest.slice(split + 1).trim())
      continue
    }
    if (text.startsWith('variable ')) {
      const rest = text.slice(9).trim()
      const split = rest.lastIndexOf(' ')
      if (split > 0) {
        const kind = rest.slice(split + 1).trim()
        if (kind === 'integer' || kind === 'boolean') directives.variables.set(rest.slice(0, split).trim(), kind)
      }
      continue
    }
    body.push(line)
  }
  return { directives, ...(directives.declared?.diagram === undefined ? {} : { kindHint: directives.declared.diagram }), body }
}

interface RawEdge {
  from: string
  to: string
  label: string
}

interface RawDiagram {
  states: string[]
  display: Map<string, string>
  edges: RawEdge[]
  initialState?: string
  terminals: string[]
  finalMarks: string[]
  warnings: string[]
  /** Declarations that belong to another diagram family (component, package, class, …). */
  discarded: DiscardedConstruct[]
  /** Node names those declarations introduced; arrows touching them are counted as discarded edges. */
  discardedNodes: Set<string>
}

function rawToModel(raw: RawDiagram, directives: Directives, warnings: string[]): LogicModelV1 {
  // Alias directives restore ids the notation cannot spell; they win over the
  // alias itself, which is the whole reason the renderer writes them.
  const idOf = (name: string): string => directives.aliases.get(name) ?? name
  const names: string[] = []
  const seenNames = new Set<string>()
  const addName = (name: string | undefined): void => {
    if (name === undefined || seenNames.has(name)) return
    seenNames.add(name)
    names.push(name)
  }
  for (const name of raw.states) addName(name)
  // A state can be known without ever being an edge endpoint: the initial
  // pseudostate (`[*] --> X`) and the final mark (`Y --> [*]`) both name states a
  // hand-written diagram never declares, and an isolated state has no edge at all.
  addName(raw.initialState)
  for (const name of raw.finalMarks) addName(name)
  for (const name of raw.terminals) addName(name)
  for (const edge of raw.edges) { addName(edge.from); addName(edge.to) }
  const states: StateSpec[] = []
  const seenStates = new Set<string>()
  for (const name of names) {
    const id = idOf(name)
    if (seenStates.has(id)) continue
    seenStates.add(id)
    states.push({ id })
  }
  const transitions: TransitionSpec[] = []
  const synthetic = new Set<string>()
  for (const edge of raw.edges) {
    const from = idOf(edge.from)
    const to = idOf(edge.to)
    const label = edge.label.trim()
    let event: string
    let guard: GuardNode | undefined
    let updates: UpdateSpec[] | undefined
    if (label === '') {
      let candidate = 't_' + from + '_' + to
      let suffix = 2
      while (synthetic.has(candidate)) { candidate = 't_' + from + '_' + to + '_' + String(suffix); suffix += 1 }
      synthetic.add(candidate)
      event = candidate
      warnings.push('UML_PARSE_SYNTHETIC_EVENT: arrow ' + from + ' -> ' + to + ' carries no label; it was named "' + candidate + '". Label the arrow as `event [guard] / actions` so the model keeps the real event name.')
    } else {
      const parsed = parseTransitionLabel(label, warnings)
      event = parsed.event
      guard = parsed.guard
      updates = parsed.updates
    }
    transitions.push({ from, event, to, ...(guard === undefined ? {} : { guard }), ...(updates === undefined ? {} : { updates }) })
  }
  // Init: an explicit `[*] --> X` wins; a directive is the fallback the activity
  // view needs (a flowchart has no initial pseudostate).
  let init = raw.initialState === undefined ? undefined : idOf(raw.initialState)
  if (init === undefined && directives.init !== undefined) init = idOf(directives.init)
  if (raw.initialState !== undefined && directives.init !== undefined && idOf(raw.initialState) !== directives.init) {
    warnings.push('UML_PARSE_INIT_CONFLICT: the diagram enters ' + idOf(raw.initialState) + ' from its initial pseudostate but declares init ' + directives.init + '; the pseudostate wins.')
  }
  if (init === undefined) {
    const targeted = new Set(transitions.map((transition) => transition.to))
    const roots = states.map((state) => state.id).filter((id) => !targeted.has(id))
    if (roots.length === 1) {
      init = roots[0]
      warnings.push('UML_PARSE_INIT_INFERRED: no initial state was declared; "' + init + '" is the only state nothing enters, so it is used as init.')
    } else {
      throw new UmlError('no initial state: add `[*] --> <state>` (or a `' + DIRECTIVE_NAMESPACE + 'init <state>` directive); found ' + String(roots.length) + ' entry states')
    }
  }
  const terminalNames = new Set<string>(raw.terminals.map((name) => idOf(name)))
  for (const name of directives.terminals) terminalNames.add(idOf(name))
  for (const name of raw.finalMarks) terminalNames.add(idOf(name))
  for (const state of states) if (terminalNames.has(state.id)) state.terminal = true
  const variables = inferVariables(transitions, directives.variables)
  const model: LogicModelV1 = {
    schemaVersion: 1,
    init,
    states,
    transitions,
    ...(variables.length === 0 ? {} : { variables }),
  }
  const validation = validateModel(model)
  if (!validation.ok) throw new UmlError('the diagram parsed into an invalid model: ' + validation.errors.join('; '))
  return validation.model
}

/**
 * Recover the variable list from the diagram. A `logicprobe:variable` directive
 * wins, because the notation itself cannot tell `armed := 1` on a boolean from an
 * integer assignment; guards and actions are the fallback for hand-written text.
 */
function inferVariables(transitions: TransitionSpec[], declared: Map<string, 'integer' | 'boolean'>): VariableSpec[] {
  const kinds = new Map<string, 'integer' | 'boolean'>(declared)
  const note = (name: string, kind: 'integer' | 'boolean'): void => {
    if (declared.has(name)) return
    const current = kinds.get(name)
    if (current === undefined) kinds.set(name, kind)
    else if (current !== kind) kinds.set(name, 'integer')
  }
  const walk = (guard: GuardNode | undefined): void => {
    if (guard === undefined) return
    if ('variable' in guard) { note(guard.variable, typeof guard.value === 'boolean' ? 'boolean' : 'integer'); return }
    if ('all' in guard) { for (const child of guard.all) walk(child); return }
    if ('any' in guard) { for (const child of guard.any) walk(child); return }
    walk(guard.not)
  }
  for (const transition of transitions) {
    walk(transition.guard)
    for (const update of transition.updates ?? []) note(update.variable, 'integer')
  }
  return [...kinds.entries()].map(([name, kind]) => ({ name, kind, init: kind === 'boolean' ? false : 0 }))
}

/**
 * PlantUML keywords that declare a construct LogicModelV1 has no place for. Their
 * presence marks the text as a component, package, class, deployment or database
 * diagram — a different diagram family. A state parser still reads *something* out of
 * such a file (the arrows look like transitions), which is why the discarded
 * declarations are collected and reported instead of being ignored.
 */
const PLANTUML_OTHER_CONSTRUCT = /^(component|package|class|interface|enum|enumeration|object|actor|usecase|node|artifact|database|rectangle|folder|frame|cloud|storage|collections|queue|stack|agent|boundary|control|entity|deployment|protocol|struct|exception|metaclass|stereotype|circle|hexagon|label|port|portin|portout)\b/i

/** The node identifier a declaration introduces, when it has one (`… as ID`, or a bare `component ID`). */
function declaredIdentifier(text: string): string | undefined {
  const alias = /\bas\s+([A-Za-z_][A-Za-z0-9_]*)\s*;?$/.exec(text)
  if (alias !== null) return alias[1]
  const bare = /^[A-Za-z]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*;?$/.exec(text)
  return bare === null ? undefined : bare[1]
}

/**
 * Findings a parse result carries on its own. A diagram from another family parses
 * into something; without this finding that something is presented as a model of the
 * file, which is a false guarantee of exactly the kind this plugin exists to prevent.
 */
export function parseFindings(parsed: UmlParseResult): UmlFinding[] {
  if (parsed.discardedConstructs.length === 0) return []
  const counts = new Map<string, number>()
  for (const entry of parsed.discardedConstructs) counts.set(entry.construct, (counts.get(entry.construct) ?? 0) + 1)
  const summary = [...counts.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([construct, count]) => construct + ' ×' + String(count))
    .join(', ')
  const shown = parsed.discardedConstructs.slice(0, 12).map((entry) => 'line ' + String(entry.line) + ': ' + entry.text).join(' | ')
  return [{
    code: 'UML_NOT_A_STATE_DIAGRAM',
    severity: 'error',
    message: 'the text is not a state or activity diagram: ' + String(parsed.discardedConstructs.length) + ' declaration(s) of unsupported construct(s) (' + summary + ') and ' + String(parsed.discardedEdges) + ' arrow(s) between them were read as states and transitions, so the parsed model is not this diagram.',
    detail: shown + (parsed.discardedConstructs.length > 12 ? ' | … ' + String(parsed.discardedConstructs.length - 12) + ' more' : ''),
  }]
}

function parseStateDiagram(text: string, notation: UmlNotation): UmlParseResult {
  const lines = text.split(/\r?\n/)
  const { directives, body } = readDirectives(lines, notation)
  const raw: RawDiagram = { states: [], display: new Map(), edges: [], terminals: [], finalMarks: [], warnings: [], discarded: [], discardedNodes: new Set() }
  let discardedEdges = 0
  const declared = new Set<string>()
  const declare = (name: string): void => { if (!declared.has(name)) { declared.add(name); raw.states.push(name) } }
  const skip = notation === 'mermaid'
    ? /^(stateDiagram|stateDiagram-v2|direction\b|classDef\b|class\b|style\b|linkStyle\b|click\b|hide\b|scale\b|title\b|accTitle\b|accDescr\b|%%\{)/
    : /^(@startuml|@enduml|scale\b|skinparam\b|title\b|hide\b|left to right direction|top to bottom direction|autonumber|!theme)/
  let inNote = false
  body.forEach((rawLine, index) => {
    const line = rawLine.trim()
    if (line === '' || (line.startsWith('--') && !line.includes('-->'))) return
    if (skip.test(line)) return
    const noteStart = /^note\b/i.test(line)
    const noteEnd = /^end\s*note$/i.test(line)
    if (notation === 'plantuml' && !inNote && !noteStart && !noteEnd) {
      const other = PLANTUML_OTHER_CONSTRUCT.exec(line)
      if (other !== null) {
        raw.discarded.push({ construct: other[1].toLowerCase(), line: index + 1, text: line })
        const id = declaredIdentifier(line)
        if (id !== undefined) raw.discardedNodes.add(id)
        return
      }
    }
    if (noteEnd) { inNote = false; return }
    if (noteStart && !/:\s*.+$/.test(line)) inNote = true
    const note = /^note\s+(?:over|right of|left of)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/i.exec(line)
    if (note !== null) {
      declare(note[1])
      const existing = raw.display.get(note[1])
      if (existing === undefined) raw.display.set(note[1], note[2].trim())
      return
    }
    if (noteStart) return
    const stateDecl = /^state\s+"([^"]*)"\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/.exec(line)
    if (stateDecl !== null) { declare(stateDecl[2]); raw.display.set(stateDecl[2], stateDecl[1]); return }
    const bareState = /^state\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{?$/.exec(line)
    if (bareState !== null) { declare(bareState[1]); return }
    const concurrency = /^\}\s*$|^--\s*$/.test(line)
    if (concurrency) { raw.warnings.push('UML_PARSE_CONCURRENCY_FLATTENED: a concurrency region or composite block was flattened; LogicModelV1 has no region construct (use logicprobe_compose_verify for parallel machines).'); return }
    const composite = /^state\s+(.+)\s*\{$/.exec(line)
    if (composite !== null) { raw.warnings.push('UML_PARSE_COMPOSITE_FLATTENED: composite state "' + composite[1].trim() + '" was flattened into its members.'); return }
    const description = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/.exec(line)
    if (description !== null) { declare(description[1]); if (!raw.display.has(description[1])) raw.display.set(description[1], description[2].trim()); return }
    const edge = /^(.+?)\s*-->\s*(.+?)(?:\s*:\s*(.*))?$/.exec(line)
    if (edge !== null) {
      const from = edge[1].trim()
      const to = edge[2].trim()
      const label = (edge[3] ?? '').trim()
      if (from === '[*]') {
        if (raw.initialState !== undefined && raw.initialState !== to) {
          raw.warnings.push('UML_PARSE_MULTIPLE_INIT: the diagram enters ' + raw.initialState + ' and ' + to + ' from initial pseudostates; LogicModelV1 has one init, so ' + raw.initialState + ' is kept.')
        } else {
          raw.initialState = to
        }
        return
      }
      if (to === '[*]') { raw.finalMarks.push(from); return }
      declare(from)
      declare(to)
      if (raw.discardedNodes.has(from) || raw.discardedNodes.has(to)) discardedEdges += 1
      raw.edges.push({ from, to, label })
      return
    }
    raw.warnings.push('UML_PARSE_IGNORED_LINE: "' + line + '" is not a state diagram statement; it was ignored.')
  })
  const model = rawToModel(raw, directives, raw.warnings)
  const labels = mapLabels(raw.display, directives)
  return { notation, diagram: 'state', model, labels, discardedConstructs: raw.discarded, discardedEdges, warnings: raw.warnings }
}

function parseActivityDiagram(text: string, notation: UmlNotation): UmlParseResult {
  const lines = text.split(/\r?\n/)
  const { directives, body } = readDirectives(lines, notation)
  const raw: RawDiagram = { states: [], display: new Map(), edges: [], terminals: [], finalMarks: [], warnings: [], discarded: [], discardedNodes: new Set() }
  const declared = new Set<string>()
  const declare = (name: string): void => { if (!declared.has(name)) { declared.add(name); raw.states.push(name) } }
  const skip = /^(flowchart|graph)\b|^(classDef|class|style|linkStyle|click|direction)\b|^%%\{/
  let inSubgraph = false
  for (const rawLine of body) {
    const line = rawLine.trim()
    if (line === '' || skip.test(line)) continue
    if (/^subgraph\b/.test(line)) {
      if (!inSubgraph) { inSubgraph = true; raw.warnings.push('UML_PARSE_SUBGRAPH_FLATTENED: subgraph blocks were flattened; LogicModelV1 has no hierarchy.') }
      continue
    }
    if (line === 'end') { inSubgraph = false; continue }
    const shaped = /^(.*?)\s*-->\s*\|(.*?)\|\s*(.+)$/.exec(line)
    const bare = shaped === null ? /^(.*?)\s*-->\s*(.+)$/.exec(line) : null
    if (shaped !== null || bare !== null) {
      const match = (shaped ?? bare) as RegExpExecArray
      const from = stripNode(match[1].trim(), raw, declare)
      // Flowchart labels live between bars; the state-diagram form `A --> B : label`
      // is accepted too so a hand-written file that mixes the two still reads.
      let rawTo = (shaped === null ? match[2] : match[3]).trim()
      let label = shaped === null ? '' : shaped[2].replace(/^"|"$/g, '').trim()
      if (shaped === null) {
        const colon = rawTo.indexOf(':')
        if (colon >= 0) { label = rawTo.slice(colon + 1).trim().replace(/^"|"$/g, ''); rawTo = rawTo.slice(0, colon).trim() }
      }
      const to = stripNode(rawTo, raw, declare)
      if (from === undefined || to === undefined) continue
      raw.edges.push({ from, to, label })
      continue
    }
    const node = stripNode(line, raw, declare)
    if (node === undefined) raw.warnings.push('UML_PARSE_IGNORED_LINE: "' + line + '" is not a flowchart statement; it was ignored.')
  }
  const model = rawToModel(raw, directives, raw.warnings)
  const labels = mapLabels(raw.display, directives)
  return { notation, diagram: 'activity', model, labels, discardedConstructs: [], discardedEdges: 0, warnings: raw.warnings }
}

/**
 * Read one node reference (`A`, `A["label"]`, `A(["label"])`) and register the id
 * plus any display label it carries. Returns the node name, or undefined when the
 * text is not a node reference at all.
 */
function stripNode(text: string, raw: RawDiagram, declare: (name: string) => void): string | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const match = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*(\(\[|\[\(|\{\{|\[|\(|\(\(|>)?\s*([\s\S]*?)\s*$/.exec(trimmed)
  if (match === null) {
    const quoted = /^"([^"]+)"$/.exec(trimmed)
    if (quoted !== null) { declare(quoted[1]); return quoted[1] }
    return undefined
  }
  const name = match[1]
  const shape = match[2] ?? ''
  const rest = match[3] ?? ''
  declare(name)
  const quoted = /"([^"]*)"/.exec(rest)
  const label = quoted !== null ? quoted[1].trim() : rest.replace(/^[\[\](){}>]+/, '').replace(/[\[\](){}>]+$/, '').trim()
  if (label !== '' && !raw.display.has(name)) raw.display.set(name, label)
  if (shape === '([' || shape === '((' || rest.startsWith('([')) raw.terminals.push(name)
  return name
}

function mapLabels(display: Map<string, string>, directives: Directives): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, label] of display) out[directives.aliases.get(name) ?? name] = label
  return out
}

/**
 * Parse a Mermaid or PlantUML diagram back into a LogicModelV1.
 *
 * State and activity diagrams carry the whole machine, so they parse into a
 * complete model. Sequence diagrams do not: a trace shows the paths that were
 * walked, not the branches that were not, so parsing one would silently prune
 * the machine. That case is refused rather than approximated.
 *
 * @param text - diagram source.
 * @param notation - `auto` (default) detects Mermaid vs PlantUML from the text.
 */
export function parseUml(text: string, notation: UmlNotation | 'auto' = 'auto'): UmlParseResult {
  const resolved = notation === 'auto' ? detectNotation(text) : notation
  const kind = detectDiagram(text)
  if (kind === 'sequence') {
    throw new UmlError('a sequence diagram is a trace, not a machine: parsing it would drop every branch the trace did not walk. Render diagram "state" or "activity" and parse that instead.', 'UML_NOT_A_STATE_DIAGRAM')
  }
  return kind === 'state' ? parseStateDiagram(text, resolved) : parseActivityDiagram(text, resolved)
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

function reachableStates(model: LogicModelV1): Set<string> {
  const adjacency = new Map<string, string[]>()
  for (const transition of model.transitions) {
    const list = adjacency.get(transition.from)
    if (list === undefined) adjacency.set(transition.from, [transition.to])
    else list.push(transition.to)
  }
  const visited = new Set<string>([model.init])
  const queue = [model.init]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) { visited.add(next); queue.push(next) }
    }
  }
  return visited
}

function canonicalTransition(transition: TransitionSpec): string {
  return transition.from + '|' + transition.event + '|' + transition.to + '|' + (transition.guard === undefined ? '' : guardText(transition.guard)) + '|' + (transition.updates === undefined ? '' : updatesText(transition.updates))
}

/** The narrative meaning a diagram label carries, if it carries one beyond the bare id. */
function documentedMeaning(label: string | undefined, id: string): string | undefined {
  if (label === undefined) return undefined
  const trimmed = label.trim()
  if (trimmed === '' || trimmed === id) return undefined
  for (const [open, close] of [['（', '）'], ['(', ')']] as const) {
    const prefix = id + open
    if (trimmed.startsWith(prefix) && trimmed.endsWith(close)) return trimmed.slice(prefix.length, trimmed.length - close.length)
  }
  return trimmed
}

function structuralFindings(model: LogicModelV1, labels: Record<string, string> | undefined, warnings: string[]): UmlFinding[] {
  const findings: UmlFinding[] = []
  const reachable = reachableStates(model)
  const outgoing = new Map<string, TransitionSpec[]>()
  for (const transition of model.transitions) {
    const list = outgoing.get(transition.from)
    if (list === undefined) outgoing.set(transition.from, [transition])
    else list.push(transition)
  }

  const unreachable = model.states.map((state) => state.id).filter((id) => !reachable.has(id))
  if (unreachable.length > 0) {
    findings.push({
      code: 'UML002_UNREACHABLE_STATE',
      severity: 'error',
      message: unreachable.length + ' state(s) cannot be entered from init along any transition, so the diagram draws flow nobody can reach.',
      states: unreachable,
      detail: 'Structural reachability (guards ignored). Guard-aware reachability is S1 in logicprobe_verify.',
    })
  }

  const deadEnds = model.states.filter((state) => state.terminal !== true && (outgoing.get(state.id) ?? []).length === 0).map((state) => state.id)
  if (deadEnds.length > 0) {
    findings.push({
      code: 'UML003_DEAD_END_STATE',
      severity: 'error',
      message: deadEnds.length + ' non-terminal state(s) have no outgoing transition: the flow stops there without a modelled terminal.',
      states: deadEnds,
      detail: 'Either the state is terminal (add `X --> [*]`) or the outgoing flow is missing from the model. logicprobe_verify S2 reports the same shape at runtime granularity.',
    })
  }

  const groups = new Map<string, TransitionSpec[]>()
  for (const transition of model.transitions) {
    const key = transition.from + '\u0000' + transition.event
    const list = groups.get(key)
    if (list === undefined) groups.set(key, [transition])
    else list.push(transition)
  }
  const ambiguous: Array<{ from: string; event: string; to: string }> = []
  const overlapping: Array<{ from: string; event: string; to: string }> = []
  const inexhaustive: Array<{ from: string; event: string; to: string }> = []
  const probablyExhaustive: Array<{ from: string; event: string; to: string }> = []
  const complementary: string[] = []
  for (const group of groups.values()) {
    const unguarded = group.filter((transition) => transition.guard === undefined)
    const guarded = group.filter((transition) => transition.guard !== undefined)
    if (unguarded.length > 1) {
      for (const transition of unguarded) ambiguous.push({ from: transition.from, event: transition.event, to: transition.to })
    }
    const seenGuards = new Map<string, TransitionSpec>()
    for (const transition of guarded) {
      const text = guardText(transition.guard as GuardNode)
      const previous = seenGuards.get(text)
      if (previous !== undefined) overlapping.push({ from: transition.from, event: transition.event, to: transition.to })
      else seenGuards.set(text, transition)
    }
    if (guarded.length > 0 && unguarded.length === 0) {
      const row = { from: group[0].from, event: group[0].event, to: group[0].to }
      // A complementary pair on one variable (`x < 3` / `x >= 3`) is exhaustive for
      // any valuation, so the structural warning would be a false alarm there. The
      // pair test is deliberately narrow — it cannot prove exhaustiveness, only
      // recognise the common shape, which is why the finding stays on the report at
      // info severity and still routes to S6.
      const witness = complementaryVariable(guarded.map((transition) => transition.guard as GuardNode))
      if (witness === undefined) inexhaustive.push(row)
      else { probablyExhaustive.push(row); complementary.push(witness) }
    }
  }
  if (ambiguous.length > 0) {
    findings.push({
      code: 'UML004_AMBIGUOUS_BRANCH',
      severity: 'error',
      message: ambiguous.length + ' branch(es) share a (state, event) with no guard at all: the diagram shows two unconditional arrows for one event, which no reader can resolve.',
      transitions: ambiguous,
      detail: 'Keep one unguarded branch per (state, event) as the else case, and guard the others. logicprobe_verify S4 is the authoritative determinism check.',
    })
  }
  if (overlapping.length > 0) {
    findings.push({
      code: 'UML005_OVERLAPPING_GUARD',
      severity: 'warning',
      message: overlapping.length + ' transition(s) repeat a guard already used by another branch of the same (state, event).',
      transitions: overlapping,
    })
  }
  if (inexhaustive.length > 0) {
    findings.push({
      code: 'UML006_INEXHAUSTIVE_BRANCH',
      severity: 'warning',
      message: inexhaustive.length + ' (state, event) group(s) have only guarded branches and no default: if every guard is false the flow vanishes, and the diagram still implies coverage.',
      transitions: inexhaustive,
      detail: 'Add an unguarded else branch, or confirm exhaustiveness with logicprobe_verify S6 (which evaluates guards over real valuations).',
    })
  }
  if (probablyExhaustive.length > 0) {
    findings.push({
      code: 'UML006_INEXHAUSTIVE_BRANCH',
      severity: 'info',
      message: probablyExhaustive.length + ' (state, event) group(s) have guards that look complementary on ' + [...new Set(complementary)].join(', ') + ', so they are probably exhaustive — but no default branch exists and only logicprobe_verify S6 can settle it.',
      transitions: probablyExhaustive,
    })
  }

  const eventsByReachable = new Set<string>()
  const eventsAnywhere = new Set<string>()
  for (const transition of model.transitions) {
    eventsAnywhere.add(transition.event)
    if (reachable.has(transition.from)) eventsByReachable.add(transition.event)
  }
  const deadEvents = [...eventsAnywhere].filter((event) => !eventsByReachable.has(event))
  if (deadEvents.length > 0) {
    findings.push({
      code: 'UML007_UNUSED_EVENT',
      severity: 'warning',
      message: deadEvents.length + ' event(s) only fire from states nothing can reach, so the diagram shows messages that never arrive.',
      events: deadEvents,
    })
  }

  const selfLoops = model.transitions.filter((transition) => transition.from === transition.to && transition.guard === undefined
    && (outgoing.get(transition.from) ?? []).length === 1)
  if (selfLoops.length > 0) {
    findings.push({
      code: 'UML008_SELF_LOOP_NO_EXIT',
      severity: 'warning',
      message: selfLoops.length + ' state(s) have a single unguarded self-loop and no exit: the flow can never leave, which the diagram presents as activity.',
      states: [...new Set(selfLoops.map((transition) => transition.from))],
      detail: 'logicprobe_verify S3 reports absorbing cycles (liveness).',
    })
  }

  const seenTransitions = new Map<string, number>()
  for (const transition of model.transitions) {
    const key = canonicalTransition(transition)
    seenTransitions.set(key, (seenTransitions.get(key) ?? 0) + 1)
  }
  const duplicates = model.transitions.filter((transition) => (seenTransitions.get(canonicalTransition(transition)) ?? 0) > 1)
  if (duplicates.length > 0) {
    findings.push({
      code: 'UML009_DUPLICATE_TRANSITION',
      severity: 'warning',
      message: duplicates.length + ' transition(s) duplicate an identical (from, event, guard, actions, to) row; the diagram draws the same arrow twice.',
      transitions: duplicates.map((transition) => ({ from: transition.from, event: transition.event, to: transition.to })),
    })
  }

  const guardVariables = new Set<string>()
  for (const transition of model.transitions) {
    if (transition.guard !== undefined) collectGuardVariables(transition.guard, guardVariables)
  }
  const updatedVariables = new Set<string>()
  for (const transition of model.transitions) for (const update of transition.updates ?? []) updatedVariables.add(update.variable)
  const unusedVariables = (model.variables ?? []).map((variable) => variable.name).filter((name) => !guardVariables.has(name) && !updatedVariables.has(name))
  if (unusedVariables.length > 0) {
    findings.push({
      code: 'UML010_UNUSED_VARIABLE',
      severity: 'warning',
      message: unusedVariables.length + ' variable(s) are never read by a guard and never written: the diagram carries a symbol with no source.',
      events: unusedVariables,
    })
  }
  const unbounded = (model.variables ?? []).filter((variable) => variable.kind === 'integer' && (variable.min === undefined || variable.max === undefined)).map((variable) => variable.name)
  if (unbounded.length > 0) {
    findings.push({
      code: 'UML011_UNBOUNDED_VARIABLE',
      severity: 'info',
      message: unbounded.length + ' integer variable(s) declare no min/max, so no range invariant can be checked and A5 boundary probing has no declared domain.',
      detail: unbounded.join(', '),
    })
  }

  const terminals = model.states.filter((state) => state.terminal === true).map((state) => state.id)
  if (terminals.length === 0) {
    findings.push({
      code: 'UML012_NO_TERMINAL',
      severity: 'warning',
      message: 'no state is terminal: the diagram has no `--> [*]`, so completion, failure and a stuck flow look the same.',
      detail: 'Mark absorbing states terminal, or state explicitly that the machine is non-terminating.',
    })
  }

  if (model.narrative === undefined) {
    findings.push({
      code: 'UML013_NO_NARRATIVE',
      severity: 'info',
      message: 'the model carries no narrative block: no state, event or scenario has a natural-language meaning, so a reader must re-derive every symbol from the source.',
      detail: 'Add narrative.states / narrative.events / narrative.scenarios — a partial narrative is valid and its coverage is reported; write the states first and fill the rest in later.',
    })
  } else {
    // A narrative that covers part of the model is valid: states first, events and
    // scenarios later is the natural authoring order. The gap is reported as coverage
    // (and as this info finding), never as a validation failure.
    const coverage = narrativeCoverageOf(model)
    if (coverage !== undefined && !narrativeComplete(coverage)) {
      findings.push({
        code: 'UML027_NARRATIVE_PARTIAL',
        severity: 'info',
        message: 'the narrative covers part of the model: states ' + coverage.states + ', events ' + coverage.events + ', scenarios ' + coverage.scenarios + '. Every uncovered symbol still has to be re-derived from the source.',
        detail: 'narrativeCoverage carries the same numbers; complete the missing entries when the behaviour settles.',
        evidence: { narrativeCoverage: coverage },
      })
    }
  }

  const documented = labels === undefined ? undefined : Object.keys(labels).filter((id) => documentedMeaning(labels[id], id) !== undefined)
  if (documented !== undefined) {
    const undocumented = model.states.map((state) => state.id).filter((id) => documentedMeaning(labels?.[id], id) === undefined)
    if (undocumented.length > 0) {
      findings.push({
        code: 'UML014_UNDOCUMENTED_STATE',
        severity: 'info',
        message: undocumented.length + ' of ' + String(model.states.length) + ' states carry no meaning in the diagram (they render as their bare id).',
        states: undocumented,
        detail: 'Give each state a `state "meaning" as ID` label or `ID : meaning` description so the diagram can be read against the code.',
      })
    }
    if (model.narrative?.states !== undefined) {
      const drift: string[] = []
      for (const state of model.states) {
        const meaning = documentedMeaning(labels?.[state.id], state.id)
        const declared = model.narrative.states[state.id]
        if (meaning !== undefined && declared !== undefined && meaning !== declared) drift.push(state.id + ': diagram "' + meaning + '" vs narrative "' + declared + '"')
      }
      if (drift.length > 0) {
        findings.push({
          code: 'UML015_LABEL_DRIFT',
          severity: 'warning',
          message: drift.length + ' state label(s) disagree with the model narrative: one of the two is stale, and the review cannot tell which.',
          detail: drift.join(' | '),
        })
      }
    }
  }

  if (warnings.length > 0) {
    findings.push({
      code: 'UML016_DIAGRAM_PARSE_NOTES',
      severity: 'info',
      message: warnings.length + ' note(s) were produced while rendering or reading the diagram; they mark information the notation could not carry.',
      detail: warnings.join(' | '),
    })
  }

  return findings
}

function collectGuardVariables(guard: GuardNode, sink: Set<string>): void {
  if ('variable' in guard) { sink.add(guard.variable); return }
  if ('all' in guard) { for (const child of guard.all) collectGuardVariables(child, sink); return }
  if ('any' in guard) { for (const child of guard.any) collectGuardVariables(child, sink); return }
  collectGuardVariables(guard.not, sink)
}

/** Positive, conjunctively-reached leaves of a guard tree — the only ones a complementarity witness may use. */
function positiveLeaves(guard: GuardNode, sink: LeafGuard[]): void {
  if ('variable' in guard) { sink.push(guard); return }
  if ('all' in guard) { for (const child of guard.all) positiveLeaves(child, sink); return }
  // `any` and `not` subtrees are skipped on purpose: a leaf under a disjunction is
  // not implied by its branch, and `not (x < 3)` is `x >= 3` only for totally
  // ordered integers — neither is a sound complementarity witness.
}

const COMPLEMENTS: Array<[string, string]> = [['<', '>='], ['<=', '>'], ['==', '!=']]

/**
 * Name a variable whose guards contain a complementary pair (`x < 3` next to
 * `x >= 3`), which makes the branch group exhaustive for every valuation. Returns
 * undefined when no such pair exists — absence is not proof of a gap.
 */
function complementaryVariable(guards: GuardNode[]): string | undefined {
  const leaves: LeafGuard[] = []
  for (const guard of guards) positiveLeaves(guard, leaves)
  for (let i = 0; i < leaves.length; i += 1) {
    for (let j = i + 1; j < leaves.length; j += 1) {
      const left = leaves[i]
      const right = leaves[j]
      if (left.variable !== right.variable) continue
      if (left.value !== right.value) continue
      for (const [one, other] of COMPLEMENTS) {
        if ((left.op === one && right.op === other) || (left.op === other && right.op === one)) return left.variable
      }
    }
  }
  return undefined
}

function compiledModel(input: unknown): LogicModelV1 {
  const validation = validateModel(input)
  if (!validation.ok) throw new UmlError('model invalid: ' + validation.errors.join('; '))
  return validation.model
}

function roundTripOf(model: LogicModelV1, notation: UmlNotation, diagram: UmlDiagram, maxSteps: number): { report: UmlRoundTripReport; primary: string; parsed: UmlParseResult } {
  const rendered = renderUml(model, notation, diagram, maxSteps)
  const parsed = parseUml(rendered.primary, notation)
  const diffs = diffModels(model, parsed.model)
  return {
    report: {
      notation,
      diagram,
      ok: diffs.length === 0,
      hashSpec: DEFAULT_HASH_SPEC,
      modelHash: modelHash(model),
      parsedHash: modelHash(parsed.model),
      diffs,
      warnings: [...rendered.warnings, ...parsed.warnings],
    },
    primary: rendered.primary,
    parsed,
  }
}

/** Compare two machines by structure — the fidelity measure behind the round-trip check. */
export function diffModels(left: LogicModelV1, right: LogicModelV1): string[] {
  const diffs: string[] = []
  if (left.init !== right.init) diffs.push('init: ' + left.init + ' vs ' + right.init)
  const leftStates = left.states.map((state) => state.id)
  const rightStates = right.states.map((state) => state.id)
  for (const id of leftStates) if (!rightStates.includes(id)) diffs.push('state missing after parse: ' + id)
  for (const id of rightStates) if (!leftStates.includes(id)) diffs.push('state invented by the diagram: ' + id)
  const leftTerminal = left.states.filter((state) => state.terminal === true).map((state) => state.id).sort()
  const rightTerminal = right.states.filter((state) => state.terminal === true).map((state) => state.id).sort()
  if (leftTerminal.join(',') !== rightTerminal.join(',')) diffs.push('terminal states: [' + leftTerminal.join(', ') + '] vs [' + rightTerminal.join(', ') + ']')
  const leftTransitions = left.transitions.map(canonicalTransition).sort()
  const rightTransitions = right.transitions.map(canonicalTransition).sort()
  const leftCount = new Map<string, number>()
  for (const key of leftTransitions) leftCount.set(key, (leftCount.get(key) ?? 0) + 1)
  const rightCount = new Map<string, number>()
  for (const key of rightTransitions) rightCount.set(key, (rightCount.get(key) ?? 0) + 1)
  for (const [key, count] of leftCount) {
    const other = rightCount.get(key) ?? 0
    if (other < count) diffs.push('transition lost in the diagram (' + String(count - other) + 'x): ' + key.replace(/\|/g, ' '))
  }
  for (const [key, count] of rightCount) {
    const other = leftCount.get(key) ?? 0
    if (other < count) diffs.push('transition invented by the diagram (' + String(count - other) + 'x): ' + key.replace(/\|/g, ' '))
  }
  const leftVariables = (left.variables ?? []).map((variable) => variable.name + ':' + variable.kind).sort()
  const rightVariables = (right.variables ?? []).map((variable) => variable.name + ':' + variable.kind).sort()
  for (const name of leftVariables) if (!rightVariables.includes(name)) diffs.push('variable missing after parse: ' + name)
  for (const name of rightVariables) if (!leftVariables.includes(name)) diffs.push('variable invented by the diagram: ' + name)
  return diffs
}

export interface UmlReviewOptions {
  /** LogicModelV1 to review. Provide it, `diagram`, or both. */
  model?: unknown
  /** Diagram text: reviewed on its own, or compared against `model` when both are given. */
  diagram?: string
  notation?: UmlNotation | 'auto'
  diagramKind?: UmlDiagram
  /** Render-and-reparse fidelity check (default true; only meaningful with a model). */
  roundTrip?: boolean
  /** Cap on the sequence trace used for the fidelity check. */
  maxSteps?: number
}

/**
 * Review a UML model of a code flow.
 *
 * Three inputs are possible and each answers a different question:
 *
 * - `model` only — "is this machine well-modelled?" The review checks the
 *   structure the diagram would draw, then renders and re-parses it to prove the
 *   diagram carries the machine faithfully (round trip).
 * - `diagram` only — "what does this diagram actually say?" The diagram is parsed
 *   into a model, and that model is reviewed; nothing can be said about fidelity
 *   to a machine the caller did not provide.
 * - both — "does this diagram match this model?" Any structural difference is a
 *   modelling defect and is reported both as round-trip diffs and as a finding.
 */
export function reviewUml(options: UmlReviewOptions): UmlReviewReport {
  const warnings: string[] = []
  const findings: UmlFinding[] = []
  const hasModel = options.model !== undefined
  const hasDiagram = typeof options.diagram === 'string' && options.diagram.trim() !== ''
  if (!hasModel && !hasDiagram) throw new UmlError('review needs `model`, `diagram`, or both')

  let notation: UmlNotation = options.notation === undefined || options.notation === 'auto' ? 'mermaid' : options.notation
  const kind: UmlDiagram = options.diagramKind ?? 'state'
  let model: LogicModelV1 | undefined
  let labels: Record<string, string> | undefined
  let parsed: UmlParseResult | undefined
  let primary: string | undefined
  let roundTrip: UmlRoundTripReport | null = null
  const metadataKeys = metadataKeysOf(hasModel ? options.model : undefined)
  const metadata = metadataKeys.length === 0 ? {} : { metadataKeys }
  let discardedConstructs: DiscardedConstruct[] = []
  let discardedEdges = 0

  if (hasDiagram) {
    try {
      parsed = parseUml(options.diagram as string, options.notation ?? 'auto')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const unreadable: UmlFinding = { code: 'UML001_DIAGRAM_UNREADABLE', severity: 'error', message, detail: 'The diagram could not be read as a Mermaid/PlantUML state or activity diagram.' }
      return {
        ok: false,
        ran: true,
        ...verdictOfFindings([unreadable]),
        schema: REPORT_SCHEMAS.umlReview,
        source: hasModel ? 'model+diagram' : 'diagram',
        summary: { errors: 1, warnings: 0, info: 0, states: 0, events: 0, transitions: 0, terminalStates: 0, reachableStates: 0, documentedStates: 0 },
        findings: [unreadable],
        roundTrip: null,
        ...metadata,
        hashes: { hashSpec: DEFAULT_HASH_SPEC },
        warnings,
        nextSteps: ['Fix the diagram syntax (or render one from a model with logicprobe_uml action=render) and review again.'],
      }
    }
    notation = parsed.notation
    labels = parsed.labels
    warnings.push(...parsed.warnings)
    // A diagram from another family parses into something; that something must never
    // be read as a model of this file, so the parse defects are review findings here too.
    findings.push(...parseFindings(parsed))
    if (parsed.discardedConstructs.length > 0) {
      discardedConstructs = parsed.discardedConstructs
      discardedEdges = parsed.discardedEdges
    }
    if (hasModel) {
      model = compiledModel(options.model)
      const diffs = diffModels(model, parsed.model)
      roundTrip = {
        notation: parsed.notation,
        diagram: parsed.diagram,
        ok: diffs.length === 0,
        hashSpec: DEFAULT_HASH_SPEC,
        modelHash: modelHash(model),
        parsedHash: modelHash(parsed.model),
        diffs,
        warnings: [...parsed.warnings],
      }
      if (diffs.length > 0) {
        findings.push({
          code: 'UML017_ROUND_TRIP_MISMATCH',
          severity: 'error',
          message: 'the diagram does not carry the model it is presented with: ' + String(diffs.length) + ' structural difference(s).',
          detail: diffs.slice(0, 12).join(' | ') + (diffs.length > 12 ? ' | … ' + String(diffs.length - 12) + ' more' : ''),
        })
      }
      if (diffs.length === 0 && labels !== undefined && model.narrative === undefined) {
        warnings.push('UML_REVIEW_DIAGRAM_LABELS_IGNORED_BY_MODEL: the diagram carries state labels but the model has no narrative block, so the labels live only in the diagram.')
      }
    } else {
      model = parsed.model
      findings.push({
        code: 'UML018_FIDELITY_UNCHECKED',
        severity: 'info',
        message: 'only a diagram was supplied, so the review reads the diagram as the model: nothing here proves the diagram matches the code it claims to describe.',
        detail: 'Compare the parsed model against the code (each state/event/guard needs a source citation), or pass the machine alongside the diagram to check the two against each other.',
      })
    }
  } else {
    model = compiledModel(options.model)
    // A sequence view is a trace, so parsing it back would drop every branch the
    // walk never took: the fidelity check cannot apply to it, and pretending it did
    // would either fail spuriously or hide the difference. Render it anyway (the
    // caller asked for that view) and say the check does not apply.
    if (kind === 'sequence') {
      try {
        const rendered = renderUml(model, notation, kind, options.maxSteps ?? 60)
        primary = rendered.primary
        warnings.push(...rendered.warnings)
      } catch (error) {
        warnings.push('UML_REVIEW_RENDER_SKIPPED: ' + (error instanceof Error ? error.message : String(error)))
      }
      findings.push({
        code: 'UML019_ROUND_TRIP_SKIPPED',
        severity: 'warning',
        message: 'a sequence view is one trace, not a restatement of the machine, so the render/parse fidelity check does not apply to it; render diagram "state" or "activity" to have the diagram checked against the model.',
      })
    } else if (options.roundTrip !== false) {
      try {
        const rendered = roundTripOf(model, notation, kind, options.maxSteps ?? 60)
        primary = rendered.primary
        roundTrip = rendered.report
        warnings.push(...rendered.report.warnings)
        if (!rendered.report.ok) {
          findings.push({
            code: 'UML017_ROUND_TRIP_MISMATCH',
            severity: 'error',
            message: 'the rendered diagram does not read back as the model: ' + String(rendered.report.diffs.length) + ' structural difference(s).',
            detail: rendered.report.diffs.slice(0, 12).join(' | '),
          })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        warnings.push('UML_REVIEW_ROUND_TRIP_SKIPPED: ' + message)
        findings.push({
          code: 'UML019_ROUND_TRIP_SKIPPED',
          severity: 'warning',
          message: 'the fidelity check could not run for ' + notation + '/' + kind + ': ' + message,
        })
      }
    } else {
      findings.push({
        code: 'UML019_ROUND_TRIP_SKIPPED',
        severity: 'warning',
        message: 'the fidelity check was switched off (roundTrip=false); nothing here proves the diagram carries the model.',
      })
    }
  }

  findings.push(...structuralFindings(model, labels, warnings))
  const errors = findings.filter((finding) => finding.severity === 'error').length
  const warningCount = findings.filter((finding) => finding.severity === 'warning').length
  const info = findings.filter((finding) => finding.severity === 'info').length
  const reachable = reachableStates(model)
  const documentedStates = labels === undefined
    ? (model.narrative?.states === undefined ? 0 : Object.keys(model.narrative.states).length)
    : Object.keys(labels).filter((id) => documentedMeaning(labels?.[id], id) !== undefined).length
  const events = new Set(model.transitions.map((transition) => transition.event))
  const narrativeCoverage = narrativeCoverageOf(model)
  const nextSteps: string[] = []
  if (errors > 0) nextSteps.push('Resolve the error findings first — a diagram that cannot be read (or that disagrees with its model) will mislead every later review.')
  if (findings.some((finding) => finding.code === 'UML_NOT_A_STATE_DIAGRAM')) nextSteps.push('This text is not a state or activity diagram: keep it as its own view and model the machine as a state/activity diagram before reviewing it.')
  nextSteps.push('Run logicprobe_verify on this model for the behavioural checks (S1-S8 structural, A1-A14 adversarial); the review above covers modelling, not behaviour.')
  if (model.narrative === undefined) nextSteps.push('Add narrative.states/events/scenarios so the diagram is readable against the code.')
  if (findings.some((finding) => finding.code === 'UML011_UNBOUNDED_VARIABLE')) nextSteps.push('Declare min/max (or boundaryChecks) before relying on A5 boundary probes.')
  return {
    ok: true,
    ran: true,
    ...verdictOfFindings(findings),
    schema: REPORT_SCHEMAS.umlReview,
    source: hasModel && hasDiagram ? 'model+diagram' : (hasDiagram ? 'diagram' : 'model'),
    summary: {
      errors,
      warnings: warningCount,
      info,
      states: model.states.length,
      events: events.size,
      transitions: model.transitions.length,
      terminalStates: model.states.filter((state) => state.terminal === true).length,
      reachableStates: reachable.size,
      documentedStates,
    },
    findings,
    roundTrip,
    ...(labels === undefined ? {} : { labels }),
    ...(hasDiagram ? { model } : {}),
    ...(primary === undefined ? {} : { primary }),
    ...metadata,
    ...(narrativeCoverage === undefined ? {} : { narrativeCoverage }),
    hashes: {
      hashSpec: DEFAULT_HASH_SPEC,
      ...(roundTrip === null ? {} : { modelHash: roundTrip.modelHash, parsedHash: roundTrip.parsedHash }),
    },
    ...(discardedConstructs.length === 0 ? {} : { discardedConstructs, discardedEdges }),
    warnings,
    nextSteps,
  }
}
