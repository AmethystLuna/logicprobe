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
 * presentation is adapted to dsh's native skill catalog — the per-domain trigger
 * lists live in the four skill descriptions, and the gate names the entry point
 * and its routes rather than duplicating them. Deployments
 * override via Config.
 *
 * @module logicprobe-dsh
 */
import type { Context, Volatile } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { ContextFormed } from '@deepseek-ai/dsh-llm';
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'plugin:logicprobe': {
            kind: 'plugin:logicprobe';
        } & ContextFormed;
    }
}
export declare const name = "logicprobe";
export declare const inject: string[];
export type InteractionMode = 'ask' | 'auto' | 'follow-approval';
export interface Config {
    /**
     * The injection switch the Web client's Plugins page edits live: a `Volatile`
     * reference on a host whose schemastery supports one, an ordinary boolean on a
     * host that predates `.volatile()`. Read it through {@link injectionEnabled},
     * which accepts both shapes.
     */
    enabled: Volatile<boolean> | boolean;
    gateContent: string;
    interaction: InteractionMode;
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    gateContent: z<string, string, "defined">;
    interaction: z<"ask" | "auto" | "follow-approval", "ask" | "auto" | "follow-approval", "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    gateContent: z<string, string, "defined">;
    interaction: z<"ask" | "auto" | "follow-approval", "ask" | "auto" | "follow-approval", "defined">;
}>>, "plain">;
export declare function apply(ctx: Context, config: Config): void;
