// External-tool end-to-end checks. Every case SKIPs (exit 0) when the tool is absent:
//   spin  -> LOGICPROBE_SPIN env or 'spin' on PATH
//   gcc   -> LOGICPROBE_GCC env or 'gcc' on PATH  (compiles the pan verifier)
// The exporter output (Promela + ltl) is fed to the real model checker and the
// verdict must match our engine's expected finding.
import { exportModel } from '../../lib/exporters.js'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const spin = process.env.LOGICPROBE_SPIN || 'spin'
const gcc = process.env.LOGICPROBE_GCC || 'gcc'
let failures = 0

/**
 * Probe whether an external tool can be invoked.
 *
 * The probe argument is a per-tool default because not every tool accepts the same
 * version flag — `spin` recognises `-V` but exits non-zero on `--version`, while `gcc`
 * is the other way round. Probing both with `--version` made a present `spin` look
 * absent, so the whole suite reported "spin not found" and silently skipped.
 *
 * @param bin  command name, or a path (then only existence is checked)
 * @param flag argv used to ask for the version (defaults to `--version`)
 */
function resolve(bin, flag = '--version') {
  if (bin.includes('/') || bin.includes('\\')) {
    return existsSync(bin) ? { ok: true, how: 'path' } : { ok: false, how: 'path' }
  }
  const r = spawnSync(bin, [flag], { stdio: 'ignore' })
  if (r.status === 0) return { ok: true, how: flag }
  if (r.error === undefined) return { ok: false, how: flag, present: true }
  return { ok: false, how: flag, present: false }
}

function run(bin, args, cwd) {
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8' })
  return (r.stdout || '') + (r.stderr || '')
}

function check(name, model, wantErrors) {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'logicprobe-spin-'))
    try {
      const out = exportModel(model, 'spin')
      const pml = out.primary + '\n' + (out.extras?.properties ?? '')
      writeFileSync(join(dir, 'model.pml'), pml, 'utf8')
      run(spin, ['-a', 'model.pml'], dir)
      run(gcc, ['-O2', '-o', 'pan', 'pan.c'], dir)
      const panOut = run(join(dir, 'pan'), ['-a', '-N', 'safety'], dir)
      const m = panOut.match(/errors:\s*(\d+)/)
      const errors = m ? Number(m[1]) : -1
      if (errors !== wantErrors) throw new Error('spin reported errors=' + errors + ', want ' + wantErrors + '; output: ' + panOut.slice(0, 300))
      console.log('PASS', name, '(spin errors=' + errors + ')')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  } catch (error) { failures += 1; console.log('FAIL', name, '-', error instanceof Error ? error.message : String(error)) }
}

const spinProbe = resolve(spin, '-V')
const gccProbe = resolve(gcc, '--version')

/**
 * Report whether a required external tool is unusable, distinguishing "not on PATH"
 * from "present but not identifiable" — conflating the two is what produced a
 * misleading "spin not found" while `spin` was installed the whole time.
 *
 * @returns true when the suite must skip
 */
function missing(label, bin, probe, envVar, hint) {
  if (probe.ok) return false
  if (probe.present === true) {
    console.log(`SKIP external spin end-to-end (${label} found at '${bin}' but '${bin} ${probe.how}' did not succeed, so it could not be identified)`)
  } else {
    console.log(`SKIP external spin end-to-end (${label} not found on PATH; set ${envVar} or ${hint})`)
  }
  return true
}

if (missing('spin', spin, spinProbe, 'LOGICPROBE_SPIN', 'install spin on PATH')) process.exit(0)
if (missing('gcc', gcc, gccProbe, 'LOGICPROBE_GCC', 'install gcc on PATH')) process.exit(0)

console.log('external spin detected:', spin, '(probe', spinProbe.how + ')', '| gcc:', gcc, '(probe', gccProbe.how + ')')

const violation = { schemaVersion: 1, init: 'A', states: [{ id: 'A' }, { id: 'B', terminal: true }], transitions: [{ from: 'A', event: 'go', to: 'B' }], invariants: [{ id: 'noA', kind: 'never-states', description: 'never A', states: ['A'] }] }
check('spin: never-states violated (A is initial)', violation, 1)

const passModel = { schemaVersion: 1, init: 'A', states: [{ id: 'A' }, { id: 'B', terminal: true }, { id: 'C' }], transitions: [{ from: 'A', event: 'go', to: 'B' }], invariants: [{ id: 'noC', kind: 'never-states', description: 'never C', states: ['C'] }] }
check('spin: never-states holds (C unreachable)', passModel, 0)

if (failures > 0) { console.log('external tests failed:', failures); process.exit(1) }
console.log('all external tests passed')
