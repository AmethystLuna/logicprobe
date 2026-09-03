// External-tool exporters: turn a validated LogicModelV1 into native input for the
// tools logicprobe routes to (see skills/logicprobe/references/gap-routing-guide.md).
// v1 translates the CORE machine (states, events, transitions, integer/boolean guards
// and updates). Constructs a target cannot express are emitted as warnings/comments,
// never silently dropped. Booleans are exported as 0/1 integers everywhere.
import { validateModel } from './engine.js';
export function prepareModel(input) {
    const validation = validateModel(input);
    if (!validation.ok)
        throw new Error('model invalid: ' + validation.errors.join('; '));
    const model = validation.model;
    const used = new Set();
    const stateIds = [];
    const indexOf = new Map();
    const stateIdOf = new Map();
    const sanitize = (raw) => {
        let out = raw.replace(/[^A-Za-z0-9_]/g, '_');
        if (out.length === 0 || /^[0-9]/.test(out))
            out = 's_' + out;
        return out;
    };
    model.states.forEach((state, index) => {
        let candidate = sanitize(state.id);
        if (used.has(candidate))
            candidate = candidate + '_' + index;
        used.add(candidate);
        stateIds.push(candidate);
        indexOf.set(state.id, index);
        stateIdOf.set(state.id, candidate);
    });
    return { model, stateIds, indexOf, initId: stateIdOf.get(model.init) ?? stateIds[0], stateIdOf };
}
function numValue(value) {
    return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}
function leafExpr(node, varName) {
    return varName(node.variable) + ' ' + node.op + ' ' + String(numValue(node.value));
}
function guardExpr(node, and, or, not, varName, opFor = (op) => op) {
    if (node === undefined)
        return '';
    if ('variable' in node)
        return varName(node.variable) + ' ' + opFor(node.op) + ' ' + String(numValue(node.value));
    if ('all' in node)
        return '(' + node.all.map((g) => guardExpr(g, and, or, not, varName, opFor)).join(' ' + and + ' ') + ')';
    if ('any' in node)
        return '(' + node.any.map((g) => guardExpr(g, and, or, not, varName, opFor)).join(' ' + or + ' ') + ')';
    if ('not' in node)
        return not + '(' + guardExpr(node.not, and, or, not, varName, opFor) + ')';
    return 'true';
}
function updateAssignments(updates, varName) {
    const out = [];
    for (const update of updates ?? []) {
        const name = varName(update.variable);
        const value = update.value ?? 1;
        if (update.op === 'set')
            out.push(name + ' := ' + String(value));
        else if (update.op === 'inc')
            out.push(name + ' := ' + name + ' + ' + String(value));
        else
            out.push(name + ' := ' + name + ' - ' + String(value));
    }
    return out;
}
function forbiddenIndexes(ex) {
    const out = [];
    for (const invariant of ex.model.invariants ?? []) {
        if (invariant.kind === 'never-states') {
            for (const s of invariant.states) {
                const index = ex.indexOf.get(s);
                if (index !== undefined)
                    out.push(index);
            }
        }
    }
    return out;
}
// ---------------------------------------------------------------- UPPAAL ----
// UPPAAL .xta is XML (flat-1_6 DTD): nta/template/location/transition with label
// kinds guard | assignment | synchronisation. Queries are plain text (one per line).
function exportUppaal(ex) {
    const { model, stateIds, indexOf, initId } = ex;
    const warnings = [];
    const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const safeEvent = (event) => xml(event.replace(/[^A-Za-z0-9_]/g, '_'));
    const globals = (model.variables ?? []).map((v) => 'int ' + v.name + ' = ' + String(numValue(v.init)) + ';').join('\n');
    const locs = model.states.map((state, i) => {
        const nameEl = '\n      <name x=\"16\" y=\"16\">' + xml(stateIdOf(ex, state.id)) + '</name>';
        return '    <location id=\"id' + i + '\" x=\"' + (i * 120) + '\" y=\"0\">' + nameEl + '\n    </location>';
    }).join('\n');
    const edges = model.transitions.map((tr, i) => {
        const guard = guardExpr(tr.guard, '&&', '||', '!', (v) => v);
        const assigns = updateAssignments(tr.updates, (v) => v);
        const labels = [];
        if (guard !== '')
            labels.push('      <label kind=\"guard\" x=\"16\" y=\"16\">' + xml(guard) + '</label>');
        if (assigns.length > 0)
            labels.push('      <label kind=\"assignment\" x=\"16\" y=\"16\">' + xml(assigns.join(',\n')) + '</label>');
        labels.push('      <label kind=\"synchronisation\" x=\"16\" y=\"16\">' + safeEvent(tr.event) + '!</label>');
        return '    <transition id=\"id' + String(1000 + i) + '\">\n      <source ref=\"id' + String(indexOf.get(tr.from)) + '\"/>\n      <target ref=\"id' + String(indexOf.get(tr.to)) + '\"/>\n' + labels.join('\n') + '\n    </transition>';
    }).join('\n');
    const queries = [];
    for (const state of model.states)
        if (state.terminal)
            queries.push('E<> LogicProbe.' + stateIdOf(ex, state.id));
    for (const index of forbiddenIndexes(ex))
        queries.push('A[] not LogicProbe.' + stateIds[index]);
    for (const invariant of model.invariants ?? []) {
        if (invariant.kind !== 'never-states')
            warnings.push('UPPAAL export carries invariant kind ' + invariant.kind + ' only as a comment (not expressible in the exported XML).');
    }
    const initIndex = indexOf.get(model.init) ?? 0;
    const xta = '<?xml version="1.0" encoding="utf-8"?>\n' +
        '<!DOCTYPE nta PUBLIC \'-//Uppaal Team//DTD Flat System 1.6//EN\' \'http://www.it.uu.se/research/group/darts/uppaal/flat-1_6.dtd\'>\n' +
        '<nta>\n' +
        '  <declaration>// Generated by logicprobe (UPPAAL XML export; booleans as int).\n' + (globals === '' ? '' : globals + '\n') + '</declaration>\n' +
        '  <template>\n' +
        '    <name x=\"5\" y=\"5\">LogicProbe</name>\n' +
        '    <declaration/>\n' +
        locs + '\n' +
        '    <init ref=\"id' + String(initIndex) + '\"/>\n' +
        edges + '\n' +
        '  </template>\n' +
        '  <system>system LogicProbe;</system>\n' +
        '</nta>\n';
    const extras = { queries: queries.join('\n') + (queries.length ? '\n' : '') };
    void initId;
    return { format: 'uppaal', primary: xta, extras, warnings };
}
function stateIdOf(ex, id) {
    return ex.stateIdOf.get(id) ?? id;
}
// ------------------------------------------------------------------ TLA+ ----
// ------------------------------------------------------------------ TLA+ ----
function exportTla(ex) {
    const { model, stateIds, stateIdOf, initId } = ex;
    const warnings = [];
    const bs = String.fromCharCode(92); // backslash, composed so no escape pitfalls
    const CONJ = '/' + bs; // /\  (TLA conjunction)
    const DISJ = bs + '/'; // \/  (TLA disjunction)
    const MEM = bs + 'in'; // \in membership
    const NOTIN = bs + 'notin'; // \notin
    const variables = ['pc'].concat((model.variables ?? []).map((v) => v.name));
    const typeVar = (model.variables ?? []).map((v) => v.name + ' ' + MEM + ' ' + String(numValue(v.min ?? 0)) + '..' + String(Math.max(1, numValue(v.max ?? 1)))).join(' ' + CONJ + ' ');
    const initParts = ['pc = "' + initId + '"'].concat((model.variables ?? []).map((v) => v.name + ' = ' + String(numValue(v.init)))).join(' ' + CONJ + ' ');
    const nextParts = model.transitions.map((tr) => {
        const guard = guardExpr(tr.guard, CONJ, DISJ, '~', (v) => v).replace(/ == /g, ' = ').replace(/ != /g, ' /= ');
        const updates = [];
        for (const u of tr.updates ?? []) {
            const value = u.value ?? 1;
            if (u.op === 'set')
                updates.push(u.variable + ' = ' + String(value));
            else if (u.op === 'inc')
                updates.push(u.variable + ' = ' + u.variable + ' + ' + String(value));
            else
                updates.push(u.variable + ' = ' + u.variable + ' - ' + String(value));
        }
        const pcPart = 'pc' + "'" + ' = "' + stateIdOf.get(tr.to) + '"';
        const rest = updates.length ? ' ' + CONJ + ' ' + updates.join(' ' + CONJ + ' ') : '';
        const guardPart = guard === '' ? 'pc = "' + stateIdOf.get(tr.from) + '"' : 'pc = "' + stateIdOf.get(tr.from) + '" ' + CONJ + ' ' + guard;
        return DISJ + ' ' + guardPart + ' ' + CONJ + ' ' + pcPart + rest;
    }).join('\n');
    const forbids = forbiddenIndexes(ex).map((i) => '"' + stateIds[i] + '"');
    const props = [];
    if (forbids.length)
        props.push('CheckSafety == [] (pc ' + NOTIN + ' {' + forbids.join(', ') + '})');
    for (const invariant of model.invariants ?? []) {
        if (invariant.kind !== 'never-states')
            warnings.push('TLA+ v1 does not translate invariant kind ' + invariant.kind + '; only never-states becomes a property.');
    }
    let spec = '---- MODULE LogicProbe ----\n' +
        'EXTENDS Integers\n' +
        'VARIABLES ' + variables.join(', ') + '\n' +
        'States == {' + stateIds.map((s) => '"' + s + '"').join(', ') + '}\n' +
        'TypeOK == pc ' + MEM + ' States' + (typeVar === '' ? '' : ' ' + CONJ + ' ' + typeVar) + '\n' +
        'Init == ' + initParts + '\n' +
        'Next ==\n' + nextParts + '\n' +
        (props.length ? '\n' + props.join('\n\n') + '\n' : '') +
        '====\n';
    const extras = props.length ? { properties: props.join('\n') + '\n' } : {};
    return { format: 'tla', primary: spec, extras, warnings };
}
// ----------------------------------------------------------------- PRISM ----
function exportPrism(ex) {
    const { model, indexOf, stateIdOf, stateIds } = ex;
    const warnings = [];
    const ranges = (model.variables ?? []).map((v) => ({
        name: v.name,
        lo: numValue(v.min ?? 0),
        hi: Math.max(1, numValue(v.max ?? 3)),
        init: numValue(v.init),
    }));
    const valuations = [];
    const build = (i, acc) => {
        if (i === ranges.length) {
            valuations.push(acc);
            return;
        }
        for (let v = ranges[i].lo; v <= ranges[i].hi; v++) {
            const copy = { ...acc };
            copy[ranges[i].name] = v;
            build(i + 1, copy);
        }
    };
    build(0, {});
    const size = model.states.length * Math.max(1, valuations.length);
    if (size > 20000)
        throw new Error('PRISM enumeration too large: ' + model.states.length + ' x ' + valuations.length);
    const evalGuard = (guard, val) => {
        if (guard === undefined)
            return true;
        if ('variable' in guard) {
            const left = val[guard.variable] ?? numValue((model.variables ?? []).find((v) => v.name === guard.variable)?.init ?? 0);
            const right = numValue(guard.value);
            switch (guard.op) {
                case '==': return left === right;
                case '!=': return left !== right;
                case '<': return left < right;
                case '<=': return left <= right;
                case '>': return left > right;
                case '>=': return left >= right;
                default: return false;
            }
        }
        if ('all' in guard)
            return guard.all.every((g) => evalGuard(g, val));
        if ('any' in guard)
            return guard.any.some((g) => evalGuard(g, val));
        if ('not' in guard)
            return !evalGuard(guard.not, val);
        return false;
    };
    const applyUpdates = (t, val) => {
        const out = { ...val };
        for (const u of t.updates ?? []) {
            const cur = out[u.variable] ?? 0;
            const value = u.value ?? 1;
            if (u.op === 'set')
                out[u.variable] = value;
            else if (u.op === 'inc')
                out[u.variable] = cur + value;
            else
                out[u.variable] = cur - value;
        }
        return out;
    };
    const commands = [];
    for (const state of model.states) {
        for (const val of valuations) {
            const groups = new Map();
            for (const t of model.transitions)
                if (t.from === state.id) {
                    const list = groups.get(t.event) ?? [];
                    list.push(t);
                    groups.set(t.event, list);
                }
            const outcomes = new Map();
            let totalW = 0;
            for (const group of groups.values()) {
                const guarded = group.filter((t) => t.guard !== undefined && evalGuard(t.guard, val));
                const chosen = guarded.length > 0 ? guarded : group.filter((t) => t.guard === undefined);
                for (const t of chosen) {
                    const weight = t.weight ?? 1;
                    const nv = applyUpdates(t, val);
                    const key = String(indexOf.get(t.to)) + '|' + JSON.stringify(nv);
                    const cur = outcomes.get(key);
                    if (cur === undefined) {
                        outcomes.set(key, { weight, pc: indexOf.get(t.to) ?? 0, val: nv });
                        totalW += weight;
                    }
                    else
                        cur.weight += weight;
                }
            }
            if (outcomes.size === 0)
                continue;
            const guardParts = ['pc = ' + String(indexOf.get(state.id) ?? 0)];
            for (const r of ranges)
                guardParts.push(r.name + ' = ' + String(val[r.name] ?? r.init));
            const terms = [];
            for (const item of outcomes.values()) {
                const p = totalW > 0 ? item.weight / totalW : 0;
                const prob = p.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
                const upd = ["(pc' = " + String(item.pc) + ")"];
                for (const r of ranges) {
                    const v = item.val[r.name] ?? r.init;
                    if (v !== (val[r.name] ?? r.init))
                        upd.push("(" + r.name + "' = " + String(v) + ")");
                }
                terms.push(prob + ' : ' + upd.join(' & '));
            }
            commands.push('[] ' + guardParts.join(' & ') + ' ->\n    ' + terms.join(' +\n    '));
        }
    }
    let module = '// Generated by logicprobe (DTMC export; booleans as 0/1 integers).\n' +
        'dtmc\n\n' +
        'module LogicProbe\n' +
        '  pc : [0..' + String(model.states.length - 1) + '] init ' + String(indexOf.get(model.init) ?? 0) + ';\n' +
        (ranges.map((r) => '  ' + r.name + ' : [' + String(r.lo) + '..' + String(r.hi) + '] init ' + String(r.init) + ';').join('\n')) + '\n\n' +
        commands.join('\n\n') + '\n' +
        'endmodule\n';
    const labels = [];
    for (const state of model.states)
        if (state.terminal)
            labels.push('label "term_' + (stateIdOf.get(state.id) ?? 's') + '" = pc = ' + String(indexOf.get(state.id)));
    const forb = forbiddenIndexes(ex);
    if (forb.length)
        labels.push('label "forbidden" = ' + forb.map((i) => 'pc = ' + String(i)).join(' | '));
    const pctl = [];
    for (const invariant of model.invariants ?? []) {
        if (invariant.kind === 'probability') {
            const target = indexOf.get(invariant.target);
            if (target !== undefined) {
                labels.push('label "target" = pc = ' + String(target));
                pctl.push('P' + invariant.op + String(invariant.p) + ' [ F "target" ]');
            }
        }
    }
    if (forb.length)
        pctl.push('P>=1 [ G !"forbidden" ]');
    module = module + '\n' + labels.join('\n') + '\n';
    const extras = { properties: pctl.join('\n') + '\n' };
    for (const invariant of model.invariants ?? []) {
        if (invariant.kind !== 'probability' && invariant.kind !== 'never-states') {
            warnings.push('PRISM v1 does not translate invariant kind ' + invariant.kind + '.');
        }
    }
    void stateIds;
    return { format: 'prism', primary: module, extras, warnings };
}
// ------------------------------------------------------------------ SPIN ----
function exportSpin(ex) {
    const { model, indexOf } = ex;
    const warnings = [];
    const varDecl = (model.variables ?? []).map((v) => 'int ' + v.name + ' = ' + String(numValue(v.init)) + ';').join('\n');
    const lines = [];
    const promAssigns = (updates) => {
        const out = [];
        for (const u of updates ?? []) {
            const value = u.value ?? 1;
            if (u.op === 'set')
                out.push(u.variable + ' = ' + String(value));
            else if (u.op === 'inc')
                out.push(u.variable + ' = ' + u.variable + ' + ' + String(value));
            else
                out.push(u.variable + ' = ' + u.variable + ' - ' + String(value));
        }
        return out;
    };
    for (const t of model.transitions) {
        const guard = guardExpr(t.guard, '&&', '||', '!', (v) => v);
        const assigns = promAssigns(t.updates);
        const cond = guard === '' ? 'pc == ' + String(indexOf.get(t.from)) : 'pc == ' + String(indexOf.get(t.from)) + ' && ' + guard;
        const prefix = assigns.length ? ' ' + assigns.join('; ') + ';' : '';
        lines.push('    :: (' + cond + ') ->' + prefix + ' pc = ' + String(indexOf.get(t.to)) + ';');
    }
    for (const state of model.states)
        if (state.terminal)
            lines.push('    :: (pc == ' + String(indexOf.get(state.id)) + ') -> goto done;');
    const promela = '// Generated by logicprobe (Promela v1; booleans as 0/1 integers).\n' +
        'int pc = ' + String(indexOf.get(model.init) ?? 0) + ';\n' +
        (varDecl === '' ? '' : varDecl + '\n') +
        'active proctype LogicProbe() {\n' +
        '  do\n' +
        lines.join('\n') + '\n' +
        '  od\n' +
        'done: skip\n' +
        '}\n';
    const extras = {};
    const forb = forbiddenIndexes(ex);
    if (forb.length)
        extras.properties = 'ltl safety { [] (!(pc == ' + forb.map((i) => String(i)).join(') && !(pc == ') + ')) }\n';
    for (const invariant of model.invariants ?? []) {
        if (invariant.kind !== 'never-states')
            warnings.push('SPIN v1 does not translate invariant kind ' + invariant.kind + '.');
    }
    return { format: 'spin', primary: promela, extras, warnings };
}
export function exportModel(input, format) {
    const ex = prepareModel(input);
    if (format === 'uppaal')
        return exportUppaal(ex);
    if (format === 'tla')
        return exportTla(ex);
    if (format === 'prism')
        return exportPrism(ex);
    return exportSpin(ex);
}
