import { Context } from '@deepseek-ai/cordis'

const ctx = new Context()
let toolsRegistered = 0
let promptContext
let inspectProvider
ctx.provide('skills', { registerProvider() { return () => {} } })
ctx.provide('tools', { register() { toolsRegistered += 1; return () => {} } })
ctx.provide('systemPrompt', { context(contribution) { promptContext = contribution; return () => {} } })
ctx.provide('cordisInspect', { register(provider) { inspectProvider = provider; return () => {} } })

const mod = await import('../lib/index.js')
mod.apply(ctx, { enabled: true, gateContent: 'GATE', interaction: 'follow-approval' })

if (toolsRegistered !== 4) throw new Error('expected four tool registrations, got ' + toolsRegistered)
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
if (status.engineSchemaVersion !== 1) throw new Error('inspect status engineSchemaVersion should be 1')
if (status.dataEngineSchemaVersion !== 1) throw new Error('inspect status dataEngineSchemaVersion should be 1')
if (status.interaction !== 'follow-approval') throw new Error('inspect status interaction mismatch')

console.log('PASS apply smoke: tool/inspect/system-prompt registrations and policy-aware text')
