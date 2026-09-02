import { defineTool } from '@deepseek-ai/dsh-tools';
import { runCompositionVerification } from './engine.js';
export const LOGICPROBE_COMPOSE_TOOL_NAME = 'logicprobe_compose_verify';
/**
 * DSH tool wrapping multi-machine composition verification:
 * product-space reachability with rendezvous handshakes (C1 deadlock, C2 sync).
 */
export const logicProbeComposeTool = defineTool({
    name: LOGICPROBE_COMPOSE_TOOL_NAME,
    description: 'Run composition verification over two or more LogicModelV1 state machines (logicprobe). Pass machines as an array of models and optionally rendezvous: a list of handshake events that must fire simultaneously across all machines declaring them (at least two participants, all jointly enabled, guards held; a terminal machine stops participating). Non-rendezvous events advance exactly one firing machine. Returns C1 composition-deadlock findings (a reachable state where no machine can advance while at least one is not terminal) and C2 rendezvous-never-fires findings. Each machine validates against the same schema as logicprobe_verify.',
    parameters: {
        machines: {
            type: 'json',
            required: true,
            description: 'Array of LogicModelV1 state-machine models to compose (two or more).',
        },
        rendezvous: {
            type: 'json',
            description: 'Optional array of handshake event names shared by the machines.',
        },
        maxStates: {
            type: 'integer',
            description: 'Maximum composite states to explore. Default 10000.',
        },
    },
    output: {
        schema: {
            type: 'json',
            description: 'Composition verification report with C1/C2 findings.',
        },
        render(_args, value) {
            return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
        },
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    async execute(args) {
        return runCompositionVerification(args.machines, {
            rendezvous: args.rendezvous,
            maxStates: args.maxStates,
        });
    },
});
