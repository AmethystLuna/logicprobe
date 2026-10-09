// Python-parity harness: the standalone python engine (skills/logicprobe/references/
// logicprobe-engine.py) must produce byte-identical verification reports, composition
// reports, and exporter output to the TypeScript engine. Every case SKIPs (exit 0) when
// python is unavailable on PATH (or LOGICPROBE_PYTHON points at a specific interpreter),
// mirroring tests/external/run.mjs.
import { readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runVerification, runCompositionVerification } from '../../lib/engine.js'
import { exportModel } from '../../lib/exporters.js'
import { renderUml, parseUml, reviewUml } from '../../lib/uml.js'

const python = process.env.LOGICPROBE_PYTHON || 'python'
const enginePath = fileURLToPath(new URL('../../skills/logicprobe/references/logicprobe-engine.py', import.meta.url))
const fixturesRoot = fileURLToPath(new URL('../engine/fixtures/', import.meta.url))
const examplesRoot = fileURLToPath(new URL('../../examples/', import.meta.url))
const tmpDir = join(tmpdir(), 'logicprobe-pypar-' + process.pid)
mkdirSync(tmpDir, { recursive: true })

let failures = 0

function pythonRun(args) {
  const r = spawnSync(python, [enginePath, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  // Exit code 2 is used for "report ok but errors>0"; parse stdout either way.
  let out = null
  try { out = JSON.parse(r.stdout || '') } catch (_) { /* leave null */ }
  return { code: r.status, out, stderr: (r.stderr || '').slice(0, 800) }
}

function deepDiff(a, b, at = '$') {
  if (a === b) return []
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return [at + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b)]
  }
  if (Array.isArray(a) !== Array.isArray(b)) return [at + ': array mismatch']
  if (Array.isArray(a)) {
    if (a.length !== b.length) return [at + ': length ' + a.length + ' vs ' + b.length]
    const out = []
    for (let i = 0; i < a.length; i++) out.push(...deepDiff(a[i], b[i], at + '[' + i + ']'))
    return out
  }
  const ak = Object.keys(a); const bk = Object.keys(b)
  if (ak.length !== bk.length) return [at + ': keys ' + ak.join(',') + ' vs ' + bk.join(',')]
  const out = []
  for (const k of ak) {
    if (!(k in b)) { out.push(at + '.' + k + ': missing in python'); continue }
    out.push(...deepDiff(a[k], b[k], at + '.' + k))
  }
  return out
}

function check(name, fn) {
  try { fn(); console.log('PASS', name) } catch (error) { failures += 1; console.log('FAIL', name, '-', error instanceof Error ? error.message : String(error)) }
}

function writeTmp(...models) {
  return models.map((m) => {
    const json = JSON.stringify(m)
    const h = createHash('sha1').update(json).digest('hex').slice(0, 12)
    const f = join(tmpDir, h + '.json')
    if (!fs_exists(f)) writeFileSync(f, json, 'utf8')
    return f
  })
}
const fsSeen = new Set()
function fs_exists(f) { if (fsSeen.has(f)) return true; try { readFileSync(f); fsSeen.add(f); return true } catch (_) { return false } }

// ---- availability gate ----
{
  const r = spawnSync(python, ['--version'], { stdio: 'ignore' })
  if (r.status !== 0) {
    console.log('SKIP python parity (python not found; set LOGICPROBE_PYTHON or install python on PATH)')
    rmSync(tmpDir, { recursive: true, force: true })
    process.exit(0)
  }
}

// ---- verify parity over all engine fixtures + examples ----
for (const f of readdirSync(fixturesRoot).filter((n) => n.endsWith('.json')).sort()) {
  check('verify ' + f, () => {
    const model = JSON.parse(readFileSync(fixturesRoot + f, 'utf8'))
    const expected = runVerification(model)
    const actual = pythonRun(['verify', fixturesRoot + f])
    if (!actual.out) throw new Error('python returned no JSON' + (actual.stderr ? ': ' + actual.stderr : ''))
    const diffs = deepDiff(expected, actual.out)
    if (diffs.length) throw new Error(diffs.slice(0, 6).join(' | '))
  })
}
for (const f of readdirSync(examplesRoot).filter((n) => n.endsWith('.json')).sort()) {
  check('verify example ' + f, () => {
    const text = readFileSync(examplesRoot + f, 'utf8')
    if (!text.includes('"transitions"')) return
    const model = JSON.parse(text)
    const expected = runVerification(model)
    const actual = pythonRun(['verify', examplesRoot + f])
    if (!actual.out) throw new Error('python returned no JSON')
    const diffs = deepDiff(expected, actual.out)
    if (diffs.length) throw new Error(diffs.slice(0, 6).join(' | '))
  })
}

// ---- exporter parity byte-for-byte ----
for (const f of readdirSync(fixturesRoot).filter((n) => n.endsWith('.json')).sort()) {
  const model = JSON.parse(readFileSync(fixturesRoot + f, 'utf8'))
  for (const fmt of ['uppaal', 'tla', 'prism', 'spin']) {
    check('export ' + f + ' -> ' + fmt, () => {
      let expected
      try { expected = exportModel(model, fmt) } catch (error) {
        const actual = pythonRun(['export', fixturesRoot + f, '--format', fmt])
        if (!actual.out || actual.out.ok !== false) throw new Error('TS threw but python did not: ' + error.message)
        return
      }
      const actual = pythonRun(['export', fixturesRoot + f, '--format', fmt])
      if (!actual.out) throw new Error('python returned no JSON')
      const diffs = deepDiff(expected, actual.out)
      if (diffs.length) throw new Error(diffs.slice(0, 6).join(' | '))
    })
  }
}

// ---- composition + regression + invalid parity ----
function pythonCompose(files, rendezvous, maxStates) {
  const args = ['compose', ...files]
  if (rendezvous) args.push('--rendezvous', rendezvous)
  if (maxStates) args.push('--max-states', String(maxStates))
  return pythonRun(args)
}

check('compose 2 machines', () => {
  const a = { schemaVersion: 1, init: 'A0', states: [{ id: 'A0' }, { id: 'A1' }, { id: 'A2', terminal: true }], transitions: [{ from: 'A0', event: 'x', to: 'A1' }, { from: 'A1', event: 'y', to: 'A2' }] }
  const b = { schemaVersion: 1, init: 'B0', states: [{ id: 'B0' }, { id: 'B1' }, { id: 'B2', terminal: true }], transitions: [{ from: 'B0', event: 'p', to: 'B1' }, { from: 'B1', event: 'q', to: 'B2' }] }
  const [fa, fb] = writeTmp(a, b)
  const expected = runCompositionVerification([a, b])
  const actual = pythonCompose([fa, fb])
  if (!actual.out) throw new Error('python returned no JSON')
  const diffs = deepDiff(expected, actual.out)
  if (diffs.length) throw new Error(diffs.slice(0, 6).join(' | '))
})
check('compose 3-machine rendezvous', () => {
  const mk = (p, evs) => ({ schemaVersion: 1, init: p + '0', states: [{ id: p + '0' }, { id: p + '1' }, { id: p + '2' }, { id: p + '3', terminal: true }], transitions: [{ from: p + '0', event: evs[0], to: p + '1' }, { from: p + '1', event: evs[1], to: p + '2' }, { from: p + '2', event: evs[2], to: p + '3' }] })
  const a = mk('A', ['start', 'req', 'ack']); const b = mk('B', ['req', 'ack', 'fin']); const c = mk('C', ['req', 'ack', 'fin'])
  const [fa, fb, fc] = writeTmp(a, b, c)
  const expected = runCompositionVerification([a, b, c], { rendezvous: ['req', 'ack'] })
  const actual = pythonCompose([fa, fb, fc], 'req,ack')
  if (!actual.out) throw new Error('python returned no JSON')
  const diffs = deepDiff(expected, actual.out)
  if (diffs.length) throw new Error(diffs.slice(0, 6).join(' | '))
})
check('compose fewer than two rejected', () => {
  const a = { schemaVersion: 1, init: 'A', states: [{ id: 'A' }], transitions: [] }
  const [fa] = writeTmp(a)
  const expected = runCompositionVerification([a])
  const actual = pythonCompose([fa])
  if (!actual.out) throw new Error('python returned no JSON')
  const diffs = deepDiff(expected, actual.out)
  if (diffs.length) throw new Error(diffs.slice(0, 6).join(' | '))
})
check('before/after regression parity', () => {
  const before = { schemaVersion: 1, init: 'INIT', states: [{ id: 'INIT' }, { id: 'ACTIVE', terminal: true }], transitions: [{ from: 'INIT', event: 'go', to: 'ACTIVE' }], invariants: [{ id: 'p', kind: 'event-before-state', description: 'go first', event: 'go', state: 'ACTIVE' }] }
  const after = { schemaVersion: 1, init: 'INIT', states: [{ id: 'INIT' }, { id: 'ACTIVE' }], transitions: [{ from: 'INIT', event: 'skip', to: 'ACTIVE' }] }
  const [fb, fa] = writeTmp(before, after)
  const expected = runVerification(after, { beforeModel: before })
  const actual = pythonRun(['verify', fa, '--before-model', fb])
  if (!actual.out) throw new Error('python returned no JSON')
  const diffs = deepDiff(expected, actual.out)
  if (diffs.length) throw new Error(diffs.slice(0, 6).join(' | '))
})
check('invalid model parity', () => {
  const bad = { schemaVersion: 2, init: 'A', states: [{ id: 'A', onEntry: [3] }], transitions: [{ from: 'A', event: 'e', to: 'NOPE' }] }
  const [f] = writeTmp(bad)
  const expected = runVerification(bad)
  const actual = pythonRun(['verify', f])
  if (!actual.out) throw new Error('python returned no JSON')
  const diffs = deepDiff(expected, actual.out)
  if (diffs.length) throw new Error(diffs.slice(0, 6).join(' | '))
})
// The target-set vocabulary of `leads-to` must reject the same malformed shapes in
// both engines, and with the same message: an empty set, a duplicated member, an
// unknown member and a non-array/non-string value.
for (const [label, to] of [['empty', []], ['duplicate', ['B', 'B']], ['unknown', ['B', 'C']], ['scalar', 5]]) {
  check('invalid leads-to target set parity: ' + label, () => {
    const bad = {
      schemaVersion: 1,
      init: 'A',
      states: [{ id: 'A' }, { id: 'B', terminal: true }],
      transitions: [{ from: 'A', event: 'go', to: 'B' }],
      invariants: [{ id: 'l', description: 'd', kind: 'leads-to', from: 'A', to }],
    }
    const [f] = writeTmp(bad)
    const expected = runVerification(bad)
    if (expected.ok) throw new Error('the model should have been rejected')
    const actual = pythonRun(['verify', f])
    if (!actual.out) throw new Error('python returned no JSON')
    const diffs = deepDiff(expected, actual.out)
    if (diffs.length) throw new Error(diffs.slice(0, 6).join(' | '))
  })
}

// Path-property invariants must reach D2 in both engines, with the same finding, the
// same reason and the same witness path. Only one pair per kind is needed here: the
// point is parity of the new dispatch, not the verdict, which tests/engine/run.mjs owns.
for (const [label, before, after] of [
  ['leads-to', {
    schemaVersion: 1, init: 'A', states: [{ id: 'A' }, { id: 'B', terminal: true }],
    transitions: [{ from: 'A', event: 'go', to: 'B' }],
    invariants: [{ id: 'inv', description: 'd', kind: 'leads-to', from: 'A', to: 'B' }],
  }, {
    schemaVersion: 1, init: 'A', states: [{ id: 'A' }, { id: 'B', terminal: true }],
    transitions: [{ from: 'A', event: 'go', to: 'B' }, { from: 'A', event: 'wait', to: 'A' }],
    invariants: [{ id: 'inv', description: 'd', kind: 'leads-to', from: 'A', to: 'B' }],
  }],
  ['sequence', {
    schemaVersion: 1, init: 'A', states: [{ id: 'A' }, { id: 'B' }, { id: 'C', terminal: true }],
    transitions: [{ from: 'A', event: 'a', to: 'B' }, { from: 'B', event: 'b', to: 'C' }],
    invariants: [{ id: 'inv', description: 'd', kind: 'sequence', events: ['a', 'b'] }],
  }, {
    schemaVersion: 1, init: 'A', states: [{ id: 'A' }, { id: 'B' }, { id: 'C', terminal: true }],
    transitions: [{ from: 'A', event: 'a', to: 'B' }, { from: 'B', event: 'b', to: 'C' }, { from: 'A', event: 'b', to: 'C' }],
    invariants: [{ id: 'inv', description: 'd', kind: 'sequence', events: ['a', 'b'] }],
  }],
  ['atomicity', {
    schemaVersion: 1, init: 'A', states: [{ id: 'A' }, { id: 'B' }, { id: 'C', terminal: true }],
    transitions: [{ from: 'A', event: 'write', to: 'B' }, { from: 'B', event: 'commit', to: 'C' }],
    invariants: [{ id: 'inv', description: 'd', kind: 'atomicity', events: ['write'], commit: 'commit', rollback: 'rollback' }],
  }, {
    schemaVersion: 1, init: 'A', states: [{ id: 'A' }, { id: 'B' }, { id: 'C', terminal: true }, { id: 'D', terminal: true }],
    transitions: [{ from: 'A', event: 'write', to: 'B' }, { from: 'B', event: 'commit', to: 'C' }, { from: 'B', event: 'leave', to: 'D' }],
    invariants: [{ id: 'inv', description: 'd', kind: 'atomicity', events: ['write'], commit: 'commit', rollback: 'rollback' }],
  }],
  ['budget', {
    schemaVersion: 1, init: 'A', states: [{ id: 'A' }, { id: 'B', terminal: true }],
    transitions: [{ from: 'A', event: 'go', to: 'B', cost: 5 }],
    invariants: [{ id: 'inv', description: 'd', kind: 'budget', budget: 10 }],
  }, {
    schemaVersion: 1, init: 'A', states: [{ id: 'A' }, { id: 'B', terminal: true }],
    transitions: [{ from: 'A', event: 'go', to: 'B', cost: 50 }],
    invariants: [{ id: 'inv', description: 'd', kind: 'budget', budget: 10 }],
  }],
  ['probability', {
    schemaVersion: 1, init: 'A', states: [{ id: 'A' }, { id: 'B', terminal: true }, { id: 'C', terminal: true }],
    transitions: [{ from: 'A', event: 'go', to: 'B', weight: 9 }, { from: 'A', event: 'go', to: 'C', weight: 1 }],
    invariants: [{ id: 'inv', description: 'd', kind: 'probability', target: 'B', op: '>=', p: 0.9 }],
  }, {
    schemaVersion: 1, init: 'A', states: [{ id: 'A' }, { id: 'B', terminal: true }, { id: 'C', terminal: true }],
    transitions: [{ from: 'A', event: 'go', to: 'B', weight: 1 }, { from: 'A', event: 'go', to: 'C', weight: 1 }],
    invariants: [{ id: 'inv', description: 'd', kind: 'probability', target: 'B', op: '>=', p: 0.9 }],
  }],
]) {
  check('path-property continuity parity: ' + label, () => {
    const [fb, fa] = writeTmp(before, after)
    const expected = runVerification(after, { beforeModel: before })
    const actual = pythonRun(['verify', fa, '--before-model', fb])
    if (!actual.out) throw new Error('python returned no JSON')
    const diffs = deepDiff(expected, actual.out)
    if (diffs.length) throw new Error(diffs.slice(0, 6).join(' | '))
  })
}

// ---- UML parity: render / parse / review (mirrors tests/uml/run.mjs) ----
// Every model that carries transitions is swept across both notations and all three
// diagram kinds. A diagram is rendered by the TypeScript side, written to a temp file
// (utf-8, so CJK narrative labels survive) and parsed back by python; the review runs
// model-only, diagram-only, against a matching diagram and against a mismatching one.
const umlTmpDir = join(tmpDir, 'uml')
mkdirSync(umlTmpDir, { recursive: true })
let umlSeq = 0
function writeDiagram(text) {
  umlSeq += 1
  const file = join(umlTmpDir, 'd' + umlSeq + '.txt')
  writeFileSync(file, text, 'utf8')
  return file
}

/** Same shape as the exporter check: a TypeScript throw must be a python `ok: false` (same message). */
function compareUml(tsProduce, pythonArgs) {
  const actual = pythonRun(pythonArgs)
  let expected
  try { expected = tsProduce() } catch (error) {
    if (!actual.out || actual.out.ok !== false) {
      throw new Error('TS threw but python did not: ' + (error instanceof Error ? error.message : String(error)))
    }
    const message = error instanceof Error ? error.message : String(error)
    if (actual.out.error !== message) {
      throw new Error('refusal message differs: TS "' + message + '" vs python ' + JSON.stringify(actual.out.error))
    }
    return
  }
  if (!actual.out) throw new Error('python returned no JSON' + (actual.stderr ? ': ' + actual.stderr : ''))
  const diffs = deepDiff(expected, actual.out)
  if (diffs.length) throw new Error(diffs.slice(0, 6).join(' | '))
}

const umlCorpus = []
for (const f of readdirSync(fixturesRoot).filter((n) => n.endsWith('.json')).sort()) {
  const text = readFileSync(fixturesRoot + f, 'utf8')
  if (!text.includes('"transitions"')) continue
  umlCorpus.push({ label: f, file: fixturesRoot + f, model: JSON.parse(text) })
}
for (const f of readdirSync(examplesRoot).filter((n) => n.endsWith('.json')).sort()) {
  const text = readFileSync(examplesRoot + f, 'utf8')
  if (!text.includes('"transitions"')) continue
  umlCorpus.push({ label: 'example ' + f, file: examplesRoot + f, model: JSON.parse(text) })
}

for (const entry of umlCorpus) {
  for (const notation of ['mermaid', 'plantuml']) {
    for (const kind of ['state', 'activity', 'sequence']) {
      check('uml render ' + entry.label + ' ' + notation + '/' + kind, () => {
        compareUml(() => renderUml(entry.model, notation, kind),
          ['uml-render', entry.file, '--notation', notation, '--diagram', kind])
      })
    }
    check('uml render ' + entry.label + ' ' + notation + '/sequence max-steps=2', () => {
      compareUml(() => renderUml(entry.model, notation, 'sequence', 2),
        ['uml-render', entry.file, '--notation', notation, '--diagram', 'sequence', '--max-steps', '2'])
    })
  }
  for (const notation of ['mermaid', 'plantuml']) {
    for (const kind of ['state', 'activity', 'sequence']) {
      if (notation === 'plantuml' && kind === 'activity') continue // renderUml refuses it: nothing to parse
      check('uml parse ' + entry.label + ' ' + notation + '/' + kind, () => {
        const text = renderUml(entry.model, notation, kind).primary
        compareUml(() => parseUml(text, notation), ['uml-parse', writeDiagram(text), '--notation', notation])
      })
    }
    check('uml parse auto ' + entry.label + ' ' + notation + '/state', () => {
      const text = renderUml(entry.model, notation, 'state').primary
      compareUml(() => parseUml(text), ['uml-parse', writeDiagram(text)])
    })
  }
  check('uml review ' + entry.label, () => {
    compareUml(() => reviewUml({ model: entry.model }), ['uml-review', '--model', entry.file])
  })
  check('uml review ' + entry.label + ' --no-round-trip', () => {
    compareUml(() => reviewUml({ model: entry.model, roundTrip: false }),
      ['uml-review', '--model', entry.file, '--no-round-trip'])
  })
  check('uml review ' + entry.label + ' plantuml/state', () => {
    compareUml(() => reviewUml({ model: entry.model, notation: 'plantuml', diagramKind: 'state' }),
      ['uml-review', '--model', entry.file, '--notation', 'plantuml', '--diagram-kind', 'state'])
  })
  check('uml review ' + entry.label + ' + diagram', () => {
    const text = renderUml(entry.model, 'mermaid', 'state').primary
    compareUml(() => reviewUml({ model: entry.model, diagram: text }),
      ['uml-review', '--model', entry.file, '--diagram', writeDiagram(text)])
  })
  check('uml review ' + entry.label + ' diagram only', () => {
    const text = renderUml(entry.model, 'mermaid', 'state').primary
    compareUml(() => reviewUml({ diagram: text }), ['uml-review', '--diagram', writeDiagram(text)])
  })
}

// Mismatching pairs: a diagram rendered from one machine reviewed against another.
for (let i = 0; i + 1 < umlCorpus.length && i < 2; i += 1) {
  const a = umlCorpus[i]
  const b = umlCorpus[i + 1]
  for (const [left, right] of [[a, b], [b, a]]) {
    check('uml review mismatch ' + left.label + ' vs diagram of ' + right.label, () => {
      const text = renderUml(right.model, 'mermaid', 'state').primary
      compareUml(() => reviewUml({ model: left.model, diagram: text }),
        ['uml-review', '--model', left.file, '--diagram', writeDiagram(text)])
    })
  }
}

// A sequence view is a trace: the fidelity check does not apply to it, the trace is
// still rendered (with its truncation warning when the max-steps cap bites) and
// roundTrip stays null. plantuml/activity keeps the ordinary render-inside-round-trip
// refusal path, and --max-steps now reaches the renderer on both sides.
for (const entry of umlCorpus) {
  check('uml review ' + entry.label + ' --diagram-kind sequence', () => {
    compareUml(() => reviewUml({ model: entry.model, diagramKind: 'sequence' }),
      ['uml-review', '--model', entry.file, '--diagram-kind', 'sequence'])
  })
  check('uml review ' + entry.label + ' --diagram-kind sequence --max-steps 1', () => {
    compareUml(() => reviewUml({ model: entry.model, diagramKind: 'sequence', maxSteps: 1 }),
      ['uml-review', '--model', entry.file, '--diagram-kind', 'sequence', '--max-steps', '1'])
  })
  check('uml review ' + entry.label + ' --diagram-kind sequence --no-round-trip', () => {
    compareUml(() => reviewUml({ model: entry.model, diagramKind: 'sequence', roundTrip: false }),
      ['uml-review', '--model', entry.file, '--diagram-kind', 'sequence', '--no-round-trip'])
  })
  check('uml review ' + entry.label + ' --max-steps 2', () => {
    compareUml(() => reviewUml({ model: entry.model, maxSteps: 2 }),
      ['uml-review', '--model', entry.file, '--max-steps', '2'])
  })
}
for (const entry of umlCorpus.slice(0, 2)) {
  check('uml review ' + entry.label + ' plantuml/activity refused', () => {
    compareUml(() => reviewUml({ model: entry.model, notation: 'plantuml', diagramKind: 'activity' }),
      ['uml-review', '--model', entry.file, '--notation', 'plantuml', '--diagram-kind', 'activity'])
  })
}

// Hand-written diagrams exercise the parser paths a generated file never reaches:
// inferred init, declared terminals, synthetic events, no-op/shim actions, `=` for
// `==`, keyword operators, notes, descriptions, subgraphs and composites.
const handWrittenDiagrams = [
  ['inferred init and a named synthetic event', [
    'stateDiagram-v2',
    '  [*] --> IDLE',
    '  IDLE --> BUSY : start',
    '  IDLE --> IDLE : tick',
    '  BUSY --> IDLE',
    '  BUSY --> [*]',
    '  IDLE : waiting for work',
  ].join('\n')],
  ['flowchart with init/terminal directives', [
    '%%logicprobe:init START',
    '%%logicprobe:terminal END',
    'flowchart TD',
    '  START["start"] --> WORK["work"]',
    '  WORK --> END["end"]',
    '  WORK --> WORK',
  ].join('\n')],
  ['several initial pseudostates', ['stateDiagram-v2', '  [*] --> A', '  [*] --> B', '  A --> B : go', '  B --> [*]'].join('\n')],
  ['guard operators, booleans and actions', [
    '%%logicprobe:uml v1 notation=mermaid diagram=state',
    '%%logicprobe:init A',
    '%%logicprobe:terminal C',
    '%%logicprobe:variable k integer',
    '%%logicprobe:variable armed boolean',
    'stateDiagram-v2',
    '  [*] --> A',
    '  A --> B : go [k < 3 && armed == true] / k := k + 1, armed := false',
    '  A --> C : go [not (k >= 3) or armed != false] / k++',
    '  B --> C : done [k = 3] / retry--',
  ].join('\n')],
  ['notes, descriptions and an ignored line', [
    'stateDiagram-v2',
    '  [*] --> A',
    '  state "Alpha" as A',
    '  A --> B : go',
    '  note right of A : documented state',
    '  B : terminal-ish',
    '  B --> [*]',
    '  this line is not a statement',
  ].join('\n')],
  ['composite and concurrency regions', [
    'stateDiagram-v2',
    '  [*] --> REGION {',
    '  state INNER {',
    '  }',
    '  --',
    '  REGION --> [*]',
  ].join('\n')],
  ['plantuml state diagram with aliases', [
    '@startuml',
    "'logicprobe:uml v1 notation=plantuml diagram=state",
    "'logicprobe:init has space",
    "'logicprobe:terminal done!",
    "'logicprobe:alias has_space has space",
    "'logicprobe:alias done_ done!",
    '[*] --> has_space',
    'state "has space" as has_space',
    'has_space --> done_ : finish [k <= 2]',
    'done_ --> [*]',
    '@enduml',
  ].join('\n')],
  ['sequenceDiagram is refused', ['sequenceDiagram', '  ENV->>M: go', '  Note over M: A -> B'].join('\n')],
  ['subgraph flattening', [
    '%%logicprobe:init A',
    'flowchart TD',
    '  subgraph one',
    '    A["a"] --> B{"b"}',
    '  end',
    '  B --> C(["c"])',
  ].join('\n')],
  ['unparseable guard', ['stateDiagram-v2', '  [*] --> A', '  A --> B : go [retry ~~ 3]', '  B --> [*]'].join('\n')],
]
for (const [label, text] of handWrittenDiagrams) {
  check('uml parse hand-written: ' + label, () => {
    compareUml(() => parseUml(text), ['uml-parse', writeDiagram(text)])
  })
  check('uml review hand-written diagram only: ' + label, () => {
    compareUml(() => reviewUml({ diagram: text }), ['uml-review', '--diagram', writeDiagram(text)])
  })
}

// Asking for nothing is refused by both sides, with the same message.
check('uml review with neither model nor diagram', () => {
  const actual = pythonRun(['uml-review'])
  if (!actual.out || actual.out.ok !== false || typeof actual.out.error !== 'string') {
    throw new Error('python did not refuse an empty review: ' + JSON.stringify(actual.out))
  }
  let message = ''
  try { reviewUml({}) } catch (error) { message = error instanceof Error ? error.message : String(error) }
  if (message !== actual.out.error) {
    throw new Error('refusal message differs: TS "' + message + '" vs python ' + JSON.stringify(actual.out.error))
  }
})

// An invalid model is refused by both sides before anything is rendered.
check('uml render refuses an invalid model', () => {
  const bad = { schemaVersion: 1, init: 'A', states: [{ id: 'A' }], transitions: [{ from: 'A', event: 'e', to: 'NOPE' }] }
  const [f] = writeTmp(bad)
  compareUml(() => renderUml(bad, 'mermaid', 'state'), ['uml-render', f])
})

// ---- report contract, metadata keys, hash specs and exit codes -------------
// The verdict/ran/hashSpec/metadataKeys contract and the `_`-metadata exemption must
// be identical on both sides, and the process exit code must follow the verdict: a
// report that ran and failed is a failure, whatever `ok` says.
const archivedModel = {
  schemaVersion: 1,
  init: 'A',
  states: [{ id: 'A', _note: 'power-on' }, { id: 'B', terminal: true }],
  transitions: [{ from: 'A', event: 'go', to: 'B' }],
  _source: 'docs/uml/order-service.model.json',
  _verified: { modelHash: '00000000000000000000000000000000000000000000000000000000deadbeef' },
}

check('metadata keys + hashSpec parity', () => {
  const [f] = writeTmp(archivedModel)
  const expected = runVerification(archivedModel)
  const actual = pythonRun(['verify', f])
  if (!actual.out) throw new Error('python returned no JSON')
  const diffs = deepDiff(expected, actual.out)
  if (diffs.length) throw new Error(diffs.slice(0, 6).join(' | '))
  if (JSON.stringify(actual.out.metadataKeys) !== JSON.stringify(['_source', '_verified', 'states[0]._note'])) {
    throw new Error('python metadataKeys: ' + JSON.stringify(actual.out.metadataKeys))
  }
  if (actual.out.hashSpec !== 'v1' || actual.out.verdict !== 'pass') throw new Error('python contract fields: ' + JSON.stringify(actual.out).slice(0, 200))
})

check('hashSpec v0 parity (legacy archived hashes)', () => {
  const [f] = writeTmp(archivedModel)
  const expected = runVerification(archivedModel, { hashSpec: 'v0' })
  const actual = pythonRun(['verify', f, '--hash-spec', 'v0'])
  if (!actual.out) throw new Error('python returned no JSON')
  const diffs = deepDiff(expected, actual.out)
  if (diffs.length) throw new Error(diffs.slice(0, 6).join(' | '))
  if (actual.out.modelHash === runVerification(archivedModel).modelHash) {
    throw new Error('v0 must differ from v1 while metadata is present')
  }
})

check('exit code follows the verdict, not ok', () => {
  const deadlocked = { schemaVersion: 1, init: 'A', states: [{ id: 'A' }], transitions: [] }
  const clean = { schemaVersion: 1, init: 'A', states: [{ id: 'A' }, { id: 'B', terminal: true }], transitions: [{ from: 'A', event: 'go', to: 'B' }] }
  const [fDead, fClean] = writeTmp(deadlocked, clean)
  const failed = pythonRun(['verify', fDead])
  if (failed.out?.ok !== true || failed.out?.verdict !== 'fail') throw new Error('expected ok:true with verdict fail')
  if (failed.code !== 2) throw new Error('a failed verification must exit 2, got ' + failed.code)
  const passed = pythonRun(['verify', fClean])
  if (passed.out?.verdict !== 'pass' || passed.code !== 0) throw new Error('expected exit 0 for pass, got ' + passed.code)
})

check('--hash-check answers for a published hash and for an unrecorded one', () => {
  const [f] = writeTmp(archivedModel)
  const published = runVerification(archivedModel).modelHash
  const hit = pythonRun(['verify', f, '--hash-check', published])
  if (!hit.out || hit.out.matches.join(',') !== 'v1' || hit.code !== 0) {
    throw new Error('a v1 hash must be recognised: ' + JSON.stringify(hit.out))
  }
  const miss = pythonRun(['verify', f, '--hash-check', '00000000000000000000000000000000000000000000000000000000deadbeef'])
  if (!miss.out || miss.out.matches.length !== 0 || miss.code !== 2) {
    throw new Error('an unrecorded hash must be reported as such: ' + JSON.stringify(miss.out))
  }
  if (!miss.out.verdictReason.includes('no published hash spec reproduces')) {
    throw new Error('the answer must be explicit: ' + miss.out.verdictReason)
  }
})

const structureDiagram = [
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

check('structure-diagram parse parity (discarded constructs are reported, not dropped)', () => {
  const expected = parseUml(structureDiagram)
  const actual = pythonRun(['uml-parse', writeDiagram(structureDiagram)])
  if (!actual.out) throw new Error('python returned no JSON')
  const diffs = deepDiff(expected, actual.out)
  if (diffs.length) throw new Error(diffs.slice(0, 6).join(' | '))
  if (actual.code !== 2) throw new Error('parsing a component diagram is an error, exit 2, got ' + actual.code)
})

check('structure-diagram review parity + failing exit code', () => {
  const expected = reviewUml({ diagram: structureDiagram })
  const actual = pythonRun(['uml-review', '--diagram', writeDiagram(structureDiagram)])
  if (!actual.out) throw new Error('python returned no JSON')
  const diffs = deepDiff(expected, actual.out)
  if (diffs.length) throw new Error(diffs.slice(0, 6).join(' | '))
  if (actual.out.verdict !== 'fail' || actual.code !== 2) throw new Error('expected verdict fail and exit 2')
})

check('another Mermaid family refusal parity', () => {
  const text = ['classDiagram', '  class OrderService', '  OrderService --> PaymentAdapter'].join('\n')
  const actual = pythonRun(['uml-parse', writeDiagram(text)])
  if (!actual.out || actual.out.ok !== false) throw new Error('python did not refuse the family')
  if (actual.out.errorCode !== 'UML_NOT_A_STATE_DIAGRAM') throw new Error('python errorCode: ' + actual.out.errorCode)
  let message = ''
  try { parseUml(text) } catch (error) { message = error instanceof Error ? error.message : String(error) }
  if (message !== actual.out.error) throw new Error('refusal message differs: TS "' + message + '" vs python ' + JSON.stringify(actual.out.error))
})

// ---- structure-diagram review parity ---------------------------------------
// A component diagram is a dependency graph: the parser, the six checks and the
// matrix semantics must be identical in both engines, including the exit code.
const { parseStructure, reviewStructure } = await import('../../lib/structure.js')

const structurePuml = [
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

const structureMatrix = {
  rules: [
    { id: 'R1-app-may-use-hal', source: 'SVC', allow: ['PAY'], deny: ['DRV'] },
    { id: 'R2-adapter-owns-hal', source: 'PAY', allow: ['DRV'], deny: ['SVC'] },
    { id: 'R3-no-back-edges', source: '*', deny: ['SVC'] },
    { id: 'R4-persistence-required', source: 'PAY', allow: ['DB'], require: true },
    { id: 'R5-ghost-required', source: 'SVC', allow: ['NOPE'], require: true },
  ],
  layers: [{ name: 'app', members: ['SVC', 'PAY'] }, { name: 'hal', members: ['DRV'] }],
  default: 'deny',
}

check('structure parse parity', () => {
  const expected = parseStructure(structurePuml)
  const actual = pythonRun(['structure', writeDiagram(structurePuml)])
  if (!actual.out) throw new Error('python returned no JSON')
  const diffs = deepDiff(expected, actual.out.graph)
  if (diffs.length) throw new Error(diffs.slice(0, 6).join(' | '))
})

check('structure review parity without a matrix', () => {
  const expected = reviewStructure({ diagram: structurePuml })
  const actual = pythonRun(['structure', writeDiagram(structurePuml)])
  if (!actual.out) throw new Error('python returned no JSON')
  const diffs = deepDiff(expected, actual.out)
  if (diffs.length) throw new Error(diffs.slice(0, 6).join(' | '))
  if (actual.code !== 2) throw new Error('a structural error must exit 2, got ' + actual.code)
})

check('structure review parity with a matrix (rules, layers, deny, required edges)', () => {
  const [matrixFile] = writeTmp(structureMatrix)
  const expected = reviewStructure({ diagram: structurePuml, matrix: structureMatrix })
  const actual = pythonRun(['structure', writeDiagram(structurePuml), '--matrix', matrixFile])
  if (!actual.out) throw new Error('python returned no JSON')
  const diffs = deepDiff(expected, actual.out)
  if (diffs.length) throw new Error(diffs.slice(0, 6).join(' | '))
  if (actual.out.verdict !== 'fail' || actual.code !== 2) throw new Error('expected verdict fail and exit 2')
  if (actual.out.summary.disallowedEdges !== expected.summary.disallowedEdges) throw new Error('disallowedEdges differ')
  if (actual.out.summary.missingExpectedEdges !== 1) throw new Error('the unsatisfiable required rule must be reported')
})

check('structure matrix-invalid parity', () => {
  const [matrixFile] = writeTmp({ rules: [{ id: 'R', sorce: 'A' }] })
  const expected = reviewStructure({ diagram: structurePuml, matrix: { rules: [{ id: 'R', sorce: 'A' }] } })
  const actual = pythonRun(['structure', writeDiagram(structurePuml), '--matrix', matrixFile])
  if (!actual.out) throw new Error('python returned no JSON')
  const diffs = deepDiff(expected, actual.out)
  if (diffs.length) throw new Error(diffs.slice(0, 6).join(' | '))
  // The structural findings come first; MATRIX_INVALID must be among them, and no rule
  // may have been applied.
  if (!actual.out.findings.some((finding) => finding.code === 'MATRIX_INVALID')) {
    throw new Error('expected MATRIX_INVALID in ' + JSON.stringify(actual.out.findings.map((finding) => finding.code)))
  }
  if (actual.out.edgeVerdicts.some((verdict) => verdict.basis !== 'default')) throw new Error('an invalid matrix must apply no rule')
})

check('structure mermaid class-diagram parity', () => {
  const text = ['classDiagram', '  class OrderService', '  class PaymentAdapter', '  OrderService --> PaymentAdapter : uses'].join('\n')
  const expected = reviewStructure({ diagram: text })
  const actual = pythonRun(['structure', writeDiagram(text)])
  if (!actual.out) throw new Error('python returned no JSON')
  const diffs = deepDiff(expected, actual.out)
  if (diffs.length) throw new Error(diffs.slice(0, 6).join(' | '))
})

// ---- baseline diff parity --------------------------------------------------
// "Violations must not increase" must be computed the same way in both engines: the
// stable identity, the delta verdict, the exit code, and the self-diff of zero.
const { diffReports } = await import('../../lib/baseline.js')

check('baseline self-diff parity: the same report adds nothing', () => {
  const model = { schemaVersion: 1, init: 'A', states: [{ id: 'A' }, { id: 'B', terminal: true }], transitions: [{ from: 'A', event: 'go', to: 'B' }] }
  const [f] = writeTmp(model)
  const baselineRun = pythonRun(['verify', f])
  if (!baselineRun.out) throw new Error('python returned no JSON')
  const baselineFile = join(tmpDir, 'baseline-good.json')
  writeFileSync(baselineFile, JSON.stringify(baselineRun.out), 'utf8')
  const expected = diffReports(baselineRun.out, baselineRun.out)
  const actual = pythonRun(['verify', f, '--baseline', baselineFile])
  if (!actual.out) throw new Error('python returned no JSON')
  const diffs = deepDiff(expected, actual.out)
  if (diffs.length) throw new Error(diffs.slice(0, 6).join(' | '))
  if (actual.out.verdict !== 'pass' || actual.out.summary.added !== 0 || actual.code !== 0) {
    throw new Error('a self-baseline must add nothing and exit 0: ' + JSON.stringify(actual.out.summary))
  }
})

check('baseline new-error parity: a new error fails the delta and exits 2', () => {
  const good = { schemaVersion: 1, init: 'A', states: [{ id: 'A' }, { id: 'B', terminal: true }], transitions: [{ from: 'A', event: 'go', to: 'B' }] }
  const bad = { schemaVersion: 1, init: 'A', states: [{ id: 'A' }], transitions: [] }
  const [fg, fb] = writeTmp(good, bad)
  const baselineRun = pythonRun(['verify', fg])
  const baselineFile = join(tmpDir, 'baseline-new-error.json')
  writeFileSync(baselineFile, JSON.stringify(baselineRun.out), 'utf8')
  const currentRun = pythonRun(['verify', fb])
  const expected = diffReports(baselineRun.out, currentRun.out)
  const actual = pythonRun(['verify', fb, '--baseline', baselineFile])
  if (!actual.out) throw new Error('python returned no JSON')
  const diffs = deepDiff(expected, actual.out)
  if (diffs.length) throw new Error(diffs.slice(0, 6).join(' | '))
  if (actual.out.verdict !== 'fail' || actual.out.summary.addedErrors !== 1 || actual.code !== 2) {
    throw new Error('a new error must fail the delta and exit 2: ' + JSON.stringify(actual.out))
  }
  if (actual.out.currentVerdict !== 'fail') throw new Error('the absolute verdict must stay visible')
})

check('baseline structure parity (a new isolated node is a new warning)', () => {
  const diagram = ['@startuml', 'component [A] as A', 'component [B] as B', 'A --> B', '@enduml'].join('\n')
  const withOrphan = ['@startuml', 'component [A] as A', 'component [B] as B', 'component [C] as C', 'A --> B', '@enduml'].join('\n')
  const baselineFile = join(tmpDir, 'baseline-structure.json')
  const baselineRun = pythonRun(['structure', writeDiagram(diagram)])
  writeFileSync(baselineFile, JSON.stringify(baselineRun.out), 'utf8')
  const currentRun = pythonRun(['structure', writeDiagram(withOrphan)])
  const expected = diffReports(baselineRun.out, currentRun.out)
  const actual = pythonRun(['structure', writeDiagram(withOrphan), '--baseline', baselineFile])
  if (!actual.out) throw new Error('python returned no JSON')
  const diffs = deepDiff(expected, actual.out)
  if (diffs.length) throw new Error(diffs.slice(0, 6).join(' | '))
  if (actual.out.verdict !== 'pass_with_findings' || actual.code !== 0) {
    throw new Error('a new warning is pass_with_findings and exits 0: ' + actual.out.verdict)
  }
})

// Composition explainability must match too: the per-machine deadlock census, the
// rendezvous reason and the truncation caveat are part of the report contract.
check('compose C1 per-machine census parity', () => {
  const stuck = { schemaVersion: 1, init: 'S', states: [{ id: 'S' }], transitions: [] }
  const waiter = { schemaVersion: 1, init: 'W0', states: [{ id: 'W0' }, { id: 'W1', terminal: true }], transitions: [{ from: 'W0', event: 'req', to: 'W1' }] }
  const partner = { schemaVersion: 1, init: 'P0', states: [{ id: 'P0' }, { id: 'P1', terminal: true }], transitions: [{ from: 'P0', event: 'other', to: 'P1' }] }
  const [fs, fw, fp] = writeTmp(stuck, waiter, partner)
  const expected = runCompositionVerification([stuck, waiter, partner], { rendezvous: ['req'] })
  const actual = pythonCompose([fs, fw, fp], 'req')
  if (!actual.out) throw new Error('python returned no JSON')
  const diffs = deepDiff(expected, actual.out)
  if (diffs.length) throw new Error(diffs.slice(0, 6).join(' | '))
  const c1 = actual.out.checks.find((check) => check.id === 'C1').findings[0]
  if (!c1.detail.includes('rendezvous-needs-partner')) throw new Error('python must name the reason: ' + c1.detail)
  if (c1.evidence.perMachine.length !== 3) throw new Error('python must census every machine')
})

check('compose C2 reason + truncation caveat parity', () => {
  // Same shape as the engine fixture: one machine with no transitions, one that declares
  // the handshake alone, one that walks away — and a cap small enough to truncate.
  const stuck = { schemaVersion: 1, init: 'S', states: [{ id: 'S' }], transitions: [] }
  const waiter = { schemaVersion: 1, init: 'W0', states: [{ id: 'W0' }, { id: 'W1', terminal: true }], transitions: [{ from: 'W0', event: 'req', to: 'W1' }] }
  const partner = { schemaVersion: 1, init: 'P0', states: [{ id: 'P0' }, { id: 'P1', terminal: true }], transitions: [{ from: 'P0', event: 'other', to: 'P1' }] }
  const [fs, fw, fp] = writeTmp(stuck, waiter, partner)
  const expected = runCompositionVerification([stuck, waiter, partner], { rendezvous: ['req'], maxStates: 1 })
  const actual = pythonCompose([fs, fw, fp], 'req', 1)
  if (!actual.out) throw new Error('python returned no JSON')
  const diffs = deepDiff(expected, actual.out)
  if (diffs.length) throw new Error(diffs.slice(0, 6).join(' | '))
  if (actual.out.summary.truncated !== true) throw new Error('python must report the cap')
  const req = actual.out.checks.find((check) => check.id === 'C2').findings.find((finding) => finding.evidence.event === 'req')
  if (req === undefined) throw new Error('python must report the req handshake')
  if (!req.message.includes('artefact of the cap')) throw new Error('python must caveat a truncated result: ' + req.message)
})

// ---- multi-granularity parity ----------------------------------------------
// The manifest-based CLI must produce the same refinement report as the inline API,
// including the per-pair expansion/invention table and the diagram hashes.
const { reviewGranularity } = await import('../../lib/granularity.js')

check('granularity parity (root + refined child)', () => {
  const puml = (...lines) => ['@startuml', ...lines, '@enduml'].join('\n')
  const root = puml('component [SVC] as SVC', 'component [PAY] as PAY', 'component [DB] as DB', 'SVC --> PAY', 'PAY --> DB')
  const child = puml('component [SVC] as SVC', 'component [PAY] as PAY', 'component [DB] as DB', 'component [Retry] as RETRY', 'SVC --> RETRY', 'RETRY --> PAY', 'PAY --> DB')
  const rootFile = writeDiagram(root)
  const childFile = writeDiagram(child)
  const manifest = join(tmpDir, 'granularity-manifest.json')
  writeFileSync(manifest, JSON.stringify({ diagrams: [
    { name: 'L0', file: rootFile.replaceAll('\\', '/') },
    { name: 'L1', file: childFile.replaceAll('\\', '/'), parent: 'L0' },
  ] }), 'utf8')
  const expected = reviewGranularity({ diagrams: [{ name: 'L0', diagram: root }, { name: 'L1', diagram: child, parent: 'L0' }] })
  const actual = pythonRun(['granularity', manifest])
  if (!actual.out) throw new Error('python returned no JSON' + (actual.stderr ? ': ' + actual.stderr : ''))
  const diffs = deepDiff(expected, actual.out)
  if (diffs.length) throw new Error(diffs.slice(0, 6).join(' | '))
  if (actual.out.verdict !== 'pass' || actual.code !== 0) throw new Error('a refinement passes and exits 0')
  if (actual.out.pairs[0].expandedEdges.length !== 1) throw new Error('the expansion must be reported')
})

check('granularity parity (invented edge fails)', () => {
  const puml = (...lines) => ['@startuml', ...lines, '@enduml'].join('\n')
  const root = puml('component [SVC] as SVC', 'component [PAY] as PAY', 'SVC --> PAY')
  const child = puml('component [SVC] as SVC', 'component [PAY] as PAY', 'SVC --> PAY', 'PAY --> SVC')
  const rootFile = writeDiagram(root)
  const childFile = writeDiagram(child)
  const manifest = join(tmpDir, 'granularity-manifest-bad.json')
  writeFileSync(manifest, JSON.stringify({ diagrams: [
    { name: 'L0', file: rootFile.replaceAll('\\', '/') },
    { name: 'L1', file: childFile.replaceAll('\\', '/'), parent: 'L0' },
  ] }), 'utf8')
  const expected = reviewGranularity({ diagrams: [{ name: 'L0', diagram: root }, { name: 'L1', diagram: child, parent: 'L0' }] })
  const actual = pythonRun(['granularity', manifest])
  if (!actual.out) throw new Error('python returned no JSON')
  const diffs = deepDiff(expected, actual.out)
  if (diffs.length) throw new Error(diffs.slice(0, 6).join(' | '))
  if (actual.out.verdict !== 'fail' || actual.code !== 2) throw new Error('an invented dependency fails and exits 2')
})

// ---- label explanation parity ----------------------------------------------
// `--explain-labels` documents what the parser expects; the text is part of the
// contract, so both engines must print the same thing.
const { explainLabels } = await import('../../lib/uml.js')

check('--explain-labels parity (mermaid and plantuml)', () => {
  for (const notation of ['mermaid', 'plantuml']) {
    const expected = explainLabels(notation)
    const actual = pythonRun(['uml-review', '--explain-labels', '--notation', notation])
    if (!actual.out) throw new Error('python returned no JSON for ' + notation)
    const diffs = deepDiff(expected, actual.out)
    if (diffs.length) throw new Error(notation + ': ' + diffs.slice(0, 5).join(' | '))
    if (actual.code !== 0) throw new Error('--explain-labels must exit 0')
  }
})

rmSync(tmpDir, { recursive: true, force: true })
if (failures > 0) { console.log('python parity failed:', failures); process.exit(1) }
console.log('all python parity checks passed')
