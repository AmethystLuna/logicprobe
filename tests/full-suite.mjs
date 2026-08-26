import { runVerification } from '../lib/engine.js'
import { runDataVerification } from '../lib/data-engine.js'
import { runConcurrencyScan } from '../lib/concurrency.js'

let pass = 0
let fail = 0
function check(name, cond) {
  if (cond) {
    pass += 1
    console.log('PASS', name)
  } else {
    fail += 1
    console.log('FAIL', name)
  }
}
function hasFinding(report, checkId, code) {
  return report.checks.some((check) => check.id === checkId && check.findings.some((finding) => finding.code === code))
}

// ---------- State machine ----------
const orderBefore = {
  schemaVersion: 1, init: 'NEW',
  states: [{ id: 'NEW' }, { id: 'PAID' }, { id: 'SHIPPED' }, { id: 'DONE', terminal: true }, { id: 'CANCELLED', terminal: true }],
  transitions: [
    { from: 'NEW', event: 'pay', to: 'PAID' }, { from: 'PAID', event: 'ship', to: 'SHIPPED' }, { from: 'SHIPPED', event: 'deliver', to: 'DONE' },
    { from: 'NEW', event: 'cancel', to: 'CANCELLED' }, { from: 'PAID', event: 'cancel', to: 'CANCELLED' },
  ],
  invariants: [{ id: 'p', description: 'pay before shipped', kind: 'event-before-state', event: 'pay', state: 'SHIPPED' }],
}
const orderAfterVerify = {
  schemaVersion: 1, init: 'NEW',
  states: [{ id: 'NEW' }, { id: 'PAID' }, { id: 'VERIFY' }, { id: 'SHIPPED' }, { id: 'DONE', terminal: true }, { id: 'CANCELLED', terminal: true }],
  transitions: [
    { from: 'NEW', event: 'pay', to: 'PAID' }, { from: 'PAID', event: 'verify', to: 'VERIFY' }, { from: 'VERIFY', event: 'ship', to: 'SHIPPED' }, { from: 'SHIPPED', event: 'deliver', to: 'DONE' },
    { from: 'NEW', event: 'cancel', to: 'CANCELLED' }, { from: 'PAID', event: 'cancel', to: 'CANCELLED' },
  ],
  invariants: [{ id: 'p', description: 'pay before shipped', kind: 'event-before-state', event: 'pay', state: 'SHIPPED' }],
}
const orderRegression = {
  schemaVersion: 1, init: 'NEW',
  states: [{ id: 'NEW' }, { id: 'PAID' }, { id: 'SHIPPED' }, { id: 'DONE', terminal: true }, { id: 'CANCELLED', terminal: true }],
  transitions: [
    { from: 'PAID', event: 'ship', to: 'SHIPPED' }, { from: 'SHIPPED', event: 'deliver', to: 'DONE' },
    { from: 'NEW', event: 'cancel', to: 'CANCELLED' }, { from: 'PAID', event: 'cancel', to: 'CANCELLED' },
  ],
  invariants: [{ id: 'p', description: 'pay before shipped', kind: 'event-before-state', event: 'pay', state: 'SHIPPED' }],
}
const idemBad = { schemaVersion: 1, init: 'A', states: [{ id: 'A' }, { id: 'B' }, { id: 'C', terminal: true }], transitions: [{ from: 'A', event: 'tick', to: 'B' }, { from: 'B', event: 'tick', to: 'C' }], idempotentEvents: ['tick'] }
const idemOk = { schemaVersion: 1, init: 'A', states: [{ id: 'A' }, { id: 'B' }], transitions: [{ from: 'A', event: 'go', to: 'B' }, { from: 'A', event: 'noop', to: 'A' }, { from: 'B', event: 'noop', to: 'B' }], idempotentEvents: ['noop'] }
const monoBad = { schemaVersion: 1, init: 'A', states: [{ id: 'A' }, { id: 'B', terminal: true }], transitions: [{ from: 'A', event: 'bump', to: 'A', updates: [{ variable: 'count', op: 'inc' }] }, { from: 'A', event: 'lower', to: 'B', updates: [{ variable: 'count', op: 'dec' }] }], variables: [{ name: 'count', kind: 'integer', init: 0, monotonic: 'inc' }] }
const leadsBad = { schemaVersion: 1, init: 'A', states: [{ id: 'A' }, { id: 'B', terminal: true }, { id: 'C' }], transitions: [{ from: 'A', event: 'go', to: 'B' }, { from: 'A', event: 'loop', to: 'C' }, { from: 'C', event: 'loop', to: 'C' }], invariants: [{ id: 'l', description: 'leads', kind: 'leads-to', from: 'A', to: 'B' }] }
const seqBad = { schemaVersion: 1, init: 'A', states: [{ id: 'A' }, { id: 'B', terminal: true }], transitions: [{ from: 'A', event: 'b', to: 'B' }], invariants: [{ id: 's', description: 'seq', kind: 'sequence', events: ['a', 'b'] }] }
const atomBad = { schemaVersion: 1, init: 'A', states: [{ id: 'A' }, { id: 'B', terminal: true }], transitions: [{ from: 'A', event: 'write', to: 'B' }], invariants: [{ id: 'a', description: 'atomic', kind: 'atomicity', events: ['write'], commit: 'commit', rollback: 'rollback' }] }

check('SM D1-D4: added VERIFY detected as behavior delta', hasFinding(runVerification(orderAfterVerify, { beforeModel: orderBefore }), 'D1', 'D1_EVENT_DISABLED'))
const regReport = runVerification(orderRegression, { beforeModel: orderBefore })
check('SM D1-D4: removed pay detected as regression', hasFinding(regReport, 'D1', 'D1_EVENT_DISABLED') && hasFinding(regReport, 'D3', 'D3_REMOVED_EVENT'))
check('SM A8: non-idempotent tick detected', hasFinding(runVerification(idemBad), 'A8', 'A8_NOT_IDEMPOTENT'))
check('SM A8: noop idempotent passes', runVerification(idemOk).checks.find((c) => c.id === 'A8')?.findings.length === 0)
check('SM S8: monotonic decrease detected', hasFinding(runVerification(monoBad), 'S8', 'S8_MONOTONIC_DECREASE'))
check('SM A9: leads-to loop detected', hasFinding(runVerification(leadsBad), 'A9', 'A9_LEADS_TO_VIOLATION'))
check('SM A10: sequence violation detected', hasFinding(runVerification(seqBad), 'A10', 'A10_SEQUENCE_VIOLATION'))
check('SM A11: atomicity violation detected', hasFinding(runVerification(atomBad), 'A11', 'A11_ATOMICITY_VIOLATION'))

// ---------- Data model ----------
const ecommerce = {
  schemaVersion: 1,
  entities: [
    { name: 'Customer', fields: [{ name: 'id', type: 'uuid', required: true }, { name: 'email', type: 'string', required: true, unique: true }, { name: 'name', type: 'string', required: true }], primaryKey: ['id'] },
    { name: 'Product', fields: [{ name: 'id', type: 'uuid', required: true }, { name: 'sku', type: 'string', required: true, unique: true }, { name: 'price', type: 'number', required: true, min: 0 }], primaryKey: ['id'] },
    { name: 'Order', fields: [{ name: 'id', type: 'uuid', required: true }, { name: 'customerId', type: 'uuid', required: true, ref: 'Customer.id' }, { name: 'status', type: 'enum', required: true, enum: ['new', 'paid', 'shipped', 'cancelled'] }], primaryKey: ['id'] },
    { name: 'OrderItem', fields: [{ name: 'id', type: 'uuid', required: true }, { name: 'orderId', type: 'uuid', required: true, ref: 'Order.id' }, { name: 'productId', type: 'uuid', required: true, ref: 'Product.id' }, { name: 'quantity', type: 'integer', required: true, min: 1 }], primaryKey: ['id'] },
  ],
  relationships: [
    { fromEntity: 'Order', fromField: 'customerId', toEntity: 'Customer', toField: 'id', onDelete: 'restrict' },
    { fromEntity: 'OrderItem', fromField: 'orderId', toEntity: 'Order', toField: 'id', onDelete: 'cascade' },
    { fromEntity: 'OrderItem', fromField: 'productId', toEntity: 'Product', toField: 'id', onDelete: 'restrict' },
  ],
  invariants: [
    { id: 'e', description: 'email unique', kind: 'unique', entity: 'Customer', fields: ['email'] },
    { id: 'r', description: 'order ref', kind: 'referential-integrity', entity: 'Order', field: 'customerId', refEntity: 'Customer' },
  ],
  boundaryChecks: [{ entity: 'Product', field: 'price', values: [-1, 0, 999.99] }, { entity: 'OrderItem', field: 'quantity', values: [0, 1, 100] }],
}
const userBefore = { schemaVersion: 1, entities: [{ name: 'User', fields: [{ name: 'id', type: 'uuid', required: true }, { name: 'name', type: 'string', required: true }, { name: 'email', type: 'string', required: true, unique: true }], primaryKey: ['id'] }] }
const userAfter = { schemaVersion: 1, entities: [{ name: 'User', fields: [{ name: 'id', type: 'uuid', required: true }, { name: 'fullName', type: 'string', required: true }, { name: 'email', type: 'string', required: true, unique: true }], primaryKey: ['id'] }] }

check('DM DS/DA: e-commerce baseline ok', runDataVerification(ecommerce).ok && runDataVerification(ecommerce).summary.errors === 0)
check('DM DA5/DD: rename with mapping passes', runDataVerification(userAfter, { beforeModel: userBefore, fieldMapping: { 'User.name': 'User.fullName' } }).summary.errors === 0)
const userBad = runDataVerification(userAfter, { beforeModel: userBefore })
check('DM DA5/DD: rename without mapping fails', hasFinding(userBad, 'DA5', 'DA5_FIELD_NOT_MIGRATED') && hasFinding(userBad, 'DD4', 'DD4_REQUIRED_FIELD_REMOVED'))

const idemCopyMissing = { schemaVersion: 1, entities: [{ name: 'S', fields: [{ name: 'a', type: 'string' }] }, { name: 'T', fields: [{ name: 'x', type: 'string', required: true }] }], invariants: [{ id: 'ic', description: 'ic', kind: 'idempotent-copy', sourceEntity: 'S', targetEntity: 'T' }] }
check('DM DA8: idempotent-copy missing pair', hasFinding(runDataVerification(idemCopyMissing, { copyPairs: [] }), 'DA8', 'DA8_COPY_PAIR_MISSING'))

const monoData = { schemaVersion: 1, entities: [{ name: 'Source', fields: [{ name: 'v', type: 'integer', monotonic: 'dec' }] }, { name: 'Target', fields: [{ name: 'version', type: 'integer', monotonic: 'inc' }] }], invariants: [{ id: 'm', description: 'mono', kind: 'monotonic', entity: 'Target', field: 'version', direction: 'inc' }] }
check('DM DA9: opposite monotonic copy', hasFinding(runDataVerification(monoData, { copyPairs: [{ id: 'c1', sourceEntity: 'Source', targetEntity: 'Target', mapping: { v: 'version' } }] }), 'DA9', 'DA9_MONOTONIC_COPY_OPPOSITE'))

const seqData = { schemaVersion: 1, entities: [{ name: 'A', fields: [{ name: 'x', type: 'string' }] }], invariants: [{ id: 'sq', description: 'seq', kind: 'sequence', steps: ['c1', 'm1'] }] }
check('DM DA10: missing sequence step', hasFinding(runDataVerification(seqData, { copyPairs: [{ id: 'c1', sourceEntity: 'A', targetEntity: 'A', mapping: { x: 'x' } }] }), 'DA10', 'DA10_SEQUENCE_STEP_MISSING'))

const leadsData = { schemaVersion: 1, entities: [{ name: 'Job', fields: [{ name: 'status', type: 'enum', enum: ['pending', 'done'] }] }], invariants: [{ id: 'ld', description: 'leads', kind: 'leads-to', entity: 'Job', field: 'status', from: 'nope', to: 'done' }] }
check('DM DA11: leads-to bad enum', hasFinding(runDataVerification(leadsData), 'DA11', 'DA11_FROM_NOT_IN_ENUM'))

const atomData = { schemaVersion: 1, entities: [{ name: 'S', fields: [{ name: 'a', type: 'string' }] }, { name: 'T', fields: [{ name: 'x', type: 'string', required: true }] }], invariants: [{ id: 'at', description: 'atomic', kind: 'atomicity', steps: ['c1', 'm1'] }] }
const atomReport = runDataVerification(atomData, { copyPairs: [{ id: 'c1', sourceEntity: 'S', targetEntity: 'T', mapping: { a: 'x' } }], migrationMappings: [{ id: 'm1', from: 'S.a', to: 'T.x', transform: 'split' }], backupPairs: [] })
check('DM DA12: atomic copy no backup', hasFinding(atomReport, 'DA12', 'DA12_ATOMIC_COPY_NO_BACKUP'))
check('DM DA12: non-atomic transform', hasFinding(atomReport, 'DA12', 'DA12_NON_ATOMIC_TRANSFORM'))

// ---------- Concurrency scan ----------
const concAbs = runConcurrencyScan('This module is thread-safe and lock-free.')
check('CONC: absolute claims flagged', concAbs.findings.some((f) => f.code === 'CONCURRENCY_ABSOLUTE_CLAIM' && f.keyword === 'thread-safe') && concAbs.findings.some((f) => f.code === 'CONCURRENCY_ABSOLUTE_CLAIM' && f.keyword === 'lock-free'))
const concInt = runConcurrencyScan('The ISR is interrupt-safe and uses disable_irq/enable_irq.')
check('CONC: interrupt-safe absolute claim', concInt.findings.some((f) => f.code === 'CONCURRENCY_ABSOLUTE_CLAIM' && f.keyword === 'interrupt-safe'))
check('CONC: disable_irq keyword', concInt.findings.some((f) => f.code === 'CONCURRENCY_KEYWORD' && f.keyword === 'disable_irq'))
const concPlain = runConcurrencyScan('The migration copies users from source to target.')
check('CONC: plain sequential no findings', concPlain.findings.length === 0)

console.log(`\n===== FULL TEST SUMMARY: ${pass} passed, ${fail} failed =====`)
if (fail > 0) process.exit(1)
