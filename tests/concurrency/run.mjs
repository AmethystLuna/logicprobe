import { runConcurrencyScan } from '../../lib/concurrency.js'

function assertNoUndefinedValues(value, path = 'root') {
  if (value === undefined) throw new Error(`undefined at ${path}`)
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoUndefinedValues(entry, `${path}[${index}]`))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) assertNoUndefinedValues(entry, `${path}.${key}`)
  }
}

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

test('flags absolute concurrency claims and risk keywords', () => {
  const report = runConcurrencyScan('This module is thread-safe and lock-free. There may be a race condition in the shared buffer.')
  const absolute = report.findings.filter((finding) => finding.code === 'CONCURRENCY_ABSOLUTE_CLAIM')
  const keywords = report.findings.filter((finding) => finding.code === 'CONCURRENCY_KEYWORD')
  if (absolute.length === 0) throw new Error('expected absolute concurrency claims')
  if (keywords.length === 0) throw new Error('expected concurrency keywords')
  if (report.summary.errors === 0) throw new Error('expected errors for absolute claims')
  assertNoUndefinedValues(report)
})

test('plain text has no concurrency findings', () => {
  const report = runConcurrencyScan('The migration copies users from source to target.')
  if (report.findings.length !== 0) throw new Error('expected no findings, got ' + JSON.stringify(report.findings))
  assertNoUndefinedValues(report)
})

if (failures > 0) {
  console.log('concurrency tests failed:', failures)
  process.exit(1)
}
console.log('all concurrency tests passed')
