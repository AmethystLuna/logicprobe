import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from './json-value.js'
import { REPORT_SCHEMAS, DEFAULT_HASH_SPEC, modelHash, refusalVerdict, validateModel, verdictOf } from './engine.js'
import { exportModel, type ExportFormat } from './exporters.js'

/** The model hash of an export's input, when the input validates (the success path always does). */
function exportHashes(model: unknown): { hashSpec: typeof DEFAULT_HASH_SPEC; modelHash?: string } {
  const validation = validateModel(model)
  return validation.ok
    ? { hashSpec: DEFAULT_HASH_SPEC, modelHash: modelHash(validation.model) }
    : { hashSpec: DEFAULT_HASH_SPEC }
}

export const LOGICPROBE_EXPORT_TOOL_NAME = 'logicprobe_export'

/**
 * DSH tool wrapping the external-tool exporters: turn a LogicModelV1 machine into
 * native input for the tool logicprobe routes to (UPPAAL / TLA+ / PRISM / SPIN).
 * v1 translates the core machine; unrepresentable invariants become warnings.
 */
export const logicProbeExportTool = defineTool({
  name: LOGICPROBE_EXPORT_TOOL_NAME,
  description:
    'Export a LogicModelV1 state machine into native input for an external verification tool (logicprobe routing). format is one of uppaal (.xta + queries), tla (TLC spec + safety property), prism (.pm + .pctl), spin (Promela + ltl). Booleans are exported as 0/1 integers; invariants the target cannot express are returned as warnings, never silently dropped. Returns { ok, format, primary, extras?, warnings? } or { ok: false, error } when the model is invalid or the PRISM enumeration is too large.',
  parameters: {
    model: {
      type: 'json',
      required: true,
      description: 'LogicModelV1 state-machine model to export.',
    },
    format: {
      type: 'string',
      required: true,
      enum: ['uppaal', 'tla', 'prism', 'spin'],
      description: 'Target tool format.',
    },
  },
  output: {
    schema: {
      type: 'json',
      description: 'Export result with generated file content.',
    },
    render(_args, value) {
      return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
    },
  },
  timeoutMs: 10_000,
  isConcurrencySafe: () => true,
  async execute(args) {
    try {
      const result = exportModel(args.model, args.format as ExportFormat)
      const warnings = result.warnings ?? []
      const nextSteps: string[] = []
      if (warnings.length > 0) nextSteps.push('The target notation cannot express some invariants; the warnings name each one — verify them in the target tool rather than assuming they carried over.')
      nextSteps.push('Run the exported file through its own tool (verify/compile) before trusting the translation; logicprobe guarantees the encoding, not the target checker\'s verdict.')
      return {
        ok: true,
        ran: true,
        ...verdictOf(0, warnings.length),
        schema: REPORT_SCHEMAS.export,
        format: result.format,
        primary: result.primary,
        ...(result.extras === undefined ? {} : { extras: result.extras }),
        hashes: exportHashes(args.model),
        warnings,
        nextSteps,
      } as unknown as JsonValue
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, ran: false, ...refusalVerdict(message), schema: REPORT_SCHEMAS.export, errorCode: 'MODEL_INVALID', error: message } as unknown as JsonValue
    }
  },
})
