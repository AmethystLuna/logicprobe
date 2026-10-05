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
function pythonCompose(files, rendezvous) {
  const args = ['compose', ...files]
  if (rendezvous) args.push('--rendezvous', rendezvous)
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

rmSync(tmpDir, { recursive: true, force: true })
if (failures > 0) { console.log('python parity failed:', failures); process.exit(1) }
console.log('all python parity checks passed')
