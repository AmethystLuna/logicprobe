import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import { exportModel, type ExportFormat } from './exporters.js'

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
      return { ok: true, format: result.format, primary: result.primary, ...(result.extras === undefined ? {} : { extras: result.extras }), warnings: result.warnings } as unknown as JsonValue
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) } as unknown as JsonValue
    }
  },
})
