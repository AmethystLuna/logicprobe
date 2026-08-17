/**
 * logicprobe — DeepSeek Harness native plugin for the Logic Probe toolbox.
 * Injects the session-start gate text (claim-verification doctrine, 1% Rule,
 * Red Flags, proactive suggestion) into the first model step of every agent
 * session, mirroring the SessionStart hook the Claude Code plugin installs.
 * The skill ships in this package's `skills/` directory and is registered at
 * apply time into dsh's `ctx.skills` registry through the standard filesystem
 * provider, so it appears in every session catalog without a manual copy step.
 *
 * Injection listens on agent/pre-step and appends the gate to the FIRST
 * model step that runs, once per session (guarded by the session's durable
 * history). Session-start inbox injection was dropped: a blank-session preset
 * switch (agentPreset.select -> recompose) can clear the inbox before the
 * first step, losing the gate for the whole session. The pre-step decision is
 * the durable path - anchored/bootstrap presets that strip first-step injected
 * reminders (skill catalog, AGENTS.md, gate plugins) simply defer this message
 * to the first step after their promotion, and the history guard re-injects it
 * there. The default gate text is the dsh-native adaptation of
 * `hooks/session-start-content.md`: behavior rules
 * (1% Rule / Red Flags / proactive suggestion) stay in sync, while
 * presentation is adapted to dsh's native skill catalog — the trigger list
 * lives in the skill description, not duplicated in the gate. Deployments
 * override via Config.
 *
 * @module logicprobe-dsh
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type { HostCordisInspectProviderRegistration } from '@deepseek-ai/dsh-cordis-host-runner'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'

export const name = 'logicprobe'

// Skills are contributed through the registry service, which dsh-base always
// mounts before bundle rows such as this one apply.
export const inject = ['skills']

// Absolute path of the package's shipped skills directory. `lib/index.js`
// lives one level below the package root, so `../skills` from the module URL
// lands on `<package>/skills` regardless of where the package was installed.
const SKILLS_DIR = fileURLToPath(new URL('../skills', import.meta.url))

const GATE_PLUGIN_ID = 'logicprobe'

const DEFAULT_GATE_CONTENT = `<EXTREMELY_IMPORTANT>
Plugin logicprobe is active. Documents are not truth — code is. Verify every verifiable claim before accepting or acting on any design.

**1% Rule**: If there is even a 1% chance the logicprobe skill applies — reviewing design documents, architecture specs, technical proposals, or refactoring plans that make claims about API names, file locations, enum values, mechanism feasibility, state machines, protocol logic, or behavioral guarantees ("always"/"never"/"guaranteed") — load it with the skill tool before responding. The cost of loading is trivial compared to the cost of a false claim.

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
  // Ship the bundled skill through the registry: reuse the standard
  // filesystem provider over this package's own `skills/` directory, so
  // catalog discovery, frontmatter parsing, and SKILL.md loading behave
  // exactly like project/user skills while the plugin stays self-contained.
  // Registration lands in the global registry layer (this row mounts at the
  // profile root), so every agent preset sees the skill. `registerProvider`
  // returns the effect disposer; its teardown unregisters and invalidates.
  ctx.skills.registerProvider((control) => {
    return new FileSystemSkillProvider(ctx, control, {
      providerName: 'logicprobe',
      includeDefaultRoots: false,
      customSkillDirs: [SKILLS_DIR],
    })
  })
  if (!config.enabled) return
  // Inject the gate once per session on the FIRST model step that runs,
  // instead of at session-start: session-start injection lands in the agent's
  // inbox, which a blank-session preset switch (agentPreset.select ->
  // recompose) can clear before the first step - the gate would then be lost
  // for the whole session. The pre-step decision is the durable path a
  // first-step injection takes: the gate is appended to the first step's
  // decision and enters session history there, so every later step (and a
  // resume) skips it. Anchored/bootstrap presets that strip first-step
  // injected reminders (skill catalog, AGENTS.md, gate plugins) simply defer
  // this message to the first step after their promotion - the history guard
  // re-injects it there, so the gate still lands exactly once per session.
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    registerProvider()
    if (gateInHistory(agent.session)) return decision
    return {
      kind: 'enter',
      messages: [...decision.messages, gateMessage(config.gateContent)],
    }
  })
}

/**
 * Whether the gate already entered this session's durable history. The
 * pre-step listener re-appends the gate until it does; once a step committed
 * it, every later step (and a resume of a session that kept it) skips the
 * injection. A session whose gate was dropped before any step ran (e.g. an
 * inbox cleared by a blank-session preset switch) simply re-injects on the
 * first step that runs.
 */
function gateInHistory(session: Session): boolean {
  return session.events.some((event) => {
    if (event.type !== 'user/message') return false
    const source = event.data.source
    return source.kind === 'plugin' && source.plugin === GATE_PLUGIN_ID
  })
}
