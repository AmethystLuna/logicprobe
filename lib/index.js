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
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem';
import { logicProbeVerifyTool } from './tool.js';
import { logicProbeDataModelVerifyTool, DATA_ENGINE_SCHEMA_VERSION } from './data-tool.js';
import { logicProbeConcurrencyScanTool } from './concurrency-tool.js';
import { logicProbeComposeTool } from './compose-tool.js';
import { logicProbeExportTool } from './export-tool.js';
import { ENGINE_SCHEMA_VERSION } from './engine.js';
export const name = 'logicprobe';
// Skills are contributed through the registry service, which dsh-base always
// mounts before bundle rows such as this one apply.
export const inject = ['skills'];
// Absolute path of the package's shipped skills directory. `lib/index.js`
// lives one level below the package root, so `../skills` from the module URL
// lands on `<package>/skills` regardless of where the package was installed.
const SKILLS_DIR = fileURLToPath(new URL('../skills', import.meta.url));
const GATE_PLUGIN_ID = 'logicprobe';
const DEFAULT_GATE_CONTENT = `<EXTREMELY_IMPORTANT>
Plugin logicprobe is active. Documents are not truth — code is. Verify every verifiable claim before accepting or acting on any design.

**1% Rule**: If there is even a 1% chance the logicprobe skill applies — reviewing design documents, architecture specs, technical proposals, or refactoring plans that make claims about API names, file locations, enum values, mechanism feasibility, state machines, protocol logic, data models, schema migrations, data invariants, or behavioral guarantees ("always"/"never"/"guaranteed") — load it with the skill tool before responding. The cost of loading is trivial compared to the cost of a false claim.

**Red Flags** — if you think any of these, STOP. You are rationalizing:

| You think | Reality |
|-----------|---------|
| "This plan is too simple to verify" | The skill auto-classifies depth (LIGHTWEIGHT / STANDARD / ESCALATED). You don't decide. |
| "I already know the file paths are correct" | Organic verification leaves no audit trail. Run Phase 0, append the "## Plan Verification" block. |
| "I'll verify while implementing" | Verification happens before implementation, not during. |
| "I can check this with reasoning alone" | Behavioral claims are verified with code/models, not intuition. One counter-example refutes a universal claim. |

**Native verification path**: In dsh, prefer the \`logicprobe_verify\` tool for state-machine checks and \`logicprobe_datamodel_verify\` for data-model/schema migration checks. Both support before/after regression and common domain constraints (idempotency, monotonic, sequence, leads-to, atomicity). Python harnesses remain the fallback for non-dsh hosts.

**Proactive suggestion**: When a user asks code-level behavioral questions — "could this state machine deadlock", "is this retry limit safe", "check this timing sequence for bugs", "is this migration non-breaking", "does this copy cover all required fields" — suggest logicprobe as an optional verification pass (do not auto-escalate).
</EXTREMELY_IMPORTANT>`;
export const Config = z.object({
    enabled: z.boolean().default(true),
    gateContent: z.string().default(DEFAULT_GATE_CONTENT),
    interaction: z.union(['ask', 'auto', 'follow-approval']).default('follow-approval'),
});
function gateMessage(text) {
    return createUserMessage({
        content: [{ type: 'text', text }],
        // `form` omitted — an undeclared context is the documented default.
        source: { kind: 'plugin', plugin: GATE_PLUGIN_ID },
    });
}
function readSessionEvents(session) {
    const source = session;
    if (typeof source.snapshotEvents === 'function') {
        const snapshot = source.snapshotEvents();
        if (Array.isArray(snapshot))
            return snapshot;
    }
    if (Array.isArray(source.events))
        return source.events;
    return [];
}
function lastApprovalPolicy(session) {
    const events = readSessionEvents(session);
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.type === 'approval/policy') {
            return event.data?.policy === 'never' ? 'never' : 'ask';
        }
    }
    return undefined;
}
function planModeActive(session) {
    const events = readSessionEvents(session);
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.type === 'plan/mode')
            return event.data?.active === true;
    }
    return false;
}
function resolveInteraction(config, session) {
    if (config.interaction === 'ask' || config.interaction === 'auto')
        return config.interaction;
    return lastApprovalPolicy(session) === 'never' ? 'auto' : 'ask';
}
function modeContextText(config, session) {
    const interaction = resolveInteraction(config, session);
    const lines = [
        'logicprobe: use `logicprobe_verify` for state machines and `logicprobe_datamodel_verify` for data models; both cover before/after regression and common domain constraints.',
        interaction === 'auto'
            ? 'logicprobe interaction=auto: do NOT call ask_user_question for model confirmation; run round-trip validation of the extracted transition table and mark the result UNCONFIRMED.'
            : 'logicprobe interaction=ask: show the extracted transition table and get user confirmation before running verification.',
    ];
    if (planModeActive(session)) {
        lines.push('Plan mode active: before exit_plan_mode, run logicprobe Phase 0 and append the "## Plan Verification" block to the plan file.');
    }
    return lines.join(' ');
}
/**
 * Model-visible catalog entry (cordis_inspect_list / cordis_inspect_query):
 * lets the model read this plugin's runtime status without guessing. Mirrors
 * the registration pattern of the official dsh-tool-cordis host providers.
 */
function inspectProvider(config, isToolRegistered, isDataToolRegistered, isConcurrencyToolRegistered, isComposeToolRegistered, isExportToolRegistered) {
    return {
        manifest: {
            id: 'logicprobe',
            description: 'Session-start gate injection and native verification tooling for the Logic Probe toolbox — folds the claim-verification doctrine (1% Rule / Red Flags / proactive suggestion) into the first model step of every agent session and registers the logicprobe_verify tool.',
            methods: [
                {
                    name: 'status',
                    description: 'Read gate injection status, interaction mode, tool registration state, and engine schema version.',
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
                            interaction: { type: 'string', enum: ['ask', 'auto', 'follow-approval'], description: 'Configured interaction mode. follow-approval resolves per session from approval/policy.' },
                            toolRegistered: { type: 'boolean', description: 'Whether the logicprobe_verify tool is registered on ctx.tools.' },
                            dataToolRegistered: { type: 'boolean', description: 'Whether the logicprobe_datamodel_verify tool is registered on ctx.tools.' },
                            concurrencyToolRegistered: { type: 'boolean', description: 'Whether the logicprobe_concurrency_scan tool is registered on ctx.tools.' },
                            composeToolRegistered: { type: 'boolean', description: 'Whether the logicprobe_compose_verify tool is registered on ctx.tools.' },
                            exportToolRegistered: { type: 'boolean', description: 'Whether the logicprobe_export tool is registered on ctx.tools.' },
                            engineSchemaVersion: { type: 'integer', description: 'Model schema version the bundled state-machine verification engine accepts.' },
                            dataEngineSchemaVersion: { type: 'integer', description: 'Model schema version the bundled data-model verification engine accepts.' },
                        },
                        required: ['enabled', 'gateContentLength', 'interaction', 'toolRegistered', 'dataToolRegistered', 'concurrencyToolRegistered', 'composeToolRegistered', 'exportToolRegistered', 'engineSchemaVersion', 'dataEngineSchemaVersion'],
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
                    interaction: config.interaction,
                    toolRegistered: isToolRegistered(),
                    dataToolRegistered: isDataToolRegistered(),
                    concurrencyToolRegistered: isConcurrencyToolRegistered(),
                    composeToolRegistered: isComposeToolRegistered(),
                    exportToolRegistered: isExportToolRegistered(),
                    engineSchemaVersion: ENGINE_SCHEMA_VERSION,
                    dataEngineSchemaVersion: DATA_ENGINE_SCHEMA_VERSION,
                };
            }
            return null;
        },
    };
}
export function apply(ctx, config) {
    // Optional services are registered opportunistically; base-bundle rows can
    // mount after this row applies, so registration is retried on the first
    // agent/pre-step — by then the app is fully booted.
    let providerRegistered = false;
    let toolRegistered = false;
    let dataToolRegistered = false;
    let concurrencyToolRegistered = false;
    let composeToolRegistered = false;
    let exportToolRegistered = false;
    let modeContextRegistered = false;
    const registerProvider = () => {
        if (providerRegistered)
            return;
        const inspect = ctx.get('cordisInspect');
        if (inspect === undefined)
            return;
        try {
            ctx.effect(() => inspect.register(inspectProvider(config, () => toolRegistered, () => dataToolRegistered, () => concurrencyToolRegistered, () => composeToolRegistered, () => exportToolRegistered)), 'logicprobe: inspect provider');
            providerRegistered = true;
        }
        catch (err) {
            console.warn('[logicprobe] inspect provider registration failed', err);
        }
    };
    const registerTool = () => {
        if (toolRegistered)
            return;
        const tools = ctx.get('tools');
        if (tools === undefined)
            return;
        try {
            ctx.effect(() => tools.register(logicProbeVerifyTool), 'logicprobe: verify tool');
            ctx.effect(() => tools.register(logicProbeDataModelVerifyTool), 'logicprobe: data verify tool');
            ctx.effect(() => tools.register(logicProbeConcurrencyScanTool), 'logicprobe: concurrency scan tool');
            ctx.effect(() => tools.register(logicProbeComposeTool), 'logicprobe: compose tool');
            ctx.effect(() => tools.register(logicProbeExportTool), 'logicprobe: export tool');
            toolRegistered = true;
            dataToolRegistered = true;
            concurrencyToolRegistered = true;
            composeToolRegistered = true;
            exportToolRegistered = true;
        }
        catch (err) {
            console.warn('[logicprobe] logicprobe_verify/logicprobe_datamodel_verify tool registration failed', err);
        }
    };
    const registerModeContext = () => {
        if (modeContextRegistered)
            return;
        const systemPrompt = ctx.get('systemPrompt');
        if (systemPrompt === undefined)
            return;
        try {
            ctx.effect(() => systemPrompt.context({
                name: 'logicprobe:mode',
                order: 118,
                text: (context) => {
                    const agent = context.agent;
                    if (agent === undefined)
                        return '';
                    return modeContextText(config, agent.session);
                },
            }), 'logicprobe: system prompt context');
            modeContextRegistered = true;
        }
        catch (err) {
            console.warn('[logicprobe] system prompt context registration failed', err);
        }
    };
    const registerIntegrations = () => {
        registerProvider();
        registerTool();
        registerModeContext();
    };
    registerIntegrations();
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
        });
    });
    if (!config.enabled)
        return;
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
        const decision = await next();
        if (decision.kind === 'reject')
            return decision;
        registerIntegrations();
        if (gateInHistory(agent.session))
            return decision;
        return {
            kind: 'enter',
            messages: [...decision.messages, gateMessage(config.gateContent)],
        };
    });
}
/**
 * Whether the gate already entered this session's durable history. The
 * pre-step listener re-appends the gate until it does; once a step committed
 * it, every later step (and a resume of a session that kept it) skips the
 * injection. A session whose gate was dropped before any step ran (e.g. an
 * inbox cleared by a blank-session preset switch) simply re-injects on the
 * first step that runs.
 */
function gateInHistory(session) {
    return readSessionEvents(session).some((event) => {
        if (event.type !== 'user/message')
            return false;
        const source = event.data?.source;
        return source?.kind === 'plugin' && source.plugin === GATE_PLUGIN_ID;
    });
}
