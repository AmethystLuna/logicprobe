import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from './json-value.js'
import { runCompositionVerification } from './engine.js'

export const LOGICPROBE_COMPOSE_TOOL_NAME = 'logicprobe_compose_verify'

/**
 * DSH tool wrapping multi-machine composition verification:
 * product-space reachability with rendezvous handshakes (C1 deadlock, C2 sync).
 */
export const logicProbeComposeTool = defineTool({
  name: LOGICPROBE_COMPOSE_TOOL_NAME,
  description:
    'Check two or more LogicModelV1 machines together. Pass the models in `machines`. Pass `rendezvous` for handshake events: these fire only when every declaring machine is enabled at once, and a terminal machine stops taking part. Other events advance one machine, so a machine waiting on a handshake can take any number of its own steps first. There is no rate ratio and no fairness bound. Returns C1 deadlocks (no machine can advance, and one is not terminal) and C2 handshakes that never fire. Both name the reason per machine, and C1 gives the shortest counterexample. `maxStates` caps the search; a capped run says so. Read `verdict` and `verdictReason`.',
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
      return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
    },
  },
  timeoutMs: 10_000,
  isConcurrencySafe: () => true,
  async execute(args) {
    return runCompositionVerification(args.machines as unknown[], {
      rendezvous: args.rendezvous as string[] | undefined,
      maxStates: args.maxStates,
    }) as unknown as JsonValue
  },
})
