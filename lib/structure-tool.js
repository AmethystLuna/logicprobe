import { defineTool } from '@deepseek-ai/dsh-tools';
import { REPORT_SCHEMAS } from './engine.js';
import { reviewStructure } from './structure.js';
import { reviewGranularity } from './granularity.js';
export const LOGICPROBE_STRUCTURE_TOOL_NAME = 'logicprobe_structure_verify';
/**
 * Model-visible DSH tool that audits a *structure* diagram — components, packages,
 * classes, deployment nodes and the dependency arrows between them — against an
 * optional dependency matrix. A structure diagram is not a state machine: this tool
 * reads the graph the diagram actually draws, instead of refusing it (which is what
 * `logicprobe_uml action=parse` does) or pretending the arrows are state transitions
 * (which is what a false `ok` used to hide).
 */
export const logicProbeStructureTool = defineTool({
    name: LOGICPROBE_STRUCTURE_TOOL_NAME,
    description: 'Audit a structure diagram as a dependency graph. Takes PlantUML component, package, class or deployment text, or a Mermaid class diagram. Reports UML020 isolated node, UML021 dangling reference, UML022 cycle (shortest path), UML023 disallowed edge and UML024 layer violation against a matrix, UML025 missing required edge, and UML026 when no node is declared. The matrix is {rules: [{id, source, allow?, deny?, require?}], layers: [{name, members}], default: "allow"|"deny"}. Ids and members accept globs (`*`, `?`). Deny beats allow, and layers run top-first, so downward edges pass and upward ones are UML024. With a matrix, every edge appears in `edgeVerdicts` with the rules it matched. Pass `diagrams` instead of `diagram` to check several levels at once: each child must refine its parent. This audits the diagram, not the code: reconcile it with a source-side scan. Read `verdict`, not `ok`. For state or activity diagrams use `logicprobe_uml` and `logicprobe_verify`.',
    parameters: {
        diagram: {
            type: 'string',
            description: 'Structure-diagram source text: PlantUML component/package/class/deployment, or a Mermaid class diagram. Omit when `diagrams` is given.',
        },
        diagrams: {
            type: 'json',
            description: 'Multi-granularity mode: an array of {name, diagram, parent?} levels. Each diagram is checked on its own AND against its declared parent (UML028 unknown parent, UML029 refinement violation, UML030 parent cycle), with per-pair node/edge counts.',
        },
        notation: {
            type: 'string',
            enum: ['auto', 'plantuml', 'mermaid'],
            description: 'Diagram language. Default auto (detected from the text).',
        },
        matrix: {
            type: 'json',
            description: 'Optional dependency matrix: {rules: [{id, source, allow?, deny?, require?}], layers: [{name, members}], default: "allow"|"deny"}. Every edge is judged against it and the matched rule ids are reported.',
        },
    },
    output: {
        schema: {
            type: 'json',
            description: 'Structure review report: graph (nodes/edges), findings UML020-UML026, per-edge matrix verdicts, summary and next steps.',
        },
        render(_args, value) {
            return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
        },
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    async execute(args) {
        if (args.diagrams !== undefined) {
            return reviewGranularity({
                diagrams: args.diagrams,
                notation: (args.notation ?? 'auto'),
                ...(args.matrix === undefined ? {} : { matrix: args.matrix }),
            });
        }
        if (args.diagram === undefined) {
            return { ok: false, ran: false, verdict: 'fail', verdictReason: 'the tool did not run: pass `diagram` (one structure diagram) or `diagrams` (several levels with parents)', schema: REPORT_SCHEMAS.structure, errorCode: 'UML_INPUT', error: 'structure review needs `diagram` or `diagrams`' };
        }
        return reviewStructure({
            diagram: args.diagram,
            notation: (args.notation ?? 'auto'),
            ...(args.matrix === undefined ? {} : { matrix: args.matrix }),
        });
    },
});
