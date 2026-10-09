import { defineTool } from '@deepseek-ai/dsh-tools';
import { reviewStructure } from './structure.js';
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
    description: 'Audit a structure diagram as a dependency graph (logicprobe). Takes PlantUML component/package/class/deployment text or a Mermaid class diagram, parses it into nodes and directed edges, and reports: UML020 isolated node (no edge at all), UML021 dangling reference (an arrow endpoint never declared), UML022 cycle (the shortest directed cycle, with its path), UML023 disallowed edge and UML024 layer violation when a dependency matrix is supplied, and UML025 missing expected edge (a required edge the diagram does not draw), plus UML026 when the text declares no node. The matrix is {rules: [{id, source, allow?, deny?, require?}], layers: [{name, members}], default: "allow"|"deny"}; `source`, `allow`, `deny` and `members` accept node ids or globs (`*`, `?`), deny wins over allow, layers are ordered top-first so downward edges are allowed and upward ones are UML024. When a matrix is given, every edge is also returned in edgeVerdicts with the rule ids it matched. This audits the DIAGRAM, not the code: reconcile it with a source-side include scan. Reports carry ran/verdict/verdictReason — read verdict, not ok. For state or activity diagrams use logicprobe_uml and logicprobe_verify instead.',
    parameters: {
        diagram: {
            type: 'string',
            required: true,
            description: 'Structure-diagram source text: PlantUML component/package/class/deployment, or a Mermaid class diagram.',
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
        return reviewStructure({
            diagram: args.diagram,
            notation: (args.notation ?? 'auto'),
            ...(args.matrix === undefined ? {} : { matrix: args.matrix }),
        });
    },
});
