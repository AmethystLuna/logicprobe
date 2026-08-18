import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import { runVerification } from './engine.js'

export const LOGICPROBE_VERIFY_TOOL_NAME = 'logicprobe_verify'

/**
 * Model-visible DSH tool wrapping the bundled TypeScript verification engine.
 * The model passes a LogicModelV1 object; the engine validates it and returns
 * the 14-check report. This is the dsh-native replacement for hand-filling the
 * Python template shipped in the skill references.
 */
export const logicProbeVerifyTool = defineTool({
  name: LOGICPROBE_VERIFY_TOOL_NAME,
  description:
    'Run executable state-machine verification (logicprobe). Takes a LogicModelV1 object with schemaVersion=1, init, states ({id, terminal?}), transitions ({from, event, to, guard?, updates?}), variables?, invariants?, concurrentPairs?, boundaryChecks?, resourcePairs?. Guards are structured ({variable, op, value} | {all} | {any} | {not}); invariants support never-states, var-in-range, and event-before-state. Returns a report with S1-S7 structural checks and A1-A7 adversarial probes including shortest counterexample paths. See skills/logicprobe/references/dsh-model-schema.md.',
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
  },
  output: {
    schema: {
      type: 'json',
      description: 'logicprobe verification report with summary and per-check findings.',
    },
    render(_args, value) {
      return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
    },
  },
  timeoutMs: 10_000,
  isConcurrencySafe: () => true,
  async execute(args) {
    return runVerification(args.model, {
      maxStates: args.maxStates,
      maxPermutationEvents: args.maxPermutationEvents,
    }) as unknown as JsonValue
  },
})
