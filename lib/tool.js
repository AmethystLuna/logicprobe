import { defineTool } from '@deepseek-ai/dsh-tools';
import { runVerification } from './engine.js';
export const LOGICPROBE_VERIFY_TOOL_NAME = 'logicprobe_verify';
/**
 * Model-visible DSH tool wrapping the bundled TypeScript verification engine.
 * The model passes a LogicModelV1 object; the engine validates it and returns
 * the 14-check report, or an 18-check report when beforeModel is supplied
 * (D1 behavioral preservation, D2 invariant continuity, D3 regression delta,
 * D4 deadlock/liveness regression). This is the dsh-native replacement for
 * hand-filling the Python template shipped in the skill references.
 */
export const logicProbeVerifyTool = defineTool({
    name: LOGICPROBE_VERIFY_TOOL_NAME,
    description: 'Run executable state-machine verification (logicprobe). Takes a LogicModelV1 object with schemaVersion=1, init, states ({id, terminal?}), transitions ({from, event, to, guard?, updates?}), variables?, invariants?, concurrentPairs?, boundaryChecks?, resourcePairs?, idempotentEvents?. Guards are structured ({variable, op, value} | {all} | {any} | {not}); invariants support never-states, var-in-range, event-before-state, leads-to, sequence, and atomicity; variables support monotonic inc/dec. Returns a report with S1-S7 structural checks and A1-A7 adversarial probes including shortest counterexample paths. If beforeModel is provided, also runs D1-D4 before/after regression checks. See skills/logicprobe/references/dsh-model-schema.md.',
    parameters: {
        model: {
            type: 'json',
            required: true,
            description: 'LogicModelV1 state machine model to verify.',
        },
        maxStates: {
            type: 'integer',
            description: 'Maximum runtime states to explore. Default 10000.',
        },
        maxPermutationEvents: {
            type: 'integer',
            description: 'Maximum event count for A3 order permutation. Default 5.',
        },
        beforeModel: {
            type: 'json',
            description: 'Optional BEFORE LogicModelV1 state machine model for refactoring/migration regression comparison.',
        },
        stateMapping: {
            type: 'json',
            description: 'Optional object mapping BEFORE state ids to AFTER state ids. Omit for identity mapping (same state names).',
        },
    },
    output: {
        schema: {
            type: 'json',
            description: 'logicprobe verification report with summary and per-check findings.',
        },
        render(_args, value) {
            return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
        },
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    async execute(args) {
        return runVerification(args.model, {
            maxStates: args.maxStates,
            maxPermutationEvents: args.maxPermutationEvents,
            beforeModel: args.beforeModel,
            stateMapping: args.stateMapping,
        });
    },
});
