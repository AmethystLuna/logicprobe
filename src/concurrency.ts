export interface ConcurrencyFinding {
  code: 'CONCURRENCY_KEYWORD' | 'CONCURRENCY_ABSOLUTE_CLAIM'
  severity: 'warning' | 'error'
  message: string
  line?: number
  snippet?: string
  keyword: string
}

export interface ConcurrencyScanReport {
  ok: boolean
  findings: ConcurrencyFinding[]
  summary: {
    lines: number
    keywords: number
    absoluteClaims: number
    warnings: number
    errors: number
  }
}

interface KeywordRule {
  pattern: RegExp
  label: string
  absolute: boolean
}

const KEYWORD_RULES: KeywordRule[] = [
  { pattern: /\bthread\s*-?\s*safe\b/i, label: 'thread-safe', absolute: true },
  { pattern: /\block\s*-?\s*free\b/i, label: 'lock-free', absolute: true },
  { pattern: /\bwait\s*-?\s*free\b/i, label: 'wait-free', absolute: true },
  { pattern: /\bno\s+data\s+race\b/i, label: 'no data race', absolute: true },
  { pattern: /\brace\s*-?\s*free\b/i, label: 'race-free', absolute: true },
  { pattern: /\bdata\s+race\b/i, label: 'data race', absolute: false },
  { pattern: /\brace\s+condition\b/i, label: 'race condition', absolute: false },
  { pattern: /\bthread\s*-?\s*safety\b/i, label: 'thread safety', absolute: false },
  { pattern: /\bconcurrent\b/i, label: 'concurrent', absolute: false },
  { pattern: /\bparallel\b/i, label: 'parallel', absolute: false },
  { pattern: /\bmulti-?threaded\b/i, label: 'multi-threaded', absolute: false },
  { pattern: /\bmultithreaded\b/i, label: 'multithreaded', absolute: false },
  { pattern: /\batomic\b/i, label: 'atomic', absolute: false },
  { pattern: /\bsynchronized\b/i, label: 'synchronized', absolute: false },
  { pattern: /\bmutex\b/i, label: 'mutex', absolute: false },
  { pattern: /\bsemaphore\b/i, label: 'semaphore', absolute: false },
  { pattern: /\bspinlock\b/i, label: 'spinlock', absolute: false },
  { pattern: /\bshared\s+variable\b/i, label: 'shared variable', absolute: false },
  { pattern: /\bshared\s+memory\b/i, label: 'shared memory', absolute: false },
  { pattern: /\bglobal\s+state\b/i, label: 'global state', absolute: false },
  { pattern: /\breentrant\b/i, label: 'reentrant', absolute: false },
  { pattern: /\binterrupt\s*-?\s*safe\b/i, label: 'interrupt-safe', absolute: true },
  { pattern: /\bISR\s*-?\s*safe\b/i, label: 'ISR-safe', absolute: true },
  { pattern: /\binterrupt\s+safety\b/i, label: 'interrupt safety', absolute: false },
  { pattern: /\binterrupt\s+context\b/i, label: 'interrupt context', absolute: false },
  { pattern: /\bISR\b/i, label: 'ISR', absolute: false },
  { pattern: /\bIRQ\b/i, label: 'IRQ', absolute: false },
  { pattern: /\bNMI\b/i, label: 'NMI', absolute: false },
  { pattern: /\bcritical\s+section\b/i, label: 'critical section', absolute: false },
  { pattern: /\bdisable_irq\b/i, label: 'disable_irq', absolute: false },
  { pattern: /\benable_irq\b/i, label: 'enable_irq', absolute: false },
  { pattern: /\bspin_lock_irqsave\b/i, label: 'spin_lock_irqsave', absolute: false },
]

export function runConcurrencyScan(text: string): ConcurrencyScanReport {
  const lines = text.split(/\r?\n/)
  const findings: ConcurrencyFinding[] = []
  const seen = new Set<string>()
  lines.forEach((line, index) => {
    const lineNumber = index + 1
    const lower = line.toLowerCase()
    for (const rule of KEYWORD_RULES) {
      if (!rule.pattern.test(line)) continue
      const key = rule.label + ':' + lineNumber
      if (seen.has(key)) continue
      seen.add(key)
      const finding: ConcurrencyFinding = {
        code: rule.absolute ? 'CONCURRENCY_ABSOLUTE_CLAIM' : 'CONCURRENCY_KEYWORD',
        severity: rule.absolute ? 'error' : 'warning',
        message: rule.absolute
          ? 'Concurrency safety claim "' + rule.label + '" detected; this requires dedicated verification (TSan, model checker, or explicit proof).'
          : 'Concurrency-related term "' + rule.label + '" detected; review whether the plan addresses this risk.',
        line: lineNumber,
        snippet: line.trim().slice(0, 200),
        keyword: rule.label,
      }
      findings.push(finding)
    }
  })
  const errors = findings.filter((finding) => finding.severity === 'error').length
  const warnings = findings.filter((finding) => finding.severity === 'warning').length
  const absoluteClaims = findings.filter((finding) => finding.code === 'CONCURRENCY_ABSOLUTE_CLAIM').length
  return {
    ok: true,
    findings,
    summary: {
      lines: lines.length,
      keywords: findings.length,
      absoluteClaims,
      warnings,
      errors,
    },
  }
}
