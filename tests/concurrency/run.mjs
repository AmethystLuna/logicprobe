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

test('flags interrupt safety claims and IRQ keywords', () => {
  const report = runConcurrencyScan('The ISR is interrupt-safe and uses disable_irq/enable_irq.')
  const absolute = report.findings.filter((finding) => finding.code === 'CONCURRENCY_ABSOLUTE_CLAIM')
  if (!absolute.some((finding) => finding.keyword === 'interrupt-safe')) throw new Error('expected interrupt-safe absolute claim')
  const keywords = report.findings.filter((finding) => finding.code === 'CONCURRENCY_KEYWORD')
  if (!keywords.some((finding) => finding.keyword === 'disable_irq')) throw new Error('expected disable_irq keyword')
  assertNoUndefinedValues(report)
})

test('absolute claims carry dedicated-tool routing suggestions', () => {
  const report = runConcurrencyScan('This module is thread-safe. The ISR is interrupt-safe.')
  const absolute = report.findings.filter((finding) => finding.code === 'CONCURRENCY_ABSOLUTE_CLAIM')
  if (absolute.length === 0) throw new Error('expected absolute claims')
  for (const finding of absolute) {
    if (!Array.isArray(finding.suggestions) || finding.suggestions.length === 0) {
      throw new Error('absolute claim must carry suggestions, got ' + JSON.stringify(finding))
    }
  }
  const threadSafe = absolute.find((finding) => finding.keyword === 'thread-safe')
  if (threadSafe === undefined || !threadSafe.suggestions.some((s) => s.includes('TLA+'))) {
    throw new Error('thread-safe should suggest TLA+ among its routes')
  }
  const interruptSafe = absolute.find((finding) => finding.keyword === 'interrupt-safe')
  if (interruptSafe === undefined || !interruptSafe.suggestions.some((s) => s.includes('CBMC'))) {
    throw new Error('interrupt-safe should suggest CBMC among its routes')
  }
  const keywords = report.findings.filter((finding) => finding.code === 'CONCURRENCY_KEYWORD')
  for (const keyword of keywords) {
    if (keyword.suggestions !== undefined) throw new Error('keyword findings must not carry suggestions')
  }
  assertNoUndefinedValues(report)
})

if (failures > 0) {
  console.log('concurrency tests failed:', failures)
  process.exit(1)
}
console.log('all concurrency tests passed')
