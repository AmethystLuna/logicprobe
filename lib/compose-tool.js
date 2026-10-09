import { defineTool } from '@deepseek-ai/dsh-tools';
import { runCompositionVerification } from './engine.js';
export const LOGICPROBE_COMPOSE_TOOL_NAME = 'logicprobe_compose_verify';
/**
 * DSH tool wrapping multi-machine composition verification:
 * product-space reachability with rendezvous handshakes (C1 deadlock, C2 sync).
 */
export const logicProbeComposeTool = defineTool({
    name: LOGICPROBE_COMPOSE_TOOL_NAME,
    description: 'Run composition verification over two or more LogicModelV1 state machines (logicprobe). Pass machines as an array of models and optionally rendezvous: a list of handshake events that must fire simultaneously across all machines declaring them (at least two participants, all jointly enabled, guards held; a terminal machine stops participating). Non-rendezvous events advance exactly one firing machine, so a machine waiting for a handshake may take any number of its own steps first — that is how different rates are modelled, with no rate ratio and no fairness bound. Returns C1 composition-deadlock findings (a reachable state where no machine can advance while at least one is not terminal) and C2 rendezvous-never-fires findings. Both carry the reason: C1 lists, per machine, its state and every event in its alphabet with why it cannot fire (rendezvous-needs-partner, rendezvous-partner-not-ready, no-enabled-transition), with the shortest counterexample depth; C2 lists, per machine, whether it declares the event and ever enables it, so "the handshake is declared but never reached" is distinguishable from "only one machine declares it". maxStates caps the product space and the cap is reported: a truncated run never claims "no deadlock reachable", and C2 findings under truncation say the result may be an artefact of the cap. For many files use the CLI (compose models/*.json --rendezvous a,b) — this tool takes the models themselves. Each machine validates against the same schema as logicprobe_verify (`_`-prefixed metadata keys included). Read `verdict` ("pass" / "pass_with_findings" / "fail") and `verdictReason` for the outcome; `hashSpec` names the published hash specification the per-machine modelHash values follow.',
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
