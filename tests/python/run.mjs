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

rmSync(tmpDir, { recursive: true, force: true })
if (failures > 0) { console.log('python parity failed:', failures); process.exit(1) }
console.log('all python parity checks passed')
