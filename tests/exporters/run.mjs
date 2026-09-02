import { exportModel } from '../../lib/exporters.js'
import { runVerification } from '../../lib/engine.js'

let failures = 0
function test(name, fn) { try { fn(); console.log('PASS', name) } catch (error) { failures += 1; console.log('FAIL', name, '-', error instanceof Error ? error.message : String(error)) } }

const model = {
  schemaVersion: 1, init: 'A',
  states: [{ id: 'A' }, { id: 'B', terminal: true }],
  variables: [{ name: 'retry', kind: 'integer', init: 0, min: 0, max: 3 }],
  transitions: [
    { from: 'A', event: 'go', to: 'B', guard: { variable: 'retry', op: '<', value: 2 }, updates: [{ variable: 'retry', op: 'inc' }], weight: 3 },
    { from: 'A', event: 'skip', to: 'B', weight: 1 },
  ],
  invariants: [
    { id: 'never-b', description: 'never in B', kind: 'never-states', states: ['B'] },
    { id: 'reach-b', description: '90% reach B', kind: 'probability', target: 'B', op: '>=', p: 0.9 },
  ],
}

test('source model still verifies (sanity)', () => { const r = runVerification(model); if (!r.ok) throw new Error('baseline model invalid') })

test('uppaal export shape', () => {
  const out = exportModel(model, 'uppaal')
  for (const needle of ['template LogicProbe', 'state A, B', 'init A', 'sync go!', 'guard retry < 2', 'assign retry := retry + 1', 'system LogicProbe']) {
    if (!out.primary.includes(needle)) throw new Error('missing ' + needle)
  }
  const q = out.extras?.queries ?? ''
  if (!q.includes('E<> LogicProbe.B') || !q.includes('A[] not LogicProbe.B')) throw new Error('queries missing')
  if (!out.warnings.some((w) => w.includes('probability'))) throw new Error('probability must be a warning in UPPAAL export')
})

test('tla export shape', () => {
  const out = exportModel(model, 'tla')
  for (const needle of ['---- MODULE LogicProbe ----', 'VARIABLES pc, retry', 'pc = "A"', 'retry = 0', 'Next ==', 'CheckSafety', 'notin']) {
    if (!out.primary.includes(needle)) throw new Error('missing ' + needle)
  }
})

test('prism export shape', () => {
  const out = exportModel(model, 'prism')
  const all = out.primary + (out.extras?.properties ?? '')
  for (const needle of ['dtmc', 'module LogicProbe', 'endmodule', 'label "target"', 'label "forbidden"', "(pc' = 1)", 'P>=0.9 [ F "target" ]']) {
    if (!all.includes(needle)) throw new Error('missing ' + needle)
  }
})

test('spin export shape', () => {
  const out = exportModel(model, 'spin')
  for (const needle of ['active proctype LogicProbe()', 'pc == 0', 'retry = retry + 1', 'pc = 1', 'goto done', 'done: skip']) {
    if (!out.primary.includes(needle)) throw new Error('missing ' + needle)
  }
  if (!(out.extras?.properties ?? '').includes('ltl safety')) throw new Error('never-states property missing from promela')
})

test('tla guard equality/inequality mapping', () => {
  const eq = { schemaVersion: 1, init: 'A', states: [{ id: 'A' }, { id: 'B', terminal: true }], variables: [{ name: 'k', kind: 'integer', init: 0, min: 0, max: 2 }], transitions: [{ from: 'A', event: 'go', to: 'B', guard: { variable: 'k', op: '==', value: 1 } }] }
  const outEq = exportModel(eq, 'tla')
  if (outEq.primary.includes(' == 1')) throw new Error('TLA guard must not use == (got: k == 1)')
  if (!outEq.primary.includes('k = 1')) throw new Error('TLA guard must use = for equality')
  const ne = { schemaVersion: 1, init: 'A', states: [{ id: 'A' }, { id: 'B', terminal: true }], variables: [{ name: 'k', kind: 'integer', init: 0, min: 0, max: 2 }], transitions: [{ from: 'A', event: 'go', to: 'B', guard: { variable: 'k', op: '!=', value: 1 } }] }
  const outNe = exportModel(ne, 'tla')
  if (!outNe.primary.includes('k /= 1')) throw new Error('TLA guard must use /= for inequality')
})

test('invalid model rejected', () => {
  let thrown = false
  try { exportModel({ schemaVersion: 1, init: 'X', states: [], transitions: [] }, 'tla') } catch (error) { thrown = String(error).includes('model invalid') }
  if (!thrown) throw new Error('expected model invalid error')
})

if (failures > 0) { console.log('exporters tests failed:', failures); process.exit(1) }
console.log('all exporter tests passed')
