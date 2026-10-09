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
 * This is the dsh-native replacement for hand-filling the Python template
 * shipped in the skill references.
 */
export const logicProbeVerifyTool = defineTool({
  name: LOGICPROBE_VERIFY_TOOL_NAME,
  description:
    'Run executable state-machine verification (logicprobe). Takes a LogicModelV1 object with schemaVersion=1, init, states ({id, terminal?}), transitions ({from, event, to, guard?, updates?, cost?}), variables?, invariants?, concurrentPairs?, boundaryChecks?, resourcePairs?, idempotentEvents?, narrative?. Guards are structured ({variable, op, value} | {all} | {any} | {not}); invariants support never-states, var-in-range ({variable, min?, max?, when?} — when scopes the range to a state ({state}) or a guard node, is evaluated on the post-state of every transition, leaves the initial state checked unconditionally, and is rejected on any other invariant kind), event-before-state, leads-to (`to` is one state id or a non-empty array of them: every path must reach at least one member), sequence, atomicity, budget (transition cost defaults to 1; A12 checks every reachable path stays within the declared budget and reports the shortest over-budget counterexample), and probability (transition weight, default 1, makes the model a DTMC; A13 checks P(hit target) against the bound by value iteration), and deadline (declaring maxTicks on a state is how many tick steps it may stay resident and the top-level tickEvents list names those steps; A14 reports the over-residency path, and A14_NO_TICK_EVENTS when maxTicks is declared without tickEvents). The schema is closed: an undeclared key on any model part (model, state, transition, update, variable, invariant, boundaryCheck, resourcePair, narrative, scenario) is a validation error, never ignored — except `_`-prefixed keys, which are annotation metadata: they are ignored, excluded from modelHash, and echoed as `metadataKeys` so a model can carry its own provenance instead of a sidecar that drifts. Variables support monotonic inc/dec. The optional narrative block carries natural-language descriptions of states (narrative.states), events (narrative.events), and (state, event) scenarios (narrative.scenarios: [{from, event, scenario}]); it may cover only part of the model — the report then adds narrativeCoverage ({states: "5/5", events: "3/9", scenarios: "0/12"}) and names the gap in nextSteps, while an empty narrative block, an unknown id, an empty description or a duplicate scenario is a validation error. Returns a report with S1-S8 structural checks and A1-A14 adversarial, cost, probability and deadline probes, including counterexample paths (shortest where the search is breadth-first). Every report carries `schema` (the versioned contract), `hashes` (every hash in one place) and `nextSteps`. Read `verdict` ("pass" / "pass_with_findings" / "fail") and `verdictReason`, not `ok`: `ok` only says the engine produced a report, so `ok: true` with failing checks is a FAILED verification. `hashSpec` names the published specification `modelHash` follows (see skills/logicprobe/references/hash-spec.md). If beforeModel is provided, also runs D1-D4 before/after regression checks. See skills/logicprobe/references/dsh-model-schema.md.',
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
