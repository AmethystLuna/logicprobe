import { Context } from '@deepseek-ai/cordis'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import { Config } from '../lib/index.js'

const ctx = new Context()
let toolsRegistered = 0
let promptContext
let inspectProvider
ctx.provide('skills', { registerProvider() { return () => {} } })
ctx.provide('tools', { register() { toolsRegistered += 1; return () => {} } })
ctx.provide('systemPrompt', { context(contribution) { promptContext = contribution; return () => {} } })
ctx.provide('cordisInspect', { register(provider) { inspectProvider = provider; return () => {} } })

const mod = await import('../lib/index.js')
// Built through the real schema, as the Loader builds it: `enabled` is declared
// `.volatile()`, so `apply` receives a live reference, not a copied boolean.
const config = new Config({ enabled: true, gateContent: 'GATE', interaction: 'follow-approval' })
if (typeof config.enabled?.get !== 'function') {
  throw new Error('enabled is not a volatile reference; the Plugins page switch would have no field to edit')
}
mod.apply(ctx, config)

if (toolsRegistered !== 6) throw new Error('expected six tool registrations, got ' + toolsRegistered)
if (promptContext === undefined) throw new Error('system prompt context was not registered')
if (promptContext.name !== 'logicprobe:mode') throw new Error('unexpected context name: ' + promptContext.name)
if (promptContext.order !== 118) throw new Error('unexpected context order: ' + promptContext.order)

const sessionWithNever = { events: [{ type: 'approval/policy', data: { policy: 'never' } }] }
const autoText = promptContext.text({ agent: { session: sessionWithNever } })
if (!autoText.includes('logicprobe interaction=auto')) throw new Error('approval=never did not resolve interaction to auto')

const planSession = { events: [{ type: 'plan/mode', data: { active: true } }] }
const planText = promptContext.text({ agent: { session: planSession } })
if (!planText.includes('Plan mode active')) throw new Error('plan/mode active was not reflected in context text')

const status = await inspectProvider.query('status')
if (status.toolRegistered !== true) throw new Error('inspect status toolRegistered should be true')
if (status.dataToolRegistered !== true) throw new Error('inspect status dataToolRegistered should be true')
if (status.concurrencyToolRegistered !== true) throw new Error('inspect status concurrencyToolRegistered should be true')
if (status.composeToolRegistered !== true) throw new Error('inspect status composeToolRegistered should be true')
if (status.exportToolRegistered !== true) throw new Error('inspect status exportToolRegistered should be true')
if (status.umlToolRegistered !== true) throw new Error('inspect status umlToolRegistered should be true')
if (status.engineSchemaVersion !== 1) throw new Error('inspect status engineSchemaVersion should be 1')
if (status.dataEngineSchemaVersion !== 1) throw new Error('inspect status dataEngineSchemaVersion should be 1')
if (status.interaction !== 'follow-approval') throw new Error('inspect status interaction mismatch')
if (status.enabled !== true) throw new Error('inspect status enabled should read the live switch')

// The Plugins page writes through the settings service, which updates the
// volatile reference in place. The plugin must observe the new value without
// being remounted, which is what makes the switch live inside a session.
updateVolatile(config.enabled, createVolatile(false))
const toggled = await inspectProvider.query('status')
if (toggled.enabled !== false) throw new Error('the live switch did not reach the plugin')
if (toolsRegistered !== 6) throw new Error('toggling the switch must not disturb the verification tools')

console.log('PASS apply smoke: tool/inspect/system-prompt registrations, policy-aware text, and the live injection switch')
