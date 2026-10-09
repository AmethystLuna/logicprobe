import { defineTool } from '@deepseek-ai/dsh-tools';
import { createHash } from 'node:crypto';
import { REPORT_SCHEMAS, DEFAULT_HASH_SPEC, modelHash, refusalVerdict, verdictOf, verdictOfFindings } from './engine.js';
import { renderUml, parseUml, parseFindings, reviewUml, UmlError } from './uml.js';
export const LOGICPROBE_UML_TOOL_NAME = 'logicprobe_uml';
/**
 * DSH tool wrapping the UML front end: model a code flow as a UML diagram
 * (`action: "render"`), read a UML diagram back into a LogicModelV1
 * (`action: "parse"`), or review the modelling itself (`action: "review"`).
 *
 * review is the half that makes the feature a check rather than a drawing
 * utility: it reports structural defects the diagram would present as valid
 * flow (unreachable states, dead ends, ambiguous and non-exhaustive branches,
 * self-loops with no exit), documentation gaps (a symbol no reader can map back
 * to code), and — the fidelity check — whether the rendered diagram reads back
 * as the model it was drawn from.
 */
export const logicProbeUmlTool = defineTool({
    name: LOGICPROBE_UML_TOOL_NAME,
    description: 'Model a code flow as UML, and audit the modelling. action="render" turns a LogicModelV1 into diagram source: mermaid (state, activity, sequence) or plantuml (state, sequence). action="parse" reads Mermaid or PlantUML state or activity text back into a LogicModelV1, so a hand-drawn diagram can be verified. A sequence diagram is refused: a trace cannot reconstruct a machine. So is any other diagram family (class, ER, gantt, mindmap). That refusal carries errorCode "UML_NOT_A_STATE_DIAGRAM". A PlantUML component, package or deployment diagram declares no kind, so the parser detects those constructs itself. It returns a by-product model and reports the error UML_NOT_A_STATE_DIAGRAM, with `discardedConstructs` and `discardedEdges`. Never treat that model as a model of the file. action="review" audits the modelling: structural defects (UML002-UML009), documentation gaps (UML010-UML015), and a fidelity check that re-parses the rendered diagram (UML017). Give it a model, a diagram, or both. Rendering never invents structure. A construct the notation cannot express becomes a warning. For dependency questions on a component or class diagram, use `logicprobe_structure_verify` instead. Read `verdict`, not `ok`: error findings mean a failed review.',
    parameters: {
        action: {
            type: 'string',
            required: true,
            enum: ['render', 'parse', 'review'],
            description: 'render = model → UML source; parse = UML source → model; review = audit the modelling (and its fidelity to the model).',
        },
        model: {
            type: 'json',
            description: 'LogicModelV1 machine. Required for render; accepted by review (alone, or next to diagram to check the two against each other).',
        },
        diagram: {
            type: 'string',
            description: 'UML source text. Required for parse; accepted by review.',
        },
        notation: {
            type: 'string',
            enum: ['auto', 'mermaid', 'plantuml'],
            description: 'Diagram language. Default auto: detected from the text for parse/review, mermaid for render.',
        },
        kind: {
            type: 'string',
            enum: ['state', 'activity', 'sequence'],
            description: 'Diagram kind to render. Default state. sequence is one BFS trace, not the whole machine. PlantUML activity is refused (its structured-flowchart syntax cannot faithfully carry a graph with merges or cycles) — use mermaid for that view.',
        },
        roundTrip: {
            type: 'boolean',
            description: 'review only: render and re-parse the model to prove the diagram carries it. Default true.',
        },
        maxSteps: {
            type: 'integer',
            description: 'Cap on the sequence trace length when rendering kind=sequence. Default 60.',
        },
    },
    output: {
        schema: {
            type: 'json',
            description: 'Render result (diagram source), parse result (LogicModelV1 + labels), or the modelling review report with findings, round-trip diff and next steps.',
        },
        render(_args, value) {
            const record = value;
            // A rendered diagram is source text: print it verbatim so it can be copied
            // into a file, then the structured result (warnings, notation, kind).
            if (typeof record.diagram === 'string') {
                return [
                    { type: 'text', text: record.diagram },
                    { type: 'text', text: JSON.stringify(value, null, 2) },
                ];
            }
            return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
        },
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    async execute(args) {
        try {
            if (args.action === 'render') {
                if (args.model === undefined)
                    return errorResult('action=render needs `model` (a LogicModelV1 object)');
                const result = renderUml(args.model, (args.notation === undefined || args.notation === 'auto' ? 'mermaid' : args.notation), (args.kind ?? 'state'), args.maxSteps);
                return { ok: true, ran: true, ...verdictOf(0, result.warnings.length), schema: REPORT_SCHEMAS.umlRender, action: 'render', notation: result.notation, kind: result.diagram, diagram: result.primary, hashes: { diagram: createHash('sha256').update(result.primary).digest('hex') }, warnings: result.warnings };
            }
            if (args.action === 'parse') {
                if (args.diagram === undefined)
                    return errorResult('action=parse needs `diagram` (Mermaid or PlantUML text)');
                const result = parseUml(args.diagram, args.notation ?? 'auto');
                // A diagram from another family still parses into *something*. `parseFindings`
                // says so, and the verdict is what stops that something from being trusted:
                // `ok: true` only means the parser ran.
                const findings = parseFindings(result);
                return {
                    ok: true,
                    ran: true,
                    ...parseVerdict(result, findings),
                    schema: REPORT_SCHEMAS.umlParse,
                    action: 'parse',
                    notation: result.notation,
                    kind: result.diagram,
                    model: result.model,
                    labels: result.labels,
                    findings,
                    discardedConstructs: result.discardedConstructs,
                    discardedEdges: result.discardedEdges,
                    hashes: { hashSpec: DEFAULT_HASH_SPEC, modelHash: modelHash(result.model), diagram: createHash('sha256').update(args.diagram).digest('hex') },
                    warnings: result.warnings,
                };
            }
            const report = reviewUml({
                model: args.model,
                diagram: args.diagram,
                notation: args.notation ?? 'auto',
                diagramKind: (args.kind ?? 'state'),
                roundTrip: args.roundTrip,
                maxSteps: args.maxSteps,
            });
            return report;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return errorResult(message, error instanceof UmlError ? error.code : undefined);
        }
    },
});
/** The parse verdict counts parser notes as findings: an ignored line is information the model does not carry. */
function parseVerdict(result, findings) {
    const errors = findings.filter((finding) => finding.severity === 'error').length;
    const warnings = findings.filter((finding) => finding.severity === 'warning').length + result.warnings.length;
    const firstCode = findings.find((finding) => finding.severity === 'error')?.code ?? findings.find((finding) => finding.severity === 'warning')?.code;
    return verdictOf(errors, warnings, firstCode);
}
function errorResult(message, errorCode = 'UML_INPUT') {
    return { ok: false, ran: false, ...refusalVerdict(message), errorCode, error: message };
}
