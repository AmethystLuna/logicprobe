/**
 * logicprobe — DeepSeek Harness native plugin for the Logic Probe toolbox.
 * Injects the session-start gate text (claim-verification doctrine, 1% Rule,
 * Red Flags, proactive suggestion) into the first model step of every agent
 * session, mirroring the SessionStart hook the Claude Code plugin installs.
 * The skill itself is discovered by dsh's `skill-filesystem` provider and
 * needs no code.
 *
 * Injection follows the mechanism of @deepseek-ai/dsh-agent-instructions:
 * fold the context message into the `agent/pre-step` waterfall decision so
 * the text enters durable context before the first request. The default
 * gate text is the dsh-shaped twin of `hooks/session-start-content.md` in
 * the plugin root — same content, with Claude tool names mapped to the dsh
 * catalog (`skill` tool, `exit_plan_mode`) — and stays in sync with it;
 * deployments override via Config.
 *
 * @module logicprobe-dsh
 */
import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
export const name = 'logicprobe';
const GATE_PLUGIN_ID = 'logicprobe';
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
</EXTREMELY_IMPORTANT>`;
export const Config = z.object({
    enabled: z.boolean().default(true),
    gateContent: z.string().default(DEFAULT_GATE_CONTENT),
});
function gateMessage(text) {
    return createUserMessage({
        content: [{ type: 'text', text }],
        // `form` omitted — an undeclared context is the documented default.
        source: { kind: 'plugin', plugin: GATE_PLUGIN_ID },
    });
}
function isGateMessage(message) {
    return message.source.kind === 'plugin' && message.source.plugin === GATE_PLUGIN_ID;
}
/**
 * Model-visible catalog entry (cordis_inspect_list / cordis_inspect_query):
 * lets the model read this plugin's runtime status without guessing. Mirrors
 * the registration pattern of the official dsh-tool-cordis host providers.
 */
function inspectProvider(config) {
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
                };
            }
            return null;
        },
    };
}
export function apply(ctx, config) {
    // Catalog visibility is optional: register only when the inspect registry
    // service is mounted (web profile), so headless assemblies without it keep
    // the gate injection working.
    const inspect = ctx.get('cordisInspect');
    if (inspect !== undefined) {
        ctx.effect(() => inspect.register(inspectProvider(config)), 'logicprobe: inspect provider');
    }
    if (!config.enabled)
        return;
    ctx.on('agent/pre-step', async ({ messages, step }, next) => {
        const decision = await next();
        // Gate only the first real step; a no-step first entry stays untouched.
        if (decision.kind === 'reject')
            return decision;
        if (step !== 1 || decision.messages.length === 0)
            return decision;
        // Never re-inject when the gate text is already in the batch.
        if (decision.messages.some(isGateMessage))
            return decision;
        const gate = gateMessage(config.gateContent);
        // Fold the gate right after the claimed batch, mirroring the ordering
        // dsh-agent-instructions uses (direct prompt first, driver context last).
        let lastClaimedIndex = -1;
        for (let i = 0; i < decision.messages.length; i++) {
            if (messages.includes(decision.messages[i]))
                lastClaimedIndex = i;
        }
        const entered = [...decision.messages];
        entered.splice(lastClaimedIndex + 1, 0, gate);
        return { kind: 'enter', messages: entered };
    });
}
