import { runDataVerification } from '../../lib/data-engine.js'

function assertNoUndefinedValues(value, path = 'root') {
  if (value === undefined) {
    throw new Error(`lossless JSON violation: undefined at ${path}`)
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoUndefinedValues(entry, `${path}[${index}]`))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      assertNoUndefinedValues(entry, `${path}.${key}`)
    }
  }
}

const validModel = {
  schemaVersion: 1,
  entities: [
    {
      name: 'User',
      fields: [
        { name: 'id', type: 'uuid', required: true },
        { name: 'email', type: 'string', required: true, unique: true },
      ],
      primaryKey: ['id'],
    },
  ],
}

function expectFinding(report, checkId, code) {
  const check = report.checks.find((entry) => entry.id === checkId)
  if (check === undefined) throw new Error('missing check ' + checkId)
  if (!check.findings.some((finding) => finding.code === code)) {
    throw new Error('missing finding ' + checkId + '/' + code + ' in ' + JSON.stringify(check.findings))
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

test('valid data model passes', () => {
  const report = runDataVerification(validModel)
  if (!report.ok) throw new Error('valid model should be ok')
  if (report.summary.errors !== 0) throw new Error('expected 0 errors, got ' + report.summary.errors)
  assertNoUndefinedValues(report)
})

test('DS/DA structural findings', () => {
  const model = {
    schemaVersion: 1,
    entities: [
      {
        name: 'User',
        fields: [
          { name: 'id', type: 'uuid', required: true, nullable: true },
          { name: 'age', type: 'integer', min: 10, max: 5 },
        ],
        primaryKey: ['id', 'missing'],
      },
    ],
  }
  const report = runDataVerification(model)
  if (!report.ok) throw new Error('model should validate')
  expectFinding(report, 'DS1', 'DS1_PRIMARY_KEY_MISSING')
  expectFinding(report, 'DS4', 'DS4_REQUIRED_NULLABLE')
  expectFinding(report, 'DS4', 'DS4_MIN_GT_MAX')
  expectFinding(report, 'DA1', 'DA1_NULL_ACCEPTED_ON_REQUIRED')
  expectFinding(report, 'DA3', 'DA3_NULLABLE_PRIMARY_KEY')
  assertNoUndefinedValues(report)
})

test('migration coverage requires mapping', () => {
  const before = {
    schemaVersion: 1,
    entities: [{ name: 'User', fields: [{ name: 'name', type: 'string', required: true }] }],
  }
  const after = {
    schemaVersion: 1,
    entities: [{ name: 'User', fields: [{ name: 'fullName', type: 'string', required: true }] }],
  }
  const report = runDataVerification(after, { beforeModel: before })
  expectFinding(report, 'DA5', 'DA5_FIELD_NOT_MIGRATED')
  expectFinding(report, 'DD1', 'DD1_FIELD_REMOVED')
  expectFinding(report, 'DD4', 'DD4_REQUIRED_FIELD_REMOVED')
  assertNoUndefinedValues(report)
})

test('field mapping satisfies migration coverage', () => {
  const before = {
    schemaVersion: 1,
    entities: [{ name: 'User', fields: [{ name: 'name', type: 'string', required: true }] }],
  }
  const after = {
    schemaVersion: 1,
    entities: [{ name: 'User', fields: [{ name: 'fullName', type: 'string', required: true }] }],
  }
  const report = runDataVerification(after, {
    beforeModel: before,
    fieldMapping: { 'User.name': 'User.fullName' },
  })
  const da5 = report.checks.find((check) => check.id === 'DA5')
  if (da5 === undefined || da5.findings.length !== 0) throw new Error('DA5 should pass with field mapping')
  const dd1 = report.checks.find((check) => check.id === 'DD1')
  if (dd1 === undefined || dd1.findings.length !== 0) throw new Error('DD1 should pass with field mapping')
  assertNoUndefinedValues(report)
})

test('copy consistency flags unmapped required target field', () => {
  const model = {
    schemaVersion: 1,
    entities: [
      { name: 'Source', fields: [{ name: 'a', type: 'string' }] },
      { name: 'Target', fields: [{ name: 'x', type: 'string', required: true }, { name: 'y', type: 'string', required: true }] },
    ],
  }
  const report = runDataVerification(model, {
    copyPairs: [{ id: 'c1', sourceEntity: 'Source', targetEntity: 'Target', mapping: { a: 'x' } }],
  })
  expectFinding(report, 'DA6', 'DA6_REQUIRED_TARGET_UNMAPPED')
  assertNoUndefinedValues(report)
})

test('rollback symmetry flags missing backup pair', () => {
  const model = {
    schemaVersion: 1,
    entities: [
      { name: 'Source', fields: [{ name: 'a', type: 'string' }] },
      { name: 'Target', fields: [{ name: 'x', type: 'string', required: true }] },
    ],
  }
  const report = runDataVerification(model, {
    copyPairs: [{ id: 'c1', sourceEntity: 'Source', targetEntity: 'Target', mapping: { a: 'x' } }],
  })
  expectFinding(report, 'DA7', 'DA7_NO_BACKUP_PAIR')
  assertNoUndefinedValues(report)
})

test('idempotent-copy requires copy pair', () => {
  const model = {
    schemaVersion: 1,
    entities: [
      { name: 'Source', fields: [{ name: 'a', type: 'string' }] },
      { name: 'Target', fields: [{ name: 'x', type: 'string', required: true }] },
    ],
    invariants: [
      { id: 'ic1', description: 'copy must be idempotent', kind: 'idempotent-copy', sourceEntity: 'Source', targetEntity: 'Target' },
    ],
  }
  const report = runDataVerification(model, { copyPairs: [] })
  expectFinding(report, 'DA8', 'DA8_COPY_PAIR_MISSING')
  assertNoUndefinedValues(report)
})

test('idempotent-migration with split transform warns', () => {
  const model = {
    schemaVersion: 1,
    entities: [
      { name: 'A', fields: [{ name: 'x', type: 'string' }] },
      { name: 'B', fields: [{ name: 'y', type: 'string' }] },
    ],
    invariants: [
      { id: 'im1', description: 'migration must be idempotent', kind: 'idempotent-migration', from: 'A.x', to: 'B.y' },
    ],
  }
  const report = runDataVerification(model, {
    migrationMappings: [{ from: 'A.x', to: 'B.y', transform: 'split' }],
  })
  expectFinding(report, 'DA8', 'DA8_NON_IDEMPOTENT_TRANSFORM')
  assertNoUndefinedValues(report)
})

if (failures > 0) {
  console.log('data engine tests failed:', failures)
  process.exit(1)
}
console.log('all data engine tests passed')
