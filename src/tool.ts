import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from './json-value.js'
import { runVerification } from './engine.js'

export const LOGICPROBE_VERIFY_TOOL_NAME = 'logicprobe_verify'

/**
 * Model-visible DSH tool wrapping the bundled TypeScript verification engine.
 * The model passes a LogicModelV1 object; the engine validates it and returns
 * the 22-check report (S1-S8 structural, A1-A14), or a 26-check
 * report when beforeModel is supplied (D1 behavioral preservation, D2
 * invariant continuity, D3 regression delta, D4 deadlock/liveness regression).
 * This is the dsh-native path: the model is built and run here, with no
 * template to fill in by hand.
 */
export const logicProbeVerifyTool = defineTool({
  name: LOGICPROBE_VERIFY_TOOL_NAME,
  description:
    'Run state-machine verification on a LogicModelV1 object. Model shape: schemaVersion 1, init, states ({id, terminal?}), transitions ({from, event, to, guard?, updates?, cost?}), plus optional variables, invariants, concurrentPairs, boundaryChecks, resourcePairs, idempotentEvents and narrative. Guards are structured: {variable, op, value}, {all}, {any} or {not}. Invariants cover never-states, var-in-range, event-before-state, leads-to, sequence, atomicity, budget, probability and deadline. `cost` defaults to 1 and drives the A12 budget check. `weight` defaults to 1 and makes the model a DTMC for A13. A state with `maxTicks` needs top-level `tickEvents`; A14 reports over-residency. The schema is closed: an undeclared key is a validation error. Keys starting with `_` are metadata: ignored, kept out of `modelHash`, and echoed as `metadataKeys`. Variables support monotonic inc and dec. Pass `beforeModel` and `stateMapping` to add the D1-D4 regression. Read `verdict`, never `ok`. The full schema is in the `logicprobe` skill: references/dsh-model-schema.md.',
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
      return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
    },
  },
  timeoutMs: 10_000,
  isConcurrencySafe: () => true,
  async execute(args) {
    return runVerification(args.model, {
      maxStates: args.maxStates,
      maxPermutationEvents: args.maxPermutationEvents,
      beforeModel: args.beforeModel,
      stateMapping: args.stateMapping as Record<string, string> | undefined,
    }) as unknown as JsonValue
  },
})
