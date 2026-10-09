import { defineTool } from '@deepseek-ai/dsh-tools';
import { refusalVerdict, verdictOf, verdictOfFindings } from './engine.js';
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
    description: 'Model a code flow as UML, and review the modelling. action="render" turns a LogicModelV1 (schemaVersion=1) into diagram source: notation mermaid (state | activity flowchart | sequence) or plantuml (state | sequence). action="parse" reads Mermaid/PlantUML state or activity text back into a LogicModelV1 (plus the display labels it found), so a hand-drawn diagram can be verified with logicprobe_verify; a sequence diagram is refused because a trace cannot reconstruct a machine, and so is a diagram from another family (classDiagram, erDiagram, gantt, mindmap, …): that refusal carries errorCode "UML_NOT_A_STATE_DIAGRAM". A PlantUML component/package/class/deployment diagram declares no diagram kind, so the parser detects those constructs itself: it returns the by-product model but reports an error finding UML_NOT_A_STATE_DIAGRAM with `discardedConstructs` (every declaration it could not represent, with line and text) and `discardedEdges` (arrows between them that were read as state transitions), and the verdict is not "pass" — never treat that model as a model of the file. action="review" audits the modelling: structural defects (UML002 unreachable state, UML003 dead end, UML004 ambiguous branch, UML005 overlapping guard, UML006 inexhaustive branch, UML007 unused event, UML008 self-loop with no exit, UML009 duplicate transition), documentation gaps (UML010 unused variable, UML011 unbounded variable, UML012 no terminal, UML013 no narrative, UML014 undocumented state, UML015 label drift), and the fidelity check — the diagram is rendered and re-parsed and any structural difference is reported as UML017 round-trip mismatch. Give review a model (checks it, renders and re-parses it), a diagram (parses and reviews that), or both (checks the diagram against the model). Rendering never invents structure and never silently drops a construct the notation cannot express: those become warnings. Read `verdict` ("pass" / "pass_with_findings" / "fail"), not `ok`: `ok: true` only says the action ran, so `ok: true` with error findings is a FAILED review. Review does NOT replace logicprobe_verify — it covers the modelling, not behaviour; findings name the engine check to run next.',
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
                return { ok: true, ran: true, ...verdictOf(0, result.warnings.length), action: 'render', notation: result.notation, kind: result.diagram, diagram: result.primary, warnings: result.warnings };
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
                    action: 'parse',
                    notation: result.notation,
                    kind: result.diagram,
                    model: result.model,
                    labels: result.labels,
                    findings,
                    discardedConstructs: result.discardedConstructs,
                    discardedEdges: result.discardedEdges,
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
