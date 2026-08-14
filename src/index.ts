/**
 * logicprobe — DeepSeek Harness native plugin for the Logic Probe toolbox.
 * Injects the session-start gate text (claim-verification doctrine, 1% Rule,
 * Red Flags, proactive suggestion) into the first model step of every agent
 * session, mirroring the SessionStart hook the Claude Code plugin installs.
 * The skill itself is discovered by dsh's `skill-filesystem` provider and
 * needs no code.
 *
 * Injection listens on the official `agent/session-start` lifecycle event
 * (once before the first turn) and seeds the gate via `agent.inject`, so
 * the text enters durable context before the first request — the dsh-native
 * counterpart of the Claude SessionStart matcher (startup|clear|compact;
 * resume keeps the gate already in history). The default gate text is the
 * dsh-shaped twin of `hooks/session-start-content.md` in the plugin root —
 * same content, with Claude tool names mapped to the dsh catalog (`skill`
 * tool, `exit_plan_mode`) — and stays in sync with it; deployments override
 * via Config.
 *
 * @module logicprobe-dsh
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { HostCordisInspectProviderRegistration } from '@deepseek-ai/dsh-cordis-host-runner'

export const name = 'logicprobe'

const GATE_PLUGIN_ID = 'logicprobe'

const DEFAULT_GATE_CONTENT = `<EXTREMELY_IMPORTANT>
Plugin logicprobe is active. Documents are not truth — code is. Verify every verifiable claim before accepting or acting on any design.

**When to load** — load with the skill tool when:

- Reviewing design documents, architecture specs, technical proposals, or refactoring plans
- A plan makes claims about API names, file locations, enum values, or mechanism feasibility
- A plan contains state machines, protocol logic, or behavioral claims ("always"/"never"/"guaranteed") — the skill escalates to logic-primitive verification: an executable model with 7 structural checks + 7 adversarial probes
- A refactoring plan modifies state topology — the skill compares before/after models for behavioral regression detection

**1% Rule**: If there is even a 1% chance the skill applies to the task, invoke it before responding. The cost of loading is trivial compared to the cost of a false claim.

**Red Flags** — if you think any of these, STOP. You are rationalizing:

| You think | Reality |
|-----------|---------|
| "This plan is too simple to verify" | The skill auto-classifies depth (LIGHTWEIGHT / STANDARD / ESCALATED). You don't decide. |
| "I already know the file paths are correct" | Organic verification leaves no audit trail. Run Phase 0, append the "## Plan Verification" block. |
| "I'll verify while implementing" | Verification happens before implementation, not during. |
| "I can check this with reasoning alone" | Behavioral claims are verified with code/models, not intuition. One counter-example refutes a universal claim. |

**Proactive suggestion**: When a user asks code-level behavioral questions — "could this state machine deadlock", "is this retry limit safe", "check this timing sequence for bugs" — suggest logicprobe as an optional verification pass (do not auto-escalate).
</EXTREMELY_IMPORTANT>`

export interface Config {
  enabled: boolean
  gateContent: string
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  gateContent: z.string().default(DEFAULT_GATE_CONTENT),
})

function gateMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    // `form` omitted — an undeclared context is the documented default.
    source: { kind: 'plugin', plugin: GATE_PLUGIN_ID },
  })
}

/**
 * Model-visible catalog entry (cordis_inspect_list / cordis_inspect_query):
 * lets the model read this plugin's runtime status without guessing. Mirrors
 * the registration pattern of the official dsh-tool-cordis host providers.
 */
function inspectProvider(config: Config): HostCordisInspectProviderRegistration {
  return {
    manifest: {
      id: 'logicprobe',
      description: 'Session-start gate injection for the Logic Probe toolbox — folds the claim-verification doctrine (1% Rule / Red Flags / proactive suggestion) into the first model step of every agent session.',
      methods: [
        {
          name: 'status',
          description: 'Read whether the gate injection is active and how large the injected gate text is.',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
          outputSchema: {
            type: 'object',
            description: 'Gate-injection plugin status.',
            properties: {
              enabled: { type: 'boolean', description: 'Whether the gate folds into the first model step.' },
              gateContentLength: { type: 'integer', description: 'Length in characters of the injected gate text.' },
            },
            required: ['enabled', 'gateContentLength'],
            additionalProperties: false,
          },
        },
      ],
    },
    query: async (method) => {
      if (method === 'status') {
        return {
          enabled: config.enabled,
          gateContentLength: config.gateContent.length,
        }
      }
      return null
    },
  }
}

export function apply(ctx: Context, config: Config): void {
  // Catalog visibility is optional: register only when the inspect registry
  // service is mounted, so headless assemblies without it keep the gate
  // injection working. The registry may be provided AFTER this row applies
  // (base-bundle rows can mount later), so registration is retried on the
  // first agent/session-start — by then the app is fully booted.
  let providerRegistered = false
  const registerProvider = (): void => {
    if (providerRegistered) return
    const inspect = ctx.get('cordisInspect')
    if (inspect === undefined) return
    try {
      ctx.effect(() => inspect.register(inspectProvider(config)), 'logicprobe: inspect provider')
      providerRegistered = true
    } catch (err) {
      console.warn('[logicprobe] inspect provider registration failed', err)
    }
  }
  registerProvider()
  if (!config.enabled) return
  // Inject the gate exactly once per session lifecycle — the dsh-native
  // counterpart of the Claude SessionStart matcher (startup|clear|compact).
  // `agent.inject` seeds the message into the next step's claimed batch, so
  // it enters durable context before the first request. Resume is skipped:
  // the gate is already part of the resumed history.
  ctx.on('agent/session-start', ({ agent, source }) => {
    registerProvider()
    if (source === 'resume') return
    agent.inject(gateMessage(config.gateContent))
  })
}
