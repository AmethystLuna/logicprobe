#!/usr/bin/env python3
"""logicprobe-engine.py — standalone JSON-driven mirror of the logicprobe DSH engine.

Reads the same LogicModelV1 JSON schema as the DSH `logicprobe_verify` /
`logicprobe_compose_verify` / `logicprobe_export` tools and runs the same
checks (S1-S8 structural, A1-A14 adversarial, D1-D4 before/after regression,
C1/C2 composition) plus the four external-tool exporters (UPPAAL / TLA+ /
PRISM / SPIN). Pure stdlib, no third-party imports.

Usage:
  python logicprobe-engine.py verify model.json [--before-model before.json]
      [--state-mapping map.json] [--max-states N] [--max-permutation-events N]
  python logicprobe-engine.py compose m1.json m2.json [m3.json ...]
      [--rendezvous ev1,ev2] [--max-states N]
  python logicprobe-engine.py export model.json --format uppaal|tla|prism|spin

Output: JSON verification/composition report on stdout (same shape as the DSH
tool result), or the export result JSON (format / primary / extras / warnings).
"""
import argparse
import hashlib
import json
import math
import re
import sys
from collections import deque

ENGINE_SCHEMA_VERSION = 1
DEFAULT_MAX_STATES = 10000
DEFAULT_MAX_PERMUTATION_EVENTS = 5


# ---------------------------------------------------------------------------
# lossless JS-compatible helpers
# ---------------------------------------------------------------------------

def js_number(value):
    """Render a number the way JavaScript's String(number) does for the value
    ranges logicprobe models use (small integers and finite decimals)."""
    if isinstance(value, bool):
        return '1' if value else '0'
    if isinstance(value, int):
        return str(value)
    # float that is integral renders without a decimal point in JS
    if value.is_integer() and abs(value) < 1e21:
        return str(int(value))
    return repr(value)


def js_stringify(value, sort_keys=False):
    """JSON.stringify with sorted or insertion-order keys (no spaces), kept
    stable so model hashes match the TypeScript engine's stableStringify."""
    if value is None:
        return 'null'
    if value is True:
        return 'true'
    if value is False:
        return 'false'
    if isinstance(value, (int, float)):
        # JS JSON.stringify(1.0) -> '1'; python str(float) differs, so reuse js_number
        return js_number(value) if isinstance(value, float) else str(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return '[' + ','.join(js_stringify(item, sort_keys) for item in value) + ']'
    if isinstance(value, dict):
        keys = sorted(value.keys()) if sort_keys else list(value.keys())
        return '{' + ','.join(js_stringify(str(k), sort_keys) + ':' + js_stringify(value[k], sort_keys) for k in keys) + '}'
    return 'null'


def stable_stringify(value):
    return js_stringify(value, sort_keys=True)


def model_hash(model):
    return hashlib.sha256(stable_stringify(model).encode('utf-8')).hexdigest()


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def _is_plain_object(value):
    return isinstance(value, dict)


def validate_model(input_value):
    """Mirror of validateModel: returns (ok, model_or_errors)."""
    errors = []

    def bad(path, message):
        errors.append(path + ': ' + message)

    if not _is_plain_object(input_value):
        return (False, ['model: must be an object'])
    root = input_value
    if root.get('schemaVersion') != 1:
        bad('schemaVersion', 'must be 1')
    init = root.get('init')
    if not isinstance(init, str) or len(init) == 0:
        bad('init', 'must be a non-empty string')
    states = root.get('states')
    if not isinstance(states, list) or len(states) == 0:
        bad('states', 'must be a non-empty array')
    else:
        seen = set()
        for index, entry in enumerate(states):
            if not _is_plain_object(entry):
                bad('states[' + str(index) + ']', 'must be an object')
                continue
            sid = entry.get('id')
            if not isinstance(sid, str) or len(sid) == 0:
                bad('states[' + str(index) + '].id', 'must be a non-empty string')
            elif sid in seen:
                bad('states[' + str(index) + '].id', 'duplicate state id ' + str(sid))
            else:
                seen.add(sid)
            terminal = entry.get('terminal')
            if terminal is not None and not isinstance(terminal, bool):
                bad('states[' + str(index) + '].terminal', 'must be a boolean')
            for kind in ('onEntry', 'onExit'):
                actions = entry.get(kind)
                if actions is None:
                    continue
                if not isinstance(actions, list):
                    bad('states[' + str(index) + '].' + kind, 'must be an array of action names')
                elif len(actions) > 64:
                    bad('states[' + str(index) + '].' + kind, 'must not exceed 64 actions')
                else:
                    for action_index, action in enumerate(actions):
                        if not isinstance(action, str) or len(action) == 0:
                            bad('states[' + str(index) + '].' + kind + '[' + str(action_index) + ']', 'must be a non-empty string')
        if isinstance(init, str) and len(init) > 0 and init not in seen:
            bad('init', 'must name a declared state')
    transitions = root.get('transitions')
    if not isinstance(transitions, list):
        bad('transitions', 'must be an array')
    else:
        state_ids = set()
        if isinstance(states, list):
            for state in states:
                if isinstance(state, dict) and isinstance(state.get('id'), str):
                    state_ids.add(state['id'])
        for index, entry in enumerate(transitions):
            p = 'transitions[' + str(index) + ']'
            if not _is_plain_object(entry):
                bad(p, 'must be an object')
                continue
            tfrom = entry.get('from')
            if not isinstance(tfrom, str) or len(tfrom) == 0:
                bad(p + '.from', 'must be a non-empty string')
            elif tfrom not in state_ids:
                bad(p + '.from', 'unknown state ' + tfrom)
            tevent = entry.get('event')
            if not isinstance(tevent, str) or len(tevent) == 0:
                bad(p + '.event', 'must be a non-empty string')
            tto = entry.get('to')
            if not isinstance(tto, str) or len(tto) == 0:
                bad(p + '.to', 'must be a non-empty string')
            elif tto not in state_ids:
                bad(p + '.to', 'unknown state ' + tto)
            if entry.get('guard') is not None:
                _validate_guard(entry['guard'], p + '.guard', errors, bad)
            updates = entry.get('updates')
            if updates is not None:
                if not isinstance(updates, list):
                    bad(p + '.updates', 'must be an array')
                else:
                    for update_index, update in enumerate(updates):
                        up = p + '.updates[' + str(update_index) + ']'
                        if not _is_plain_object(update):
                            bad(up, 'must be an object')
                            continue
                        variable = update.get('variable')
                        if not isinstance(variable, str) or len(variable) == 0:
                            bad(up + '.variable', 'must be a non-empty string')
                        op = update.get('op')
                        if op not in ('set', 'inc', 'dec'):
                            bad(up + '.op', "must be 'set', 'inc', or 'dec'")
                        value = update.get('value')
                        if value is not None and not isinstance(value, (int, float)) or isinstance(value, bool):
                            bad(up + '.value', 'must be a number')
            cost = entry.get('cost')
            if cost is not None and (not isinstance(cost, (int, float)) or isinstance(cost, bool) or not math.isfinite(cost) or cost < 0):
                bad(p + '.cost', 'must be a non-negative finite number')
            weight = entry.get('weight')
            if weight is not None and (not isinstance(weight, (int, float)) or isinstance(weight, bool) or not math.isfinite(weight) or weight < 0):
                bad(p + '.weight', 'must be a non-negative finite number')
    if isinstance(states, list):
        for index, state in enumerate(states):
            if not isinstance(state, dict):
                continue
            mt = state.get('maxTicks')
            if mt is not None and (not isinstance(mt, int) or isinstance(mt, bool) or mt < 0):
                bad('states[' + str(index) + '].maxTicks', 'must be a non-negative integer')
    variable_names = set()
    variables = root.get('variables')
    if variables is not None:
        if not isinstance(variables, list):
            bad('variables', 'must be an array')
        else:
            for index, entry in enumerate(variables):
                p = 'variables[' + str(index) + ']'
                if not _is_plain_object(entry):
                    bad(p, 'must be an object')
                    continue
                name = entry.get('name')
                if not isinstance(name, str) or len(name) == 0:
                    bad(p + '.name', 'must be a non-empty string')
                elif name in variable_names:
                    bad(p + '.name', 'duplicate variable ' + name)
                else:
                    variable_names.add(name)
                kind = entry.get('kind')
                if kind not in ('integer', 'boolean'):
                    bad(p + '.kind', "must be 'integer' or 'boolean'")
                expected = 'bool' if kind == 'boolean' else 'number'
                init_val = entry.get('init')
                if expected == 'bool':
                    if not isinstance(init_val, bool):
                        bad(p + '.init', 'must be a boolean')
                else:
                    if not isinstance(init_val, (int, float)) or isinstance(init_val, bool):
                        bad(p + '.init', 'must be a number')
                mn = entry.get('min')
                mx = entry.get('max')
                if mn is not None and (not isinstance(mn, (int, float)) or isinstance(mn, bool)):
                    bad(p + '.min', 'must be a number')
                if mx is not None and (not isinstance(mx, (int, float)) or isinstance(mx, bool)):
                    bad(p + '.max', 'must be a number')
                if isinstance(mn, (int, float)) and not isinstance(mn, bool) and isinstance(mx, (int, float)) and not isinstance(mx, bool) and mn > mx:
                    bad(p + '.max', 'must be >= min')
                mono = entry.get('monotonic')
                if mono is not None and mono not in ('inc', 'dec'):
                    bad(p + '.monotonic', "must be 'inc' or 'dec'")
                if kind == 'integer' and isinstance(init_val, (int, float)) and not isinstance(init_val, bool):
                    if isinstance(mn, (int, float)) and not isinstance(mn, bool) and init_val < mn:
                        bad(p + '.init', 'must be >= min')
                    if isinstance(mx, (int, float)) and not isinstance(mx, bool) and init_val > mx:
                        bad(p + '.init', 'must be <= max')

    def validate_variable_ref(name, p):
        if not isinstance(name, str) or len(name) == 0:
            bad(p, 'must be a non-empty string')
        elif name not in variable_names:
            bad(p, 'references unknown variable ' + str(name))

    invariants = root.get('invariants')
    if invariants is not None:
        if not isinstance(invariants, list):
            bad('invariants', 'must be an array')
        else:
            for index, entry in enumerate(invariants):
                p = 'invariants[' + str(index) + ']'
                if not _is_plain_object(entry):
                    bad(p, 'must be an object')
                    continue
                iid = entry.get('id')
                if not isinstance(iid, str) or len(iid) == 0:
                    bad(p + '.id', 'must be a non-empty string')
                desc = entry.get('description')
                if not isinstance(desc, str):
                    bad(p + '.description', 'must be a string')
                kind = entry.get('kind')
                if kind == 'never-states':
                    s_list = entry.get('states')
                    if not isinstance(s_list, list) or len(s_list) == 0:
                        bad(p + '.states', 'must be a non-empty array')
                    else:
                        for s_index, state in enumerate(s_list):
                            if not isinstance(state, str) or len(state) == 0:
                                bad(p + '.states[' + str(s_index) + ']', 'must be a non-empty string')
                elif kind == 'var-in-range':
                    validate_variable_ref(entry.get('variable'), p + '.variable')
                    mn = entry.get('min')
                    mx = entry.get('max')
                    if mn is not None and (not isinstance(mn, (int, float)) or isinstance(mn, bool)):
                        bad(p + '.min', 'must be a number')
                    if mx is not None and (not isinstance(mx, (int, float)) or isinstance(mx, bool)):
                        bad(p + '.max', 'must be a number')
                elif kind == 'event-before-state':
                    ev = entry.get('event')
                    if not isinstance(ev, str) or len(ev) == 0:
                        bad(p + '.event', 'must be a non-empty string')
                    st = entry.get('state')
                    if not isinstance(st, str) or len(st) == 0:
                        bad(p + '.state', 'must be a non-empty string')
                elif kind == 'leads-to':
                    lfrom = entry.get('from')
                    if not isinstance(lfrom, str) or len(lfrom) == 0:
                        bad(p + '.from', 'must be a non-empty string')
                    lto = entry.get('to')
                    if not isinstance(lto, str) or len(lto) == 0:
                        bad(p + '.to', 'must be a non-empty string')
                elif kind == 'sequence':
                    evs = entry.get('events')
                    if not isinstance(evs, list) or len(evs) == 0:
                        bad(p + '.events', 'must be a non-empty array')
                    else:
                        for e_index, ev in enumerate(evs):
                            if not isinstance(ev, str) or len(ev) == 0:
                                bad(p + '.events[' + str(e_index) + ']', 'must be a non-empty string')
                elif kind == 'atomicity':
                    evs = entry.get('events')
                    if not isinstance(evs, list) or len(evs) == 0:
                        bad(p + '.events', 'must be a non-empty array')
                    else:
                        for e_index, ev in enumerate(evs):
                            if not isinstance(ev, str) or len(ev) == 0:
                                bad(p + '.events[' + str(e_index) + ']', 'must be a non-empty string')
                    cm = entry.get('commit')
                    if not isinstance(cm, str) or len(cm) == 0:
                        bad(p + '.commit', 'must be a non-empty string')
                    rb = entry.get('rollback')
                    if rb is not None and not isinstance(rb, str):
                        bad(p + '.rollback', 'must be a string')
                elif kind == 'budget':
                    budget = entry.get('budget')
                    if budget is None or not isinstance(budget, (int, float)) or isinstance(budget, bool) or not math.isfinite(budget) or budget < 0:
                        bad(p + '.budget', 'must be a non-negative finite number')
                elif kind == 'probability':
                    target = entry.get('target')
                    if not isinstance(target, str) or len(target) == 0:
                        bad(p + '.target', 'must be a non-empty string')
                    op = entry.get('op')
                    if op not in ('>=', '<=', '>', '<'):
                        bad(p + '.op', "must be one of '>=', '<=', '>', '<'")
                    pv = entry.get('p')
                    if pv is None or not isinstance(pv, (int, float)) or isinstance(pv, bool) or not math.isfinite(pv) or pv < 0 or pv > 1:
                        bad(p + '.p', 'must be a number in [0, 1]')
                else:
                    bad(p + '.kind', 'unknown invariant kind')

    concurrent_pairs = root.get('concurrentPairs')
    if concurrent_pairs is not None:
        if not isinstance(concurrent_pairs, list):
            bad('concurrentPairs', 'must be an array')
        else:
            for index, entry in enumerate(concurrent_pairs):
                p = 'concurrentPairs[' + str(index) + ']'
                if not (isinstance(entry, list) and len(entry) == 2 and isinstance(entry[0], str) and isinstance(entry[1], str)):
                    bad(p, 'must be a [event, event] string pair')
    boundary_checks = root.get('boundaryChecks')
    if boundary_checks is not None:
        if not isinstance(boundary_checks, list):
            bad('boundaryChecks', 'must be an array')
        else:
            for index, entry in enumerate(boundary_checks):
                p = 'boundaryChecks[' + str(index) + ']'
                if not _is_plain_object(entry):
                    bad(p, 'must be an object')
                    continue
                validate_variable_ref(entry.get('variable'), p + '.variable')
                values = entry.get('values')
                if not isinstance(values, list) or any(not isinstance(v, (int, float)) or isinstance(v, bool) for v in values):
                    bad(p + '.values', 'must be an array of numbers')
    idem_events = root.get('idempotentEvents')
    if idem_events is not None:
        if not isinstance(idem_events, list):
            bad('idempotentEvents', 'must be an array')
        else:
            for index, entry in enumerate(idem_events):
                if not isinstance(entry, str) or len(entry) == 0:
                    bad('idempotentEvents[' + str(index) + ']', 'must be a non-empty string')
    tick_events = root.get('tickEvents')
    if tick_events is not None:
        if not isinstance(tick_events, list):
            bad('tickEvents', 'must be an array')
        else:
            for index, entry in enumerate(tick_events):
                if not isinstance(entry, str) or len(entry) == 0:
                    bad('tickEvents[' + str(index) + ']', 'must be a non-empty string')
    resource_pairs = root.get('resourcePairs')
    if resource_pairs is not None:
        if not isinstance(resource_pairs, list):
            bad('resourcePairs', 'must be an array')
        else:
            for index, entry in enumerate(resource_pairs):
                p = 'resourcePairs[' + str(index) + ']'
                if not _is_plain_object(entry):
                    bad(p, 'must be an object')
                    continue
                resource = entry.get('resource')
                if not isinstance(resource, str) or len(resource) == 0:
                    bad(p + '.resource', 'must be a non-empty string')
                aq = entry.get('acquireEvent')
                if not isinstance(aq, str) or len(aq) == 0:
                    bad(p + '.acquireEvent', 'must be a non-empty string')
                rel = entry.get('releaseEvent')
                if not isinstance(rel, str) or len(rel) == 0:
                    bad(p + '.releaseEvent', 'must be a non-empty string')
                fail = entry.get('failEvent')
                if fail is not None and not isinstance(fail, str):
                    bad(p + '.failEvent', 'must be a string')
    narrative = root.get('narrative')
    if narrative is not None:
        np_ = 'narrative'
        if not _is_plain_object(narrative):
            bad(np_, 'must be an object')
        else:
            state_ids = set()
            if isinstance(states, list):
                for state in states:
                    if isinstance(state, dict) and isinstance(state.get('id'), str):
                        state_ids.add(state['id'])
            event_ids = set()
            if isinstance(transitions, list):
                for transition in transitions:
                    if isinstance(transition, dict) and isinstance(transition.get('event'), str):
                        event_ids.add(transition['event'])
            from_event_groups = set()
            if isinstance(transitions, list):
                for transition in transitions:
                    if isinstance(transition, dict) and isinstance(transition.get('from'), str) and isinstance(transition.get('event'), str):
                        from_event_groups.add(transition['from'] + '|' + transition['event'])
            nstates = narrative.get('states')
            if not _is_plain_object(nstates):
                bad(np_ + '.states', 'must be an object mapping state id -> natural-language description')
            else:
                for sid, description in nstates.items():
                    if sid not in state_ids:
                        bad(np_ + '.states', 'references unknown state ' + str(sid))
                    if not isinstance(description, str) or len(description) == 0:
                        bad(np_ + '.states.' + str(sid), 'must be a non-empty string')
                for sid in state_ids:
                    if not isinstance(nstates.get(sid), str):
                        bad(np_ + '.states', 'missing description for state ' + str(sid))
            nevents = narrative.get('events')
            if not _is_plain_object(nevents):
                bad(np_ + '.events', 'must be an object mapping event id -> natural-language description')
            else:
                for eid, description in nevents.items():
                    if eid not in event_ids:
                        bad(np_ + '.events', 'references unknown event ' + str(eid))
                    if not isinstance(description, str) or len(description) == 0:
                        bad(np_ + '.events.' + str(eid), 'must be a non-empty string')
                for eid in event_ids:
                    if not isinstance(nevents.get(eid), str):
                        bad(np_ + '.events', 'missing description for event ' + str(eid))
            scenarios = narrative.get('scenarios')
            if not isinstance(scenarios, list):
                bad(np_ + '.scenarios', 'must be an array of { from, event, scenario }')
            else:
                seen = set()
                for index, entry in enumerate(scenarios):
                    sp = np_ + '.scenarios[' + str(index) + ']'
                    if not _is_plain_object(entry):
                        bad(sp, 'must be an object')
                        continue
                    sfrom = entry.get('from')
                    if not isinstance(sfrom, str) or len(sfrom) == 0:
                        bad(sp + '.from', 'must be a non-empty string')
                    elif sfrom not in state_ids:
                        bad(sp + '.from', 'unknown state ' + str(sfrom))
                    sevent = entry.get('event')
                    if not isinstance(sevent, str) or len(sevent) == 0:
                        bad(sp + '.event', 'must be a non-empty string')
                    elif sevent not in event_ids:
                        bad(sp + '.event', 'unknown event ' + str(sevent))
                    scenario = entry.get('scenario')
                    if not isinstance(scenario, str) or len(scenario) == 0:
                        bad(sp + '.scenario', 'must be a non-empty string')
                    key = str(sfrom) + '|' + str(sevent)
                    if key in seen:
                        bad(sp, 'duplicate scenario for (' + str(sfrom) + ', ' + str(sevent) + ')')
                    seen.add(key)
                for key in from_event_groups:
                    if key not in seen:
                        sep = key.find('|')
                        bad(np_ + '.scenarios', 'missing scenario for (' + key[:sep] + ', ' + key[sep + 1:] + ')')
    # guard/update variable reference walk
    if isinstance(transitions, list):
        for entry in transitions:
            if not isinstance(entry, dict):
                continue
            _walk_guard_references(entry.get('guard'), variable_names, errors, bad)
            for update in entry.get('updates') or []:
                if not isinstance(update, dict):
                    continue
                variable = update.get('variable')
                if variable not in variable_names:
                    bad('transitions.updates', 'references unknown variable ' + str(variable))
    if errors:
        return (False, errors)
    return (True, root)


def _validate_guard(input_value, p, errors, bad):
    if not _is_plain_object(input_value):
        bad(p, 'must be an object')
        return
    guard = input_value
    if 'variable' in guard:
        variable = guard.get('variable')
        if not isinstance(variable, str) or len(variable) == 0:
            bad(p + '.variable', 'must be a non-empty string')
        op = guard.get('op')
        if op not in ('==', '!=', '<', '<=', '>', '>='):
            bad(p + '.op', 'must be a comparison operator')
        value = guard.get('value')
        if not isinstance(value, (int, float, bool)):
            bad(p + '.value', 'must be a number or boolean')
        return
    if 'all' in guard:
        all_list = guard.get('all')
        if not isinstance(all_list, list):
            bad(p + '.all', 'must be an array')
        else:
            for index, child in enumerate(all_list):
                _validate_guard(child, p + '.all[' + str(index) + ']', errors, bad)
        return
    if 'any' in guard:
        any_list = guard.get('any')
        if not isinstance(any_list, list):
            bad(p + '.any', 'must be an array')
        else:
            for index, child in enumerate(any_list):
                _validate_guard(child, p + '.any[' + str(index) + ']', errors, bad)
        return
    if 'not' in guard:
        _validate_guard(guard.get('not'), p + '.not', errors, bad)
        return
    bad(p, 'must be a leaf ({ variable, op, value }), { all }, { any }, or { not }')


def _walk_guard_references(guard, variable_names, errors, bad):
    if guard is None:
        return
    if 'variable' in guard:
        variable = guard.get('variable')
        if variable not in variable_names:
            bad('guard', 'references unknown variable ' + str(variable))
        return
    if 'all' in guard:
        for child in guard['all']:
            _walk_guard_references(child, variable_names, errors, bad)
        return
    if 'any' in guard:
        for child in guard['any']:
            _walk_guard_references(child, variable_names, errors, bad)
        return
    if 'not' in guard:
        _walk_guard_references(guard['not'], variable_names, errors, bad)


# ---------------------------------------------------------------------------
# execution
# ---------------------------------------------------------------------------

def _is_leaf_guard(guard):
    return 'variable' in guard


def guard_variables(guard):
    if guard is None:
        return []
    if _is_leaf_guard(guard):
        return [guard['variable']]
    if 'all' in guard:
        out = []
        for child in guard['all']:
            out.extend(guard_variables(child))
        return out
    if 'any' in guard:
        out = []
        for child in guard['any']:
            out.extend(guard_variables(child))
        return out
    if 'not' in guard:
        return guard_variables(guard['not'])
    return []


def _eval_guard(guard, vars_map):
    if _is_leaf_guard(guard):
        actual = vars_map.get(guard['variable'])
        op = guard['op']
        value = guard['value']
        if op == '==':
            return actual == value
        if op == '!=':
            return actual != value
        if op == '<':
            return actual < value
        if op == '<=':
            return actual <= value
        if op == '>':
            return actual > value
        if op == '>=':
            return actual >= value
        return False
    if 'all' in guard:
        return all(_eval_guard(child, vars_map) for child in guard['all'])
    if 'any' in guard:
        return any(_eval_guard(child, vars_map) for child in guard['any'])
    if 'not' in guard:
        return not _eval_guard(guard['not'], vars_map)
    return False


def _initial_state(model):
    vars_map = {}
    for variable in model.get('variables') or []:
        vars_map[variable['name']] = variable['init']
    return {'state': model['init'], 'vars': vars_map}


def _runtime_key(runtime):
    return runtime['state'] + '|' + stable_stringify(runtime['vars'])


def _apply_updates(model, transition, runtime):
    vars_map = dict(runtime['vars'])
    for update in transition.get('updates') or []:
        variable = update['variable']
        current = vars_map.get(variable)
        op = update['op']
        if op == 'set':
            vars_map[variable] = update.get('value', 0)
        elif op == 'inc':
            vars_map[variable] = (current if isinstance(current, (int, float)) and not isinstance(current, bool) else 0) + update.get('value', 1)
        else:
            vars_map[variable] = (current if isinstance(current, (int, float)) and not isinstance(current, bool) else 0) - update.get('value', 1)
    return {'state': transition['to'], 'vars': vars_map}


def _group_transitions(model):
    groups = {}
    for transition in model.get('transitions') or []:
        key = transition['from'] + '|' + transition['event']
        groups.setdefault(key, []).append(transition)
    return groups


def _applicable_transitions(group, runtime):
    guarded = []
    unguarded = []
    for transition in group:
        if transition.get('guard') is None:
            unguarded.append(transition)
        else:
            guarded.append(transition)
    matched = [t for t in guarded if _eval_guard(t['guard'], runtime['vars'])]
    if matched:
        return matched
    return unguarded


def _step_runtime(model, runtime, event):
    group = _group_transitions(model).get(runtime['state'] + '|' + event)
    if group is None or len(group) == 0:
        return []
    seen = set()
    outcomes = []
    for transition in _applicable_transitions(group, runtime):
        next_state = _apply_updates(model, transition, runtime)
        key = _runtime_key(next_state)
        if key not in seen:
            seen.add(key)
            outcomes.append(next_state)
    return outcomes


def _all_events(model):
    return sorted(set(t['event'] for t in model.get('transitions') or []))


def _state_by_id(model, sid):
    for state in model.get('states') or []:
        if state['id'] == sid:
            return state
    return None


def _is_terminal(model, sid):
    state = _state_by_id(model, sid)
    return state is not None and state.get('terminal') is True


def _unique_targets(transitions):
    # JS [...new Set(...)] keeps first-encounter order
    seen = set()
    out = []
    for t in transitions:
        target = t['to']
        if target not in seen:
            seen.add(target)
            out.append(target)
    return out


def _dedupe_preserve(items):
    seen = set()
    out = []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def _explore(model, max_states):
    init = _initial_state(model)
    reachable = []
    reachable_keys = set()
    queue = deque([init])
    truncated = False
    while queue:
        runtime = queue.popleft()
        key = _runtime_key(runtime)
        if key in reachable_keys:
            continue
        reachable_keys.add(key)
        reachable.append(runtime)
        if len(reachable) > max_states:
            truncated = True
            break
        for event in _all_events(model):
            for nxt in _step_runtime(model, runtime, event):
                if _runtime_key(nxt) not in reachable_keys:
                    queue.append(nxt)
    return {'reachable': reachable, 'reachable_keys': reachable_keys, 'truncated': truncated, 'initial_state': init}


def _check_result(cid, name, findings, detail):
    errors = sum(1 for f in findings if f.get('severity') == 'error')
    warnings = sum(1 for f in findings if f.get('severity') == 'warning')
    suffix = ''
    if errors > 0:
        suffix = ' (' + str(errors) + ' errors' + (', ' + str(warnings) + ' warnings' if warnings > 0 else '') + ')'
    elif warnings > 0:
        suffix = ' (' + str(warnings) + ' warnings)'
    return {'id': cid, 'name': name, 'status': 'pass' if len(findings) == 0 else 'fail', 'detail': detail + suffix, 'findings': findings}


# ---------------------------------------------------------------------------
# S1-S7
# ---------------------------------------------------------------------------

def S1_reachability(model, exploration):
    reached = set(r['state'] for r in exploration['reachable'])
    unreachable = [s['id'] for s in model.get('states') or [] if s['id'] not in reached]
    findings = [{
        'code': 'S1_UNREACHABLE_STATE',
        'severity': 'warning',
        'message': 'State ' + s + ' is not reachable from init.',
    } for s in unreachable]
    return _check_result('S1', 'Reachability', findings,
                         'All states reachable' if not unreachable else 'Unreachable states: ' + ', '.join(unreachable))


def S2_deadlock(model):
    outgoing = set(t['from'] for t in model.get('transitions') or [])
    findings = []
    for state in model.get('states') or []:
        if state.get('terminal') is True:
            continue
        if state['id'] not in outgoing:
            findings.append({
                'code': 'S2_NO_TRANSITIONS',
                'severity': 'error',
                'message': 'Non-terminal state ' + state['id'] + ' has no outgoing transitions.',
            })
    detail = 'No deadlocks' if not findings else 'Deadlocks: ' + '; '.join(f['message'] for f in findings)
    return _check_result('S2', 'Deadlock', findings, detail)


def _sccs(model):
    states = [s['id'] for s in model.get('states') or []]
    edges = {}
    for state in states:
        edges[state] = []
    for transition in model.get('transitions') or []:
        edges.setdefault(transition['from'], []).append(transition['to'])
    index = 0
    indices = {}
    low = {}
    on_stack = set()
    stack = []
    components = []

    def visit(node):
        nonlocal index
        indices[node] = index
        low[node] = index
        index += 1
        stack.append(node)
        on_stack.add(node)
        for nxt in edges.get(node) or []:
            if nxt not in indices:
                visit(nxt)
                low[node] = min(low[node], low[nxt])
            elif nxt in on_stack:
                low[node] = min(low[node], indices[nxt])
        if low[node] == indices[node]:
            component = []
            while stack:
                member = stack.pop()
                on_stack.discard(member)
                component.append(member)
                if member == node:
                    break
            components.append(component)

    for state in states:
        if state not in indices:
            visit(state)
    return components


def S3_liveness(model):
    components = _sccs(model)
    findings = []
    for component in components:
        component_set = set(component)
        internal_edges = [t for t in model.get('transitions') or [] if t['from'] in component_set and t['to'] in component_set]
        escaping_edges = [t for t in model.get('transitions') or [] if t['from'] in component_set and t['to'] not in component_set]
        if not internal_edges or escaping_edges:
            continue
        if any(_is_terminal(model, s) for s in component):
            continue
        sorted_component = sorted(component)
        findings.append({
            'code': 'S3_CLOSED_SCC',
            'severity': 'error',
            'message': 'Closed SCC has no exit and contains no terminal state: ' + ', '.join(sorted_component),
            'evidence': {'states': sorted_component, 'transitions': len(internal_edges)},
        })
    return _check_result('S3', 'Liveness', findings,
                         'No harmful closed SCCs' if not findings else 'Closed SCCs: ' + str(len(findings)))


def _guard_leaves(model):
    leaves = []

    def visit(guard):
        if 'variable' in guard:
            leaves.append(guard)
        elif 'all' in guard:
            for child in guard['all']:
                visit(child)
        elif 'any' in guard:
            for child in guard['any']:
                visit(child)
        elif 'not' in guard:
            visit(guard['not'])

    for transition in model.get('transitions') or []:
        if transition.get('guard') is not None:
            visit(transition['guard'])
    return leaves


def _collect_guard_constants(model):
    return [leaf['value'] for leaf in _guard_leaves(model) if isinstance(leaf['value'], (int, float)) and not isinstance(leaf['value'], bool)]


def _assignments_for(model, variables):
    specs = [v for v in model.get('variables') or [] if v['name'] in variables]
    combinations = [{}]
    for spec in specs:
        if spec['kind'] == 'boolean':
            values = [False, True]
        else:
            constants = [value for value in _collect_guard_constants(model)
                         if any(leaf['variable'] == spec['name'] and isinstance(leaf['value'], (int, float)) and not isinstance(leaf['value'], bool) and leaf['value'] == value
                                for leaf in _guard_leaves(model))]
            mn = spec.get('min')
            mx = spec.get('max')
            if mn is not None and mx is not None:
                values = []
                value = mn
                while value <= mx and value <= mn + 200:
                    values.append(value)
                    value += 1
            else:
                values = sorted(set([-1, 0, 1] + constants))
        nxt = []
        for assignment in combinations:
            for value in values:
                copy = dict(assignment)
                copy[spec['name']] = value
                nxt.append(copy)
                if len(nxt) > 10000:
                    return None
        combinations = nxt
    return combinations


def _analyze_guards(model):
    determinism = []
    completeness = []
    truncated = False
    groups = _group_transitions(model)
    for key, group in groups.items():
        sep = key.find('|')
        frm = key[:sep]
        event = key[sep + 1:]
        unguarded = [t for t in group if t.get('guard') is None]
        guarded = [t for t in group if t.get('guard') is not None]
        if len(unguarded) > 1:
            determinism.append({
                'code': 'S4_AMBIGUOUS_DEFAULT',
                'severity': 'error',
                'message': frm + ' + ' + event + ' has multiple unconditional transitions: ' + ', '.join(_unique_targets(unguarded)),
            })
        if len(guarded) == 0:
            continue
        variables = []
        for t in group:
            for v in guard_variables(t.get('guard')):
                if v not in variables:
                    variables.append(v)
        assignments = _assignments_for(model, variables)
        if assignments is None:
            completeness.append({'code': 'S6_UNBOUNDED_DOMAIN', 'severity': 'warning',
                                 'message': frm + ' + ' + event + ': guard domain too large to enumerate; exhaustive check skipped.'})
            truncated = True
            continue
        targets = _unique_targets(group)
        for assignment in assignments:
            true_branches = [t for t in guarded if _eval_guard(t['guard'], assignment)]
            if len(true_branches) > 1:
                determinism.append({
                    'code': 'S4_NONDETERMINISTIC_GUARDS',
                    'severity': 'error',
                    'message': frm + ' + ' + event + ' has ' + str(len(true_branches)) + ' simultaneously true guards for assignment ' + stable_stringify(assignment) + ': ' + ', '.join(_unique_targets(true_branches)),
                    'evidence': {'assignment': assignment},
                })
            if len(true_branches) == 0 and len(unguarded) == 0:
                completeness.append({
                    'code': 'S6_INCOMPLETE_GUARD',
                    'severity': 'error',
                    'message': frm + ' + ' + event + ' has no true guard and no default branch for assignment ' + stable_stringify(assignment),
                    'evidence': {'assignment': assignment, 'branches': targets},
                })
            if len(determinism) + len(completeness) > 200:
                truncated = True
                break
        if truncated:
            break
    return {'determinism': determinism, 'completeness': completeness, 'truncated': truncated}


def S4_determinism(model):
    analysis = _analyze_guards(model)
    return _check_result('S4', 'Determinism', analysis['determinism'],
                         'Deterministic' if not analysis['determinism'] else 'Nondeterminism findings: ' + str(len(analysis['determinism'])))


def S6_guard_completeness(model):
    analysis = _analyze_guards(model)
    return _check_result('S6', 'Guard Completeness', analysis['completeness'],
                         'All guard branches defined' if not analysis['completeness'] else 'Guard findings: ' + str(len(analysis['completeness'])))


def S5_event_completeness(model):
    events = _all_events(model)
    findings = []
    for state in model.get('states') or []:
        if state.get('terminal') is True:
            continue
        handled = set(t['event'] for t in model.get('transitions') or [] if t['from'] == state['id'])
        for event in events:
            if event not in handled:
                findings.append({
                    'code': 'S5_UNHANDLED_EVENT',
                    'severity': 'warning',
                    'message': state['id'] + ' silently ignores event ' + event,
                })
    return _check_result('S5', 'Event Completeness', findings,
                         'All states handle all relevant events' if not findings else str(len(findings)) + ' unhandled (state, event) pairs')


def _invariant_holds(invariant, runtime):
    kind = invariant['kind']
    if kind == 'never-states':
        return runtime['state'] not in invariant['states']
    if kind == 'var-in-range':
        value = runtime['vars'].get(invariant['variable'])
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            return False
        if invariant.get('min') is not None and value < invariant['min']:
            return False
        if invariant.get('max') is not None and value > invariant['max']:
            return False
        return True
    return True


def _shortest_event_before_state_violation(model, max_states, invariant):
    init = _initial_state(model)
    if init['state'] == invariant['state']:
        return {'invariant': invariant, 'path': [],
                'reason': 'Target state ' + invariant['state'] + ' is initial and the required event ' + invariant['event'] + ' has not occurred.'}
    key = lambda runtime, seen: _runtime_key(runtime) + '|' + ('1' if seen else '0')
    visited = set([key(init, False)])
    queue = deque([{'runtime': init, 'seen': False, 'path': []}])
    steps = 0
    while queue:
        entry = queue.popleft()
        steps += 1
        if steps > max_states:
            break
        for event in _all_events(model):
            for nxt in _step_runtime(model, entry['runtime'], event):
                seen = entry['seen'] or event == invariant['event']
                nk = key(nxt, seen)
                if nk in visited:
                    continue
                p = list(entry['path'])
                p.append({'from': entry['runtime']['state'], 'event': event, 'to': nxt['state']})
                if nxt['state'] == invariant['state'] and not seen:
                    return {'invariant': invariant, 'path': p,
                            'reason': 'Target state ' + invariant['state'] + ' is reachable without event ' + invariant['event'] + ' in ' + str(len(p)) + ' steps.'}
                visited.add(nk)
                queue.append({'runtime': nxt, 'seen': seen, 'path': p})
    return None


def _shortest_violation_for_invariant(model, max_states, invariant):
    if invariant['kind'] == 'event-before-state':
        return _shortest_event_before_state_violation(model, max_states, invariant)
    init = _initial_state(model)
    if not _invariant_holds(invariant, init):
        return {'invariant': invariant, 'path': [], 'reason': 'Initial state violates the invariant.'}
    visited = set([_runtime_key(init)])
    queue = deque([{'runtime': init, 'path': []}])
    steps = 0
    while queue:
        entry = queue.popleft()
        steps += 1
        if steps > max_states:
            break
        for event in _all_events(model):
            for nxt in _step_runtime(model, entry['runtime'], event):
                k = _runtime_key(nxt)
                if k in visited:
                    continue
                p = list(entry['path'])
                p.append({'from': entry['runtime']['state'], 'event': event, 'to': nxt['state']})
                if not _invariant_holds(invariant, nxt):
                    return {'invariant': invariant, 'path': p, 'reason': 'Invariant violated after ' + str(len(p)) + ' events.'}
                visited.add(k)
                queue.append({'runtime': nxt, 'path': p})
    return None


def _run_invariants(model, max_states):
    violations = []
    for invariant in model.get('invariants') or []:
        violation = _shortest_violation_for_invariant(model, max_states, invariant)
        if violation is not None:
            violations.append(violation)
    return violations


def S7_invariants(model, max_states):
    violations = _run_invariants(model, max_states)
    findings = []
    for violation in violations:
        invariant = violation['invariant']
        findings.append({
            'code': 'S7_INVARIANT_VIOLATION',
            'severity': 'error',
            'message': 'Invariant "' + invariant['id'] + '" (' + invariant['description'] + ') violated: ' + violation['reason'],
            'path': violation['path'],
            'evidence': {'invariant': invariant},
        })
    return _check_result('S7', 'Invariant Validity', findings,
                         'All invariants hold' if not violations else 'Invariant violations: ' + str(len(violations)))


# ---------------------------------------------------------------------------
# A1-A7
# ---------------------------------------------------------------------------

def A1_unexpected_events(model):
    events = _all_events(model)
    findings = []
    for state in model.get('states') or []:
        if state.get('terminal') is True:
            continue
        handled = set(t['event'] for t in model.get('transitions') or [] if t['from'] == state['id'])
        for event in events:
            if event not in handled:
                findings.append({
                    'code': 'A1_UNHANDLED_EVENT',
                    'severity': 'warning',
                    'message': 'Event ' + event + ' in state ' + state['id'] + ' has no defined transition (silent ignore).',
                })
    return _check_result('A1', 'Unexpected Event Injection', findings,
                         'All event/state combinations defined' if not findings else str(len(findings)) + ' unhandled combinations')


def _first_outcome(runtime, outcomes):
    return outcomes[0] if outcomes else None


def A2_race_interleaving(model, exploration):
    findings = []
    for pair in model.get('concurrentPairs') or []:
        e1, e2 = pair[0], pair[1]
        for runtime in exploration['reachable']:
            first = _first_outcome(runtime, _step_runtime(model, runtime, e1))
            second = _first_outcome(runtime, _step_runtime(model, runtime, e2))
            if first is None and second is None:
                continue
            final12 = runtime if first is None else (_first_outcome(first, _step_runtime(model, first, e2)) or first)
            final21 = runtime if second is None else (_first_outcome(second, _step_runtime(model, second, e1)) or second)
            if _runtime_key(final12) != _runtime_key(final21):
                findings.append({
                    'code': 'A2_ORDER_DEPENDENT',
                    'severity': 'warning',
                    'message': 'Events ' + e1 + ' and ' + e2 + ' produce order-dependent outcomes from state ' + runtime['state'],
                    'evidence': {'e1ThenE2': final12, 'e2ThenE1': final21},
                })
    return _check_result('A2', 'Race Interleaving', findings,
                         'No race conditions detected' if not findings else 'Order-dependent outcomes: ' + str(len(findings)))


def _step_sequence(model, init, events):
    runtime = init
    for event in events:
        nxt = _first_outcome(runtime, _step_runtime(model, runtime, event))
        if nxt is None:
            continue
        runtime = nxt
    return runtime


def _permutations(items):
    if len(items) == 0:
        return [[]]
    result = []
    for index in range(len(items)):
        rest = items[:index] + items[index + 1:]
        for suffix in _permutations(rest):
            result.append([items[index]] + suffix)
    return result


def A3_order_permutation(model, max_permutation_events):
    events = _all_events(model)[:max_permutation_events]
    if len(events) < 2:
        return _check_result('A3', 'Order Permutation', [], 'Fewer than 2 events — skipped')
    init = _initial_state(model)
    outcomes = {}
    for permutation in _permutations(events):
        final = _step_sequence(model, init, permutation)
        k = _runtime_key(final)
        lst = outcomes.setdefault(k, [])
        if len(lst) < 3:
            lst.append(','.join(permutation))
    if len(outcomes) > 1:
        examples = [{'final': k.split('|')[0], 'example': lst[0]} for k, lst in outcomes.items()]
        findings = [{
            'code': 'A3_ORDER_DEPENDENT',
            'severity': 'warning',
            'message': 'Same event set produces ' + str(len(outcomes)) + ' different outcomes depending on order.',
            'evidence': {'examples': examples},
        }]
        return _check_result('A3', 'Order Permutation', findings, 'Order-dependent outcomes: ' + str(len(outcomes)))
    return _check_result('A3', 'Order Permutation', [], 'Order-independent (sampled first ' + str(len(events)) + ' events)')


def _state_action_list(model, state_id, kind):
    state = _state_by_id(model, state_id)
    if state is None:
        return []
    return list(state.get(kind) or [])


def _actions_declared(model):
    for state in model.get('states') or []:
        if len(state.get('onEntry') or []) > 0 or len(state.get('onExit') or []) > 0:
            return True
    return False


def _apply_action_list(action_list, acquire_event, release_event, held):
    nxt = held
    reacquired = False
    for action in action_list:
        if action == acquire_event:
            if nxt:
                reacquired = True
            nxt = True
        elif action == release_event:
            nxt = False
    return {'held': nxt, 'reacquired': reacquired}


def _state_graph_edges(model):
    edges = {}
    for state in model.get('states') or []:
        edges[state['id']] = []
    for transition in model.get('transitions') or []:
        edges.setdefault(transition['from'], []).append(transition)
    return edges


def _state_graph_reachable(model, start):
    edges = {}
    for state in model.get('states') or []:
        edges[state['id']] = []
    for transition in model.get('transitions') or []:
        edges.setdefault(transition['from'], []).append(transition['to'])
    visited = set()
    queue = deque([start])
    while queue:
        current = queue.popleft()
        if current in visited:
            continue
        visited.add(current)
        for nxt in edges.get(current) or []:
            queue.append(nxt)
    return visited


def A4_pair_symmetry(model):
    findings = []
    has_actions = _actions_declared(model)
    transition_events = set(t['event'] for t in model.get('transitions') or [])
    action_events = set()
    if has_actions:
        for state in model.get('states') or []:
            for action in _state_action_list(model, state['id'], 'onEntry'):
                action_events.add(action)
            for action in _state_action_list(model, state['id'], 'onExit'):
                action_events.add(action)

    def pair_has_event(event):
        return event in transition_events or event in action_events

    def release_reachable_from(state_id, release_event):
        reachable = _state_graph_reachable(model, state_id)
        for state in reachable:
            if any(t['from'] == state and t['event'] == release_event for t in model.get('transitions') or []):
                return True
            if has_actions:
                if release_event in _state_action_list(model, state, 'onEntry') or release_event in _state_action_list(model, state, 'onExit'):
                    return True
        return False

    edges = _state_graph_edges(model)
    for pair in model.get('resourcePairs') or []:
        acquire_event = pair['acquireEvent']
        release_event = pair['releaseEvent']
        acquire_transitions = [t for t in model.get('transitions') or [] if t['event'] == acquire_event]
        action_acquire = False
        if has_actions:
            for state in model.get('states') or []:
                if acquire_event in _state_action_list(model, state['id'], 'onEntry') or acquire_event in _state_action_list(model, state['id'], 'onExit'):
                    action_acquire = True
                    break
        release_exists = pair_has_event(release_event)
        if not acquire_transitions and not action_acquire and not release_exists:
            continue
        if (acquire_transitions or action_acquire) and not release_exists:
            findings.append({
                'code': 'A4_NO_RELEASE_EVENT',
                'severity': 'error',
                'message': 'Resource "' + pair['resource'] + '": acquire event ' + acquire_event + ' exists but release event ' + release_event + ' is never defined.',
            })
            continue
        seeds = []
        for acquire in acquire_transitions:
            if not release_reachable_from(acquire['to'], release_event):
                findings.append({
                    'code': 'A4_NO_RELEASE_REACHABLE',
                    'severity': 'error',
                    'message': 'Resource "' + pair['resource'] + '": after ' + acquire_event + ' into ' + acquire['to'] + ', no ' + release_event + ' is reachable.',
                    'evidence': {'acquireTransition': acquire},
                })
                continue
            seeds.append({'state': acquire['to'], 'held': True, 'path': []})
        if has_actions:
            for state in model.get('states') or []:
                entry = _state_action_list(model, state['id'], 'onEntry')
                if acquire_event in entry:
                    sim = _apply_action_list(entry, acquire_event, release_event, False)
                    if sim['reacquired']:
                        findings.append({
                            'code': 'A4_REACQUIRE_WITHOUT_RELEASE',
                            'severity': 'warning',
                            'message': 'Resource "' + pair['resource'] + '" is acquired more than once inside onEntry of ' + state['id'] + ' before ' + release_event + '.',
                        })
                    if sim['held']:
                        seeds.append({'state': state['id'], 'held': True, 'path': []})
                exit_list = _state_action_list(model, state['id'], 'onExit')
                if acquire_event in exit_list and state.get('terminal') is not True:
                    sim = _apply_action_list(exit_list, acquire_event, release_event, False)
                    if sim['reacquired']:
                        findings.append({
                            'code': 'A4_REACQUIRE_WITHOUT_RELEASE',
                            'severity': 'warning',
                            'message': 'Resource "' + pair['resource'] + '" is acquired more than once inside onExit of ' + state['id'] + ' before ' + release_event + '.',
                        })
                    if sim['held']:
                        seeds.append({'state': state['id'], 'held': False, 'path': []})
        for seed in seeds:
            visited = set()
            queue = deque([seed])
            steps = 0
            while queue:
                entry = queue.popleft()
                steps += 1
                if steps > 1000:
                    break
                k = entry['state'] + '|' + ('1' if entry['held'] else '0')
                if k in visited:
                    continue
                visited.add(k)
                if entry['held'] and _is_terminal(model, entry['state']):
                    findings.append({
                        'code': 'A4_TERMINAL_WITH_RESOURCE',
                        'severity': 'error',
                        'message': 'Resource "' + pair['resource'] + '" is still held when entering terminal state ' + entry['state'] + '.',
                        'path': entry['path'],
                    })
                    continue
                for transition in edges.get(entry['state']) or []:
                    held = entry['held']
                    if has_actions:
                        sim = _apply_action_list(_state_action_list(model, entry['state'], 'onExit'), acquire_event, release_event, held)
                        if sim['reacquired']:
                            findings.append({
                                'code': 'A4_REACQUIRE_WITHOUT_RELEASE',
                                'severity': 'warning',
                                'message': 'Resource "' + pair['resource'] + '" is acquired again in onExit of ' + entry['state'] + ' before ' + release_event + '.',
                                'path': entry['path'],
                            })
                            continue
                        held = sim['held']
                    if transition['event'] == release_event:
                        held = False
                    elif transition['event'] == acquire_event:
                        if held:
                            findings.append({
                                'code': 'A4_REACQUIRE_WITHOUT_RELEASE',
                                'severity': 'warning',
                                'message': 'Resource "' + pair['resource'] + '" is acquired again in state ' + entry['state'] + ' before ' + release_event + '.',
                                'path': list(entry['path']) + [{'from': entry['state'], 'event': transition['event'], 'to': transition['to']}],
                            })
                            continue
                        held = True
                    if has_actions:
                        sim = _apply_action_list(_state_action_list(model, transition['to'], 'onEntry'), acquire_event, release_event, held)
                        if sim['reacquired']:
                            findings.append({
                                'code': 'A4_REACQUIRE_WITHOUT_RELEASE',
                                'severity': 'warning',
                                'message': 'Resource "' + pair['resource'] + '" is acquired again inside onEntry of ' + transition['to'] + ' before ' + release_event + '.',
                                'path': list(entry['path']) + [{'from': entry['state'], 'event': transition['event'], 'to': transition['to']}],
                            })
                            continue
                        held = sim['held']
                    queue.append({'state': transition['to'], 'held': held,
                                  'path': list(entry['path']) + [{'from': entry['state'], 'event': transition['event'], 'to': transition['to']}]})
    return _check_result('A4', 'Pair Symmetry', findings,
                         'All pairs balanced' if not findings else 'Asymmetric pairs: ' + str(len(findings)))


def A5_boundary_blast(model):
    findings = []
    for check in model.get('boundaryChecks') or []:
        variable = None
        for v in model.get('variables') or []:
            if v['name'] == check['variable']:
                variable = v
                break
        if variable is None:
            continue
        for value in check['values']:
            mn = variable.get('min')
            mx = variable.get('max')
            if mn is not None and value < mn:
                findings.append({'code': 'A5_OUT_OF_DOMAIN', 'severity': 'warning',
                                 'message': 'Boundary value ' + js_number(value) + ' for ' + check['variable'] + ' is below min ' + js_number(mn)})
            if mx is not None and value > mx:
                findings.append({'code': 'A5_OUT_OF_DOMAIN', 'severity': 'warning',
                                 'message': 'Boundary value ' + js_number(value) + ' for ' + check['variable'] + ' is above max ' + js_number(mx)})
            assignment = {}
            for v in model.get('variables') or []:
                assignment[v['name']] = v['init']
            assignment[check['variable']] = value
            for key, group in _group_transitions(model).items():
                sep = key.find('|')
                frm = key[:sep]
                event = key[sep + 1:]
                if not any(check['variable'] in guard_variables(t.get('guard')) for t in group):
                    continue
                guarded = [t for t in group if t.get('guard') is not None]
                unguarded = [t for t in group if t.get('guard') is None]
                matched = [t for t in guarded if _eval_guard(t['guard'], assignment)]
                if not matched and not unguarded:
                    findings.append({
                        'code': 'A5_GUARD_HOLE',
                        'severity': 'warning',
                        'message': frm + ' + ' + event + ' has no branch for ' + check['variable'] + '=' + js_number(value),
                        'evidence': {'assignment': assignment},
                    })
                if len(matched) > 1:
                    findings.append({
                        'code': 'A5_GUARD_OVERLAP',
                        'severity': 'warning',
                        'message': frm + ' + ' + event + ' has ' + str(len(matched)) + ' true branches for ' + check['variable'] + '=' + js_number(value),
                        'evidence': {'assignment': assignment},
                    })
    return _check_result('A5', 'Boundary Blast', findings,
                         'Boundary checks passed' if not findings else 'Boundary findings: ' + str(len(findings)))


def A6_resource_injection(model):
    findings = []
    for pair in model.get('resourcePairs') or []:
        if pair.get('failEvent') is None:
            continue
        acquire_states = set(t['from'] for t in model.get('transitions') or [] if t['event'] == pair['acquireEvent'])
        for state in acquire_states:
            handled = any(t['from'] == state and t['event'] == pair['failEvent'] for t in model.get('transitions') or [])
            if not handled:
                findings.append({
                    'code': 'A6_NO_FAILURE_HANDLER',
                    'severity': 'warning',
                    'message': 'State ' + state + ' can ' + pair['acquireEvent'] + ' for "' + pair['resource'] + '" but has no ' + pair['failEvent'] + ' transition.',
                })
    return _check_result('A6', 'Resource Injection', findings,
                         'No resource vulnerabilities detected' if not findings else 'Resource failure paths missing: ' + str(len(findings)))


def A7_shortest_violations(model, max_states):
    violations = _run_invariants(model, max_states)
    findings = []
    for violation in violations:
        invariant = violation['invariant']
        findings.append({
            'code': 'A7_SHORTEST_COUNTEREXAMPLE',
            'severity': 'warning',
            'message': 'Invariant "' + invariant['id'] + '" shortest violating path length: ' + str(len(violation['path'])) + (' (initial state)' if len(violation['path']) == 0 else ''),
            'path': violation['path'],
            'evidence': {'invariant': invariant['id']},
        })
    return _check_result('A7', 'Minimal Counter-Example', findings,
                         'All invariants hold for all reachable paths' if not violations else 'Violated invariants: ' + str(len(findings)))


def _map_state_id(mapping, state):
    return mapping.get(state, state)


def D1_behavioral_preservation(before, after, mapping):
    findings = []
    after_states = set(s['id'] for s in after.get('states') or [])
    after_by_from_event = {}
    for transition in after.get('transitions') or []:
        k = transition['from'] + '|' + transition['event']
        after_by_from_event.setdefault(k, set()).add(transition['to'])
    before_init_mapped = _map_state_id(mapping, before['init'])
    if before_init_mapped != after['init']:
        findings.append({
            'code': 'D1_INIT_MISMATCH',
            'severity': 'warning',
            'message': 'Mapped BEFORE init ' + before_init_mapped + ' does not match AFTER init ' + after['init'] + '.',
            'evidence': {'beforeInit': before['init'], 'mappedInit': before_init_mapped, 'afterInit': after['init']},
        })
    for state in before.get('states') or []:
        mapped = _map_state_id(mapping, state['id'])
        if mapped not in after_states:
            findings.append({
                'code': 'D1_MAPPED_STATE_MISSING',
                'severity': 'error',
                'message': 'BEFORE state ' + state['id'] + ' maps to ' + mapped + ', which is not declared in AFTER.',
                'evidence': {'beforeState': state['id'], 'mappedState': mapped},
            })
            continue
        for transition in [t for t in before.get('transitions') or [] if t['from'] == state['id']]:
            k = mapped + '|' + transition['event']
            targets = after_by_from_event.get(k)
            if targets is None or len(targets) == 0:
                findings.append({
                    'code': 'D1_EVENT_DISABLED',
                    'severity': 'error',
                    'message': 'BEFORE can fire event ' + transition['event'] + ' from ' + state['id'] + ' (mapped to ' + mapped + '), but AFTER has no transition for that (state, event).',
                    'path': [{'from': state['id'], 'event': transition['event'], 'to': transition['to']}],
                    'evidence': {'beforeState': state['id'], 'mappedState': mapped, 'event': transition['event']},
                })
    return _check_result('D1', 'Behavioral Preservation', findings,
                         'BEFORE event behavior is preserved in AFTER' if not findings else 'Behavioral preservation findings: ' + str(len(findings)))


def _map_invariant_for_comparison(invariant, mapping):
    out = dict(invariant)
    out['id'] = invariant['id'] + ':before'
    out['description'] = invariant['description'] + ' (from BEFORE)'
    if invariant['kind'] == 'never-states':
        out['states'] = [_map_state_id(mapping, s) for s in invariant['states']]
    elif invariant['kind'] == 'event-before-state':
        out['state'] = _map_state_id(mapping, invariant['state'])
    return out


def D2_invariant_continuity(before, after, max_states, mapping):
    findings = []
    after_states = set(s['id'] for s in after.get('states') or [])
    after_variables = set(v['name'] for v in after.get('variables') or [])
    for invariant in before.get('invariants') or []:
        mapped = _map_invariant_for_comparison(invariant, mapping)
        if mapped['kind'] == 'never-states':
            for state in mapped['states']:
                if state not in after_states:
                    findings.append({
                        'code': 'D2_MAPPED_STATE_MISSING',
                        'severity': 'warning',
                        'message': 'BEFORE invariant "' + invariant['id'] + '" maps to state ' + state + ', which is not declared in AFTER.',
                        'evidence': {'invariant': invariant['id'], 'state': state},
                    })
        elif mapped['kind'] == 'event-before-state':
            if mapped['state'] not in after_states:
                findings.append({
                    'code': 'D2_MAPPED_STATE_MISSING',
                    'severity': 'warning',
                    'message': 'BEFORE invariant "' + invariant['id'] + '" maps to state ' + mapped['state'] + ', which is not declared in AFTER.',
                    'evidence': {'invariant': invariant['id'], 'state': mapped['state']},
                })
        elif mapped['kind'] == 'var-in-range':
            if mapped['variable'] not in after_variables:
                findings.append({
                    'code': 'D2_VARIABLE_MISSING',
                    'severity': 'warning',
                    'message': 'BEFORE invariant "' + invariant['id'] + '" references variable ' + mapped['variable'] + ', which is not declared in AFTER.',
                    'evidence': {'invariant': invariant['id'], 'variable': mapped['variable']},
                })
                continue
        violation = _shortest_violation_for_invariant(after, max_states, mapped)
        if violation is not None:
            findings.append({
                'code': 'D2_INVARIANT_REGRESSION',
                'severity': 'error',
                'message': 'BEFORE invariant "' + invariant['id'] + '" no longer holds in AFTER: ' + violation['reason'],
                'path': violation['path'],
                'evidence': {'beforeInvariant': invariant, 'afterInvariant': mapped},
            })
    return _check_result('D2', 'Invariant Continuity', findings,
                         'All BEFORE invariants continue to hold' if not findings else 'Invariant continuity findings: ' + str(len(findings)))


def D3_regression_delta(before, after, mapping):
    after_state_ids = set(s['id'] for s in after.get('states') or [])
    before_mapped_ids = set(_map_state_id(mapping, s['id']) for s in before.get('states') or [])
    added_states = sorted([s['id'] for s in after.get('states') or [] if s['id'] not in before_mapped_ids])
    removed_states = sorted([s['id'] for s in before.get('states') or [] if _map_state_id(mapping, s['id']) not in after_state_ids])
    before_events = set(t['event'] for t in before.get('transitions') or [])
    after_events = set(t['event'] for t in after.get('transitions') or [])
    added_events = sorted([e for e in after_events if e not in before_events])
    removed_events = sorted([e for e in before_events if e not in after_events])

    def _same_after(candidate):
        return any(c.get('from') == _map_state_id(mapping, t.get('from')) and c.get('event') == t.get('event') and c.get('to') == _map_state_id(mapping, t.get('to'))
                   for t in before.get('transitions') or [] for c in [candidate])

    removed_transitions = [t for t in before.get('transitions') or [] if not any(
        c.get('from') == _map_state_id(mapping, t.get('from')) and c.get('event') == t.get('event') and c.get('to') == _map_state_id(mapping, t.get('to'))
        for c in after.get('transitions') or [])]
    added_transitions = [t for t in after.get('transitions') or [] if not any(
        _map_state_id(mapping, c.get('from')) == t.get('from') and c.get('event') == t.get('event') and _map_state_id(mapping, c.get('to')) == t.get('to')
        for c in before.get('transitions') or [])]
    findings = []
    for state in removed_states:
        findings.append({'code': 'D3_REMOVED_STATE', 'severity': 'warning',
                         'message': 'BEFORE state ' + state + ' is not present in AFTER under the given mapping.', 'evidence': {'state': state}})
    for event in removed_events:
        findings.append({'code': 'D3_REMOVED_EVENT', 'severity': 'warning',
                         'message': 'BEFORE event ' + event + ' is not present in AFTER.', 'evidence': {'event': event}})
    for transition in removed_transitions:
        findings.append({
            'code': 'D3_REMOVED_TRANSITION',
            'severity': 'warning',
            'message': 'BEFORE transition ' + transition['from'] + ' -' + transition['event'] + '-> ' + transition['to'] + ' has no exact AFTER counterpart.',
            'evidence': {'transition': transition},
        })
    detail = ('Delta: +' + str(len(added_states)) + ' states, -' + str(len(removed_states)) + ' states, +' + str(len(added_events)) + ' events, -' + str(len(removed_events))
              + ' events, +' + str(len(added_transitions)) + ' transitions, -' + str(len(removed_transitions)) + ' transitions')
    return _check_result('D3', 'Regression Delta', findings, detail)


def _deadlock_state_ids(model):
    outgoing = set(t['from'] for t in model.get('transitions') or [])
    return [s['id'] for s in model.get('states') or [] if s.get('terminal') is not True and s['id'] not in outgoing]


def _closed_scc_state_sets(model):
    out = []
    for component in _sccs(model):
        component_set = set(component)
        internal_edges = any(t['from'] in component_set and t['to'] in component_set for t in model.get('transitions') or [])
        escaping_edges = any(t['from'] in component_set and t['to'] not in component_set for t in model.get('transitions') or [])
        if internal_edges and not escaping_edges and not any(_is_terminal(model, s) for s in component):
            out.append(sorted(component))
    return out


def D4_deadlock_liveness_regression(before, after, mapping):
    findings = []
    before_deadlock = set(_map_state_id(mapping, s) for s in _deadlock_state_ids(before))
    after_deadlock = _deadlock_state_ids(after)
    for state in after_deadlock:
        if state not in before_deadlock:
            findings.append({
                'code': 'D4_DEADLOCK_REGRESSION',
                'severity': 'error',
                'message': 'AFTER introduces deadlock in state ' + state + ' that was not deadlocked in BEFORE.',
                'evidence': {'state': state},
            })
    before_scc = set(','.join(sorted([_map_state_id(mapping, s) for s in component])) for component in _closed_scc_state_sets(before))
    after_scc = _closed_scc_state_sets(after)
    for component in after_scc:
        key = ','.join(component)
        if key not in before_scc:
            findings.append({
                'code': 'D4_LIVENESS_REGRESSION',
                'severity': 'error',
                'message': 'AFTER introduces a closed SCC with no exit and no terminal state: ' + key,
                'evidence': {'states': component},
            })
    return _check_result('D4', 'Deadlock/Liveness Regression', findings,
                         'No new deadlock or liveness regressions' if not findings else 'Regression findings: ' + str(len(findings)))


def _build_comparison_summary(before, after, mapping):
    after_state_ids = set(s['id'] for s in after.get('states') or [])
    before_mapped_ids = set(_map_state_id(mapping, s['id']) for s in before.get('states') or [])
    added_states = sorted([s['id'] for s in after.get('states') or [] if s['id'] not in before_mapped_ids])
    removed_states = sorted([s['id'] for s in before.get('states') or [] if _map_state_id(mapping, s['id']) not in after_state_ids])
    before_events = set(t['event'] for t in before.get('transitions') or [])
    after_events = set(t['event'] for t in after.get('transitions') or [])
    added_events = sorted([e for e in after_events if e not in before_events])
    removed_events = sorted([e for e in before_events if e not in after_events])
    removed_transitions = [t for t in before.get('transitions') or [] if not any(
        c.get('from') == _map_state_id(mapping, t.get('from')) and c.get('event') == t.get('event') and c.get('to') == _map_state_id(mapping, t.get('to'))
        for c in after.get('transitions') or [])]
    added_transitions = [t for t in after.get('transitions') or [] if not any(
        _map_state_id(mapping, c.get('from')) == t.get('from') and c.get('event') == t.get('event') and _map_state_id(mapping, c.get('to')) == t.get('to')
        for c in before.get('transitions') or [])]
    return {
        'beforeModelHash': model_hash(before),
        'afterModelHash': model_hash(after),
        'stateMapping': mapping,
        'beforeStates': len(before.get('states') or []),
        'beforeTransitions': len(before.get('transitions') or []),
        'afterStates': len(after.get('states') or []),
        'afterTransitions': len(after.get('transitions') or []),
        'addedStates': added_states,
        'removedStates': removed_states,
        'addedEvents': added_events,
        'removedEvents': removed_events,
        'addedTransitions': added_transitions,
        'removedTransitions': removed_transitions,
    }


def A8_idempotent_replay(model, exploration):
    events = model.get('idempotentEvents') or []
    findings = []
    for event in events:
        for runtime in exploration['reachable']:
            once_options = _step_runtime(model, runtime, event)
            if not once_options:
                continue
            for once in once_options:
                twice_options = _step_runtime(model, once, event)
                if not twice_options:
                    findings.append({
                        'code': 'A8_NOT_REPLAYABLE',
                        'severity': 'warning',
                        'message': 'Idempotent event ' + event + ' is not replayable after first application from ' + runtime['state'] + '.',
                        'path': [{'from': runtime['state'], 'event': event, 'to': once['state']}],
                        'evidence': {'state': runtime['state'], 'event': event},
                    })
                    continue
                for twice in twice_options:
                    if _runtime_key(twice) != _runtime_key(once):
                        findings.append({
                            'code': 'A8_NOT_IDEMPOTENT',
                            'severity': 'error',
                            'message': 'Idempotent event ' + event + ' changes state when applied twice from ' + runtime['state'] + '.',
                            'path': [{'from': runtime['state'], 'event': event, 'to': once['state']},
                                     {'from': once['state'], 'event': event, 'to': twice['state']}],
                            'evidence': {'state': runtime['state'], 'event': event, 'afterOnce': once, 'afterTwice': twice},
                        })
                        break
    return _check_result('A8', 'Idempotent Replay', findings,
                         'Idempotent events are replay-safe' if not findings else 'Idempotent replay findings: ' + str(len(findings)))


def S8_monotonic_variables(model):
    findings = []
    for variable in model.get('variables') or []:
        if variable.get('monotonic') is None:
            continue
        for transition in model.get('transitions') or []:
            for update in transition.get('updates') or []:
                if update['variable'] != variable['name']:
                    continue
                if variable['monotonic'] == 'inc' and update['op'] == 'dec':
                    findings.append({'code': 'S8_MONOTONIC_DECREASE', 'severity': 'error',
                                     'message': 'Monotonic (inc) variable ' + variable['name'] + ' is decreased by ' + transition['event'] + '.',
                                     'evidence': {'variable': variable['name'], 'transition': transition}})
                elif variable['monotonic'] == 'dec' and update['op'] == 'inc':
                    findings.append({'code': 'S8_MONOTONIC_INCREASE', 'severity': 'error',
                                     'message': 'Monotonic (dec) variable ' + variable['name'] + ' is increased by ' + transition['event'] + '.',
                                     'evidence': {'variable': variable['name'], 'transition': transition}})
                elif update['op'] == 'set':
                    findings.append({'code': 'S8_MONOTONIC_SET_REVIEW', 'severity': 'warning',
                                     'message': 'Monotonic variable ' + variable['name'] + ' uses set in ' + transition['event'] + '; verify it cannot move backwards.',
                                     'evidence': {'variable': variable['name'], 'transition': transition}})
    return _check_result('S8', 'Monotonic Variables', findings,
                         'Monotonic variables are respected' if not findings else 'Monotonic findings: ' + str(len(findings)))


def _find_leads_to_bad_path(model, start, target):
    if start['state'] == target:
        return None
    visited = set()
    queue = deque([{'runtime': start, 'path': []}])
    while queue:
        entry = queue.popleft()
        k = _runtime_key(entry['runtime'])
        if entry['runtime']['state'] == target:
            continue
        if k in visited:
            return {'path': entry['path'], 'reason': 'Cycle avoids target ' + target}
        visited.add(k)
        nexts = []
        for event in _all_events(model):
            for nxt in _step_runtime(model, entry['runtime'], event):
                nexts.append({'next': nxt, 'event': event})
        if not nexts:
            return {'path': entry['path'], 'reason': 'Dead end before target ' + target}
        for item in nexts:
            queue.append({'runtime': item['next'],
                          'path': list(entry['path']) + [{'from': entry['runtime']['state'], 'event': item['event'], 'to': item['next']['state']}]})
    return {'path': [], 'reason': 'No path reaches target ' + target}


def A9_leads_to(model, exploration):
    findings = []
    for invariant in model.get('invariants') or []:
        if invariant['kind'] != 'leads-to':
            continue
        for runtime in exploration['reachable']:
            if runtime['state'] != invariant['from']:
                continue
            bad = _find_leads_to_bad_path(model, runtime, invariant['to'])
            if bad is not None:
                findings.append({
                    'code': 'A9_LEADS_TO_VIOLATION',
                    'severity': 'error',
                    'message': 'Leads-to invariant "' + invariant['id'] + '" violated from ' + invariant['from'] + ': ' + bad['reason'],
                    'path': bad['path'],
                    'evidence': {'invariant': invariant},
                })
                break
    return _check_result('A9', 'Leads-To', findings,
                         'All leads-to invariants hold' if not findings else 'Leads-to findings: ' + str(len(findings)))


def _find_sequence_violation(model, max_states, invariant):
    events = invariant['events']
    init = _initial_state(model)

    def key(runtime, progress):
        return _runtime_key(runtime) + '|' + str(progress)

    visited = set([key(init, 0)])
    queue = deque([{'runtime': init, 'progress': 0, 'path': []}])
    steps = 0
    while queue:
        entry = queue.popleft()
        steps += 1
        if steps > max_states:
            break
        for event in _all_events(model):
            for nxt in _step_runtime(model, entry['runtime'], event):
                progress = entry['progress']
                violation = False
                if progress < len(events) and event == events[progress]:
                    progress += 1
                else:
                    if event in events:
                        index = events.index(event)
                        if index > progress:
                            violation = True
                p = list(entry['path'])
                p.append({'from': entry['runtime']['state'], 'event': event, 'to': nxt['state']})
                if violation:
                    return {'invariant': invariant, 'path': p, 'reason': 'Event ' + event + ' occurred before ' + events[progress]}
                nk = key(nxt, progress)
                if nk not in visited:
                    visited.add(nk)
                    queue.append({'runtime': nxt, 'progress': progress, 'path': p})
    return None


def A10_sequence_order(model, max_states):
    findings = []
    for invariant in model.get('invariants') or []:
        if invariant['kind'] != 'sequence':
            continue
        violation = _find_sequence_violation(model, max_states, invariant)
        if violation is not None:
            findings.append({
                'code': 'A10_SEQUENCE_VIOLATION',
                'severity': 'error',
                'message': 'Sequence invariant "' + invariant['id'] + '" violated: ' + violation['reason'],
                'path': violation['path'],
                'evidence': {'invariant': invariant},
            })
    return _check_result('A10', 'Sequence Order', findings,
                         'All sequence invariants hold' if not findings else 'Sequence findings: ' + str(len(findings)))


def _find_atomicity_violation(model, max_states, invariant):
    atomic = set(invariant['events'])
    init = _initial_state(model)

    def key(runtime, started, closed):
        return _runtime_key(runtime) + '|' + ('1' if started else '0') + '|' + ('1' if closed else '0')

    visited = set([key(init, False, False)])
    queue = deque([{'runtime': init, 'started': False, 'closed': False, 'path': []}])
    steps = 0
    while queue:
        entry = queue.popleft()
        steps += 1
        if steps > max_states:
            break
        for event in _all_events(model):
            for nxt in _step_runtime(model, entry['runtime'], event):
                started = entry['started'] or event in atomic
                closed = entry['closed'] or event == invariant['commit'] or (invariant.get('rollback') is not None and event == invariant['rollback'])
                p = list(entry['path'])
                p.append({'from': entry['runtime']['state'], 'event': event, 'to': nxt['state']})
                if entry['started'] and not entry['closed'] and event not in atomic and event != invariant['commit'] and event != invariant.get('rollback'):
                    return {'invariant': invariant, 'path': p, 'reason': 'Left atomic scope via ' + event + ' without commit/rollback'}
                if started and not closed and _is_terminal(model, nxt['state']):
                    return {'invariant': invariant, 'path': p, 'reason': 'Terminal state reached with incomplete atomic group'}
                nk = key(nxt, started, closed)
                if nk not in visited:
                    visited.add(nk)
                    queue.append({'runtime': nxt, 'started': started, 'closed': closed, 'path': p})
    return None


def A11_atomicity(model, max_states):
    findings = []
    for invariant in model.get('invariants') or []:
        if invariant['kind'] != 'atomicity':
            continue
        violation = _find_atomicity_violation(model, max_states, invariant)
        if violation is not None:
            findings.append({
                'code': 'A11_ATOMICITY_VIOLATION',
                'severity': 'error',
                'message': 'Atomicity invariant "' + invariant['id'] + '" violated: ' + violation['reason'],
                'path': violation['path'],
                'evidence': {'invariant': invariant},
            })
    return _check_result('A11', 'Atomicity', findings,
                         'All atomicity invariants hold' if not findings else 'Atomicity findings: ' + str(len(findings)))


# ---------------------------------------------------------------------------
# A12 — Budget (worst-case path cost)
# ---------------------------------------------------------------------------

def _transition_cost(transition):
    return transition.get('cost', 1)


def _runtime_graph(model, max_states):
    group_map = _group_transitions(model)
    exploration = _explore(model, max_states)
    edges = {}
    for runtime in exploration['reachable']:
        out = []
        for event in _all_events(model):
            group = group_map.get(runtime['state'] + '|' + event)
            if group is None or len(group) == 0:
                continue
            for transition in _applicable_transitions(group, runtime):
                nxt = _apply_updates(model, transition, runtime)
                out.append({
                    'to': _runtime_key(nxt),
                    'step': {'from': runtime['state'], 'event': transition['event'], 'to': nxt['state']},
                    'cost': _transition_cost(transition),
                })
        edges[_runtime_key(runtime)] = out
    return {
        'edges': edges,
        'keys': [_runtime_key(r) for r in exploration['reachable']],
        'initKey': _runtime_key(exploration['initial_state']),
    }


def _key_of_from_step(graph, step, target_key):
    for frm, out_edges in graph['edges'].items():
        for edge in out_edges:
            if (edge['to'] == target_key and edge['step'].get('event') == step.get('event')
                    and edge['step'].get('from') == step.get('from') and edge['step'].get('to') == step.get('to')):
                return frm
    return graph['initKey']


def _runtime_path_to_key(graph, target_key):
    parent = {}
    visited = set([graph['initKey']])
    queue = deque([graph['initKey']])
    while queue:
        current = queue.popleft()
        if current == target_key:
            steps = []
            k = target_key
            while k != graph['initKey']:
                step = parent.get(k)
                if step is None:
                    break
                steps.insert(0, step)
                k = _key_of_from_step(graph, step, k)
            return steps
        for edge in graph['edges'].get(current) or []:
            if edge['to'] in visited:
                continue
            visited.add(edge['to'])
            parent[edge['to']] = edge['step']
            queue.append(edge['to'])
    return None


def _find_unbounded_cycle(model, max_states):
    graph = _runtime_graph(model, max_states)
    color = {}
    for start in graph['keys']:
        if start in color:
            continue
        node_stack = [start]
        idx_stack = [0]
        depth_of = {start: 0}
        cost_at = {start: 0}
        prev_key = {}
        prev_step = {}
        color[start] = 1
        while node_stack:
            node = node_stack[-1]
            outs = graph['edges'].get(node) or []
            if idx_stack[-1] < len(outs):
                edge = outs[idx_stack[-1]]
                idx_stack[-1] += 1
                seen = color.get(edge['to'])
                if seen is None:
                    color[edge['to']] = 1
                    depth_of[edge['to']] = depth_of[node] + 1
                    cost_at[edge['to']] = cost_at[node] + edge['cost']
                    prev_key[edge['to']] = node
                    prev_step[edge['to']] = edge['step']
                    node_stack.append(edge['to'])
                    idx_stack.append(0)
                elif seen == 1:
                    cycle_cost = cost_at[node] + edge['cost'] - cost_at[edge['to']]
                    if cycle_cost > 0:
                        entry = _runtime_path_to_key(graph, edge['to']) or []
                        round_steps = []
                        cursor = node
                        while cursor != edge['to'] and cursor in prev_step:
                            round_steps.insert(0, prev_step[cursor])
                            cursor = prev_key[cursor]
                        round_steps.append(edge['step'])
                        return list(entry) + round_steps
            else:
                color[node] = 2
                node_stack.pop()
                idx_stack.pop()
                depth_of.pop(node, None)
                cost_at.pop(node, None)
                prev_key.pop(node, None)
                prev_step.pop(node, None)
    return None


def _find_budget_violation(model, max_states, invariant):
    group_map = _group_transitions(model)
    init = _initial_state(model)
    best_cost = {_runtime_key(init): 0}
    queue = deque([{'runtime': init, 'cost': 0, 'path': []}])
    steps = 0
    while queue:
        entry = queue.popleft()
        steps += 1
        if steps > max_states:
            break
        for event in _all_events(model):
            group = group_map.get(entry['runtime']['state'] + '|' + event)
            if group is None or len(group) == 0:
                continue
            for transition in _applicable_transitions(group, entry['runtime']):
                nxt = _apply_updates(model, transition, entry['runtime'])
                cost = entry['cost'] + _transition_cost(transition)
                p = list(entry['path'])
                p.append({'from': entry['runtime']['state'], 'event': transition['event'], 'to': nxt['state']})
                if cost > invariant['budget']:
                    return {'path': p, 'cost': cost, 'unbounded': False}
                k = _runtime_key(nxt)
                best = best_cost.get(k)
                if best is None or cost < best:
                    best_cost[k] = cost
                    queue.append({'runtime': nxt, 'cost': cost, 'path': p})
    cycle = _find_unbounded_cycle(model, max_states)
    if cycle is not None:
        return {'path': cycle, 'unbounded': True}
    return None


def A12_budget(model, max_states):
    budgets = [inv for inv in model.get('invariants') or [] if inv['kind'] == 'budget']
    uses_cost = any(t.get('cost') is not None for t in model.get('transitions') or [])
    findings = []
    if uses_cost and not budgets:
        findings.append({
            'code': 'A12_COST_WITHOUT_BUDGET',
            'severity': 'warning',
            'message': 'Transitions declare cost, but no budget invariant is declared, so worst-case path cost is not verified. Add an invariant of kind budget to check it.',
        })
    for invariant in budgets:
        violation = _find_budget_violation(model, max_states, invariant)
        if violation is not None:
            if violation['unbounded']:
                message = ('Budget invariant "' + invariant['id'] + '" (' + invariant['description']
                           + ') exceeded: a reachable positive-cost cycle lets path cost grow without bound, so no finite budget '
                           + js_number(invariant['budget']) + ' holds.')
                evidence = {'invariant': invariant, 'unbounded': True}
            else:
                message = ('Budget invariant "' + invariant['id'] + '" (' + invariant['description']
                           + ') exceeded: worst-case path cost ' + js_number(violation['cost']) + ' is over budget '
                           + js_number(invariant['budget']) + '.')
                evidence = {'invariant': invariant, 'totalCost': violation['cost'], 'unbounded': False}
            findings.append({'code': 'A12_BUDGET_OVER', 'severity': 'error', 'message': message,
                             'path': violation['path'], 'evidence': evidence})
    if not findings:
        detail = 'No budget invariants declared' if not budgets else 'All budget invariants hold'
    else:
        detail = 'Budget findings: ' + str(len(findings))
    return _check_result('A12', 'Budget', findings, detail)


# ---------------------------------------------------------------------------
# A13 — Probability reachability (DTMC)
# ---------------------------------------------------------------------------

def _probability_outcomes(model, runtime):
    group_map = _group_transitions(model)
    outcomes = {}
    for event in _all_events(model):
        group = group_map.get(runtime['state'] + '|' + event)
        if group is None or len(group) == 0:
            continue
        for transition in _applicable_transitions(group, runtime):
            weight = transition.get('weight', 1)
            if not (weight > 0):
                continue
            nxt = _apply_updates(model, transition, runtime)
            k = _runtime_key(nxt)
            if k not in outcomes:
                outcomes[k] = {'state': nxt['state'], 'weight': weight}
            else:
                outcomes[k]['weight'] += weight
    return outcomes


def _compute_hit_probability(model, max_states, target_state):
    exploration = _explore(model, max_states)
    reachable = exploration['reachable']
    n = len(reachable)
    key_index = {}
    for i, runtime in enumerate(reachable):
        key_index[_runtime_key(runtime)] = i
    fixed_value = [None] * n
    chains = []
    for i in range(n):
        runtime = reachable[i]
        if runtime['state'] == target_state:
            fixed_value[i] = 1
            chains.append([])
            continue
        outs = _probability_outcomes(model, runtime)
        total = 0.0
        lst = []
        for k, entry in outs.items():
            j = key_index.get(k)
            if j is None:
                continue
            lst.append({'j': j, 'w': entry['weight']})
            total += entry['weight']
        if total <= 0:
            fixed_value[i] = 0
            chains.append([])
            continue
        chains.append([{'j': item['j'], 'w': item['w'] / total} for item in lst])
    p = [0.0] * n
    converged = False
    for _iter in range(20000):
        max_delta = 0.0
        for i in range(n):
            if fixed_value[i] is not None:
                continue
            lst = chains[i]
            acc = 0.0
            for item in lst:
                fixed = fixed_value[item['j']]
                acc += item['w'] * (p[item['j']] if fixed is None else fixed)
            delta = abs(acc - p[i])
            if delta > max_delta:
                max_delta = delta
            p[i] = acc
        if max_delta < 1e-9:
            converged = True
            break
    init_index = key_index.get(_runtime_key(exploration['initial_state']), 0)
    fixed = fixed_value[init_index]
    return {'probability': p[init_index] if fixed is None else fixed, 'converged': converged}


def A13_probability(model, max_states):
    findings = []
    eps = 1e-9
    for invariant in model.get('invariants') or []:
        if invariant['kind'] != 'probability':
            continue
        result = _compute_hit_probability(model, max_states, invariant['target'])
        probability = result['probability']
        converged = result['converged']
        op = invariant['op']
        p_bound = invariant['p']
        violated = False
        if op == '>=':
            violated = probability < p_bound - eps
        elif op == '>':
            violated = probability <= p_bound + eps
        elif op == '<=':
            violated = probability > p_bound + eps
        else:
            violated = probability >= p_bound - eps
        if violated:
            findings.append({
                'code': 'A13_PROBABILITY_VIOLATION',
                'severity': 'error',
                'message': ('Probability invariant "' + invariant['id'] + '" (' + invariant['description']
                            + ') violated: P(hit ' + invariant['target'] + ') = ' + format(probability, '.6f')
                            + ' does not satisfy ' + op + ' ' + js_number(p_bound) + '.'),
                'evidence': {'invariant': invariant, 'computed': probability, 'converged': converged},
            })
        elif not converged:
            findings.append({
                'code': 'A13_NO_CONVERGENCE',
                'severity': 'warning',
                'message': ('Probability invariant "' + invariant['id'] + '" passes, but value iteration did not fully converge within the iteration cap.'),
                'evidence': {'invariant': invariant, 'computed': probability, 'converged': converged},
            })
    return _check_result('A13', 'Probability Reachability', findings,
                         'No probability invariants declared or all hold' if not findings else 'Probability findings: ' + str(len(findings)))


# ---------------------------------------------------------------------------
# A14 — Deadline (discrete tick clock)
# ---------------------------------------------------------------------------

def A14_deadline(model, max_states):
    findings = []
    tick_events = set(model.get('tickEvents') or [])
    limits = {}
    has_limit = False
    for state in model.get('states') or []:
        if state.get('maxTicks') is not None:
            limits[state['id']] = state['maxTicks']
            has_limit = True
    if not has_limit:
        return _check_result('A14', 'Deadline', [], 'No state declares maxTicks')
    if not tick_events:
        return _check_result('A14', 'Deadline', [{
            'code': 'A14_NO_TICK_EVENTS',
            'severity': 'warning',
            'message': 'States declare maxTicks, but no tickEvents are declared, so deadline compliance cannot be verified.',
        }], 'Missing tick events')
    group_map = _group_transitions(model)
    init = _initial_state(model)
    queue = deque([{'runtime': init, 'ticks': 0, 'path': []}])
    seen = set()
    steps = 0
    while queue:
        entry = queue.popleft()
        steps += 1
        if steps > max_states:
            break
        k = _runtime_key(entry['runtime']) + '|' + str(entry['ticks'])
        if k in seen:
            continue
        seen.add(k)
        for event in _all_events(model):
            group = group_map.get(entry['runtime']['state'] + '|' + event)
            if group is None or len(group) == 0:
                continue
            for transition in _applicable_transitions(group, entry['runtime']):
                nxt = _apply_updates(model, transition, entry['runtime'])
                is_tick = event in tick_events
                stays = nxt['state'] == entry['runtime']['state']
                p = list(entry['path'])
                p.append({'from': entry['runtime']['state'], 'event': transition['event'], 'to': nxt['state']})
                if is_tick and stays:
                    lim = limits.get(nxt['state'])
                    if lim is not None and entry['ticks'] + 1 > lim:
                        findings.append({
                            'code': 'A14_DEADLINE_MISS',
                            'severity': 'error',
                            'message': 'Deadline missed: state ' + nxt['state'] + ' can remain resident for more than ' + js_number(lim) + ' tick(s).',
                            'path': p,
                            'evidence': {'state': nxt['state'], 'maxTicks': lim, 'ticks': entry['ticks'] + 1},
                        })
                        continue
                    ticks = entry['ticks'] + 1
                elif is_tick and not stays:
                    ticks = 0
                elif not is_tick and stays:
                    ticks = entry['ticks']
                else:
                    ticks = 0
                nk = _runtime_key(nxt) + '|' + str(ticks)
                if nk not in seen:
                    queue.append({'runtime': nxt, 'ticks': ticks, 'path': p})
    return _check_result('A14', 'Deadline', findings,
                         'All deadlines respected' if not findings else 'Deadline findings: ' + str(len(findings)))


# ---------------------------------------------------------------------------
# Coverage notes (informational gap notices)
# ---------------------------------------------------------------------------

_TIMING_RE = re.compile(r'(?<![a-z0-9])(timeout|watchdog|timer|tick|deadline|period|delay|elapsed|latency)(?![a-z0-9])', re.IGNORECASE)
_PREEMPTION_RE = re.compile(r'(?<![a-z0-9])(isr|irq|interrupt|task|thread|preempt|rtos)(?![a-z0-9])', re.IGNORECASE)
_HYBRID_RE = re.compile(r'(?<![a-z0-9])(pid|plant|feedback|control.?loop|stability|stable|settling|damping|oscillat|chatter|kalman|foc|field.?weaken|motor|torque)(?![a-z0-9])', re.IGNORECASE)
_PROBABILISTIC_RE = re.compile(r'(?<![a-z0-9])(mtbf|mttf|failure.?rate|reliability|probability|probabilistic|markov|stochastic|fault.?tree|fmea)(?![a-z0-9])', re.IGNORECASE)


def compute_coverage_notes(model):
    names = []
    for state in model.get('states') or []:
        names.append(state['id'])
        for action in state.get('onEntry') or []:
            names.append(action)
        for action in state.get('onExit') or []:
            names.append(action)
    for transition in model.get('transitions') or []:
        names.append(transition['event'])
    corpus = ' '.join(names)
    notes = []
    if _TIMING_RE.search(corpus):
        notes.append('The model references time-like vocabulary (timeout/watchdog/timer/deadline...). logicprobe verifies ordering, counts, and path budgets (A12) but not hard real-time semantics: deadlines, periods, and clock invariants need a timed model checker (e.g. UPPAAL).')
    if _PREEMPTION_RE.search(corpus):
        notes.append('The model references preemption/concurrency vocabulary (ISR/IRQ/task/interrupt...). logicprobe models event-order interleavings (A2/A3) but not preemptive concurrency; absolute claims such as thread-safe or interrupt-safe need dedicated verification (TSan, CBMC, or a model checker such as TLA+).')
    if _HYBRID_RE.search(corpus):
        notes.append('The model references control/hybrid vocabulary (pid/plant/feedback/stability/motor...). logicprobe verifies discrete transitions only; stability, settling time, and mode-switch dynamics over a continuous plant need hybrid verification (SpaceEx, Flow*, or Simulink/Stateflow analysis).')
    if _PROBABILISTIC_RE.search(corpus):
        notes.append('The model references probabilistic/reliability vocabulary (mtbf/failure rate/probability...). logicprobe is a qualitative model checker; reliability or probability claims need a stochastic model checker (PRISM, Storm) or fault-tree analysis.')
    return notes


# ---------------------------------------------------------------------------
# main entry
# ---------------------------------------------------------------------------

def run_verification(input_value, options=None):
    if options is None:
        options = {}
    max_states = options.get('maxStates', DEFAULT_MAX_STATES)
    max_permutation_events = options.get('maxPermutationEvents', DEFAULT_MAX_PERMUTATION_EVENTS)
    ok_model, model_or_errors = validate_model(input_value)
    if not ok_model:
        errors = model_or_errors
        return {
            'ok': False,
            'schemaVersion': 1,
            'modelHash': '',
            'summary': {'states': 0, 'transitions': 0, 'errors': len(errors), 'warnings': 0, 'checksRun': 0},
            'checks': [{
                'id': 'MODEL',
                'name': 'Model Validation',
                'status': 'fail',
                'detail': 'Model schema validation failed: ' + str(len(errors)) + ' errors',
                'findings': [{'code': 'MODEL_INVALID', 'severity': 'error', 'message': message} for message in errors],
            }],
        }
    model = model_or_errors
    exploration = _explore(model, max_states)
    checks = [
        S1_reachability(model, exploration),
        S2_deadlock(model),
        S3_liveness(model),
        S4_determinism(model),
        S5_event_completeness(model),
        S6_guard_completeness(model),
        S7_invariants(model, max_states),
        S8_monotonic_variables(model),
        A1_unexpected_events(model),
        A2_race_interleaving(model, exploration),
        A3_order_permutation(model, max_permutation_events),
        A4_pair_symmetry(model),
        A5_boundary_blast(model),
        A6_resource_injection(model),
        A7_shortest_violations(model, max_states),
        A8_idempotent_replay(model, exploration),
        A9_leads_to(model, exploration),
        A10_sequence_order(model, max_states),
        A11_atomicity(model, max_states),
        A12_budget(model, max_states),
        A13_probability(model, max_states),
        A14_deadline(model, max_states),
    ]
    comparison = None
    before_model = options.get('beforeModel')
    if before_model is not None:
        before_ok, before_or_errors = validate_model(before_model)
        if not before_ok:
            before_errors = before_or_errors
            return {
                'ok': False,
                'schemaVersion': 1,
                'modelHash': model_hash(model),
                'summary': {
                    'states': len(model.get('states') or []),
                    'transitions': len(model.get('transitions') or []),
                    'errors': len(before_errors),
                    'warnings': 0,
                    'checksRun': len(checks) + 1,
                    'truncated': exploration['truncated'],
                },
                'checks': list(checks) + [{
                    'id': 'BEFORE_MODEL',
                    'name': 'Before Model Validation',
                    'status': 'fail',
                    'detail': 'Before model schema validation failed: ' + str(len(before_errors)) + ' errors',
                    'findings': [{'code': 'BEFORE_MODEL_INVALID', 'severity': 'error', 'message': message} for message in before_errors],
                }],
            }
        before = before_or_errors
        mapping = options.get('stateMapping') or {}
        checks.append(D1_behavioral_preservation(before, model, mapping))
        checks.append(D2_invariant_continuity(before, model, max_states, mapping))
        checks.append(D3_regression_delta(before, model, mapping))
        checks.append(D4_deadlock_liveness_regression(before, model, mapping))
        comparison = _build_comparison_summary(before, model, mapping)
    errors = sum(1 for check in checks for f in check['findings'] if f.get('severity') == 'error')
    warnings = sum(1 for check in checks for f in check['findings'] if f.get('severity') == 'warning')
    coverage_notes = compute_coverage_notes(model)
    report = {
        'ok': True,
        'schemaVersion': 1,
        'modelHash': model_hash(model),
        'summary': {
            'states': len(model.get('states') or []),
            'transitions': len(model.get('transitions') or []),
            'errors': errors,
            'warnings': warnings,
            'checksRun': len(checks),
            'truncated': exploration['truncated'],
        },
        'checks': checks,
    }
    if model.get('narrative') is not None:
        report['narrative'] = model['narrative']
    if comparison is not None:
        report['comparison'] = comparison
    if coverage_notes:
        report['coverageNotes'] = coverage_notes
    return report


# ---------------------------------------------------------------------------
# Composition verification (N machines)
# ---------------------------------------------------------------------------

def run_composition_verification(machines_input, options=None):
    if options is None:
        options = {}
    rendezvous_set = set(options.get('rendezvous') or [])
    max_states = options.get('maxStates', DEFAULT_MAX_STATES)
    models = []
    hashes = []
    model_findings = []
    for index, input_value in enumerate(machines_input):
        ok_model, model_or_errors = validate_model(input_value)
        if not ok_model:
            model_findings.append({'code': 'MODEL_INVALID', 'severity': 'error',
                                   'message': 'machine ' + str(index) + ' invalid: ' + '; '.join(model_or_errors)})
        else:
            models.append(model_or_errors)
            hashes.append(model_hash(model_or_errors))
    machine_summary = [{'modelHash': hashes[i] if i < len(hashes) else '', 'states': len(m['states'] or []), 'transitions': len(m['transitions'] or [])}
                       for i, m in enumerate(models)]
    if model_findings or len(models) < 2:
        if len(models) < 2 and not model_findings:
            model_findings.append({'code': 'MODEL_INVALID', 'severity': 'error',
                                   'message': 'composition requires at least two machines'})
        return {
            'ok': False,
            'summary': {'machineCount': len(models), 'machines': machine_summary, 'compositeStates': 0,
                        'errors': len(model_findings), 'warnings': 0, 'truncated': False},
            'checks': [{'id': 'MODEL', 'name': 'Machine Validation', 'status': 'fail',
                        'detail': 'composition input validation failed', 'findings': model_findings}],
        }
    machine_event_sets = [set(t['event'] for t in m.get('transitions') or []) for m in models]

    def composition_moves(node):
        moves = []
        for i in range(len(models)):
            if _is_terminal(models[i], node['runtimes'][i]['state']):
                continue
            for event in _all_events(models[i]):
                if event in rendezvous_set:
                    continue
                for nxt in _step_runtime(models[i], node['runtimes'][i], event):
                    runtimes = list(node['runtimes'])
                    runtimes[i] = nxt
                    moves.append({'next': {'runtimes': runtimes, 'path': []}, 'event': event, 'machines': [i]})
        for event in rendezvous_set:
            participants = []
            for i in range(len(models)):
                if _is_terminal(models[i], node['runtimes'][i]['state']):
                    continue
                if event not in machine_event_sets[i]:
                    continue
                participants.append(i)
            if len(participants) < 2:
                continue
            outcomes = [_step_runtime(models[i], node['runtimes'][i], event) for i in participants]
            if any(len(lst) == 0 for lst in outcomes):
                continue
            combos = [list(node['runtimes'])]
            for slot, i in enumerate(participants):
                next_combos = []
                for combo in combos:
                    for outcome in outcomes[slot]:
                        copy = list(combo)
                        copy[i] = outcome
                        next_combos.append(copy)
                combos = next_combos
            for runtimes in combos:
                moves.append({'next': {'runtimes': runtimes, 'path': []}, 'event': event, 'machines': participants})
        return moves

    def key_of(node):
        return '|'.join(_runtime_key(r) for r in node['runtimes'])

    init = {'runtimes': [_initial_state(m) for m in models], 'path': []}
    visited = set()
    queue = deque([init])
    composite_states = 0
    truncated = False
    fired_count = {}
    for event in rendezvous_set:
        fired_count[event] = 0
    c1_findings = []
    while queue:
        node = queue.popleft()
        k = key_of(node)
        if k in visited:
            continue
        visited.add(k)
        composite_states += 1
        if composite_states > max_states:
            truncated = True
            break
        moves = composition_moves(node)
        all_terminal = all(_is_terminal(models[i], r['state']) for i, r in enumerate(node['runtimes']))
        if not moves and not all_terminal:
            c1_findings.append({
                'code': 'C1_COMPOSITION_DEADLOCK',
                'severity': 'error',
                'message': 'Composition deadlock: no machine can advance from (' + ', '.join(r['state'] for r in node['runtimes']) + ') while at least one is not terminal.',
                'evidence': {'steps': node['path'], 'states': [r['state'] for r in node['runtimes']]},
            })
            continue
        for move in moves:
            if len(move['machines']) > 1:
                fired_count[move['event']] = fired_count.get(move['event'], 0) + 1
            nk = key_of(move['next'])
            if nk in visited:
                continue
            queue.append({'runtimes': move['next']['runtimes'],
                          'path': list(node['path']) + [{'event': move['event'], 'machines': move['machines']}]})
    c2_findings = []
    all_events_set = set()
    for s in machine_event_sets:
        all_events_set.update(s)
    for event in rendezvous_set:
        if event not in all_events_set:
            continue
        if fired_count.get(event, 0) == 0:
            c2_findings.append({
                'code': 'C2_RENDEZVOUS_NEVER_FIRES',
                'severity': 'warning',
                'message': 'Rendezvous event ' + event + ' can never fire: fewer than two machines ever jointly enable it.',
            })
    errors = len(c1_findings)
    warnings = len(c2_findings)
    checks = [
        _check_result('C1', 'Composition Deadlock', c1_findings,
                      'No composition deadlock reachable' if not c1_findings else 'Composition deadlocks: ' + str(len(c1_findings))),
        _check_result('C2', 'Rendezvous Sync', c2_findings,
                      'All rendezvous events can fire' if not c2_findings else 'Rendezvous warnings: ' + str(len(c2_findings))),
    ]
    return {
        'ok': errors == 0,
        'summary': {'machineCount': len(models), 'machines': machine_summary, 'compositeStates': composite_states,
                    'errors': errors, 'warnings': warnings, 'truncated': truncated},
        'checks': checks,
    }


# ---------------------------------------------------------------------------
# External-tool exporters (UPPAAL / TLA+ / PRISM / SPIN)
# ---------------------------------------------------------------------------

def _prepare_model(input_value):
    ok_model, model_or_errors = validate_model(input_value)
    if not ok_model:
        raise ValueError('model invalid: ' + '; '.join(model_or_errors))
    model = model_or_errors
    used = set()
    state_ids = []
    index_of = {}
    state_id_of = {}

    def sanitize(raw):
        out = re.sub(r'[^A-Za-z0-9_]', '_', raw)
        if len(out) == 0 or re.match(r'^[0-9]', out):
            out = 's_' + out
        return out

    for index, state in enumerate(model.get('states') or []):
        candidate = sanitize(state['id'])
        if candidate in used:
            candidate = candidate + '_' + str(index)
        used.add(candidate)
        state_ids.append(candidate)
        index_of[state['id']] = index
        state_id_of[state['id']] = candidate
    return {'model': model, 'stateIds': state_ids, 'indexOf': index_of,
            'initId': state_id_of.get(model['init'], state_ids[0] if state_ids else ''), 'stateIdOf': state_id_of}


def _num_value(value):
    return (1 if value else 0) if isinstance(value, bool) else value


def _leaf_expr(node, var_name):
    return var_name(node['variable']) + ' ' + node['op'] + ' ' + str(_num_value(node['value']))


def _guard_expr(node, and_op, or_op, not_op, var_name, op_for=None):
    if op_for is None:
        op_for = lambda op: op
    if node is None:
        return ''
    if 'variable' in node:
        return var_name(node['variable']) + ' ' + op_for(node['op']) + ' ' + str(_num_value(node['value']))
    if 'all' in node:
        return '(' + _join_exprs(node['all'], and_op, or_op, not_op, var_name, op_for, and_op) + ')'
    if 'any' in node:
        return '(' + _join_exprs(node['any'], and_op, or_op, not_op, var_name, op_for, or_op) + ')'
    if 'not' in node:
        return not_op + '(' + _guard_expr(node['not'], and_op, or_op, not_op, var_name, op_for) + ')'
    return 'true'


def _join_exprs(children, and_op, or_op, not_op, var_name, op_for, sep):
    parts = []
    for child in children:
        parts.append(_guard_expr(child, and_op, or_op, not_op, var_name, op_for))
    return (' ' + sep + ' ').join(parts)


def _update_assignments(updates, var_name):
    out = []
    for update in updates or []:
        name = var_name(update['variable'])
        value = update.get('value', 1)
        op = update['op']
        if op == 'set':
            out.append(name + ' := ' + str(value))
        elif op == 'inc':
            out.append(name + ' := ' + name + ' + ' + str(value))
        else:
            out.append(name + ' := ' + name + ' - ' + str(value))
    return out


def _forbidden_indexes(ex):
    out = []
    for invariant in ex['model'].get('invariants') or []:
        if invariant['kind'] == 'never-states':
            for s in invariant['states']:
                index = ex['indexOf'].get(s)
                if index is not None:
                    out.append(index)
    return out


def _export_uppaal(ex):
    model = ex['model']
    state_ids = ex['stateIds']
    index_of = ex['indexOf']
    warnings = []

    def xml(s):
        return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')

    def safe_event(event):
        return xml(re.sub(r'[^A-Za-z0-9_]', '_', event))

    globals_lines = []
    for v in model.get('variables') or []:
        globals_lines.append('int ' + v['name'] + ' = ' + str(_num_value(v['init'])) + ';')
    globals_str = '\n'.join(globals_lines)
    locs = []
    for i, state in enumerate(model.get('states') or []):
        name_el = '\n      <name x="16" y="16">' + xml(ex['stateIdOf'].get(state['id'], state['id'])) + '</name>'
        locs.append('    <location id="id' + str(i) + '" x="' + str(i * 120) + '" y="0">' + name_el + '\n    </location>')
    locs_str = '\n'.join(locs)
    edges = []
    for i, tr in enumerate(model.get('transitions') or []):
        guard = _guard_expr(tr.get('guard'), '&&', '||', '!', lambda v: v)
        assigns = _update_assignments(tr.get('updates'), lambda v: v)
        labels = []
        if guard != '':
            labels.append('      <label kind="guard" x="16" y="16">' + xml(guard) + '</label>')
        if len(assigns) > 0:
            labels.append('      <label kind="assignment" x="16" y="16">' + xml(',\n'.join(assigns)) + '</label>')
        labels.append('      <label kind="synchronisation" x="16" y="16">' + safe_event(tr['event']) + '!</label>')
        edges.append('    <transition id="id' + str(1000 + i) + '">\n      <source ref="id' + str(index_of.get(tr['from'])) + '"/>\n      <target ref="id' + str(index_of.get(tr['to'])) + '"/>\n' + '\n'.join(labels) + '\n    </transition>')
    edges_str = '\n'.join(edges)
    queries = []
    for state in model.get('states') or []:
        if state.get('terminal'):
            queries.append('E<> LogicProbe.' + ex['stateIdOf'].get(state['id'], state['id']))
    for index in _forbidden_indexes(ex):
        queries.append('A[] not LogicProbe.' + state_ids[index])
    for invariant in model.get('invariants') or []:
        if invariant['kind'] != 'never-states':
            warnings.append('UPPAAL export carries invariant kind ' + invariant['kind'] + ' only as a comment (not expressible in the exported XML).')
    init_index = index_of.get(model['init'], 0)
    xta = ('<?xml version="1.0" encoding="utf-8"?>\n'
           + '<!DOCTYPE nta PUBLIC \'-//Uppaal Team//DTD Flat System 1.6//EN\' \'http://www.it.uu.se/research/group/darts/uppaal/flat-1_6.dtd\'>\n'
           + '<nta>\n'
           + '  <declaration>// Generated by logicprobe (UPPAAL XML export; booleans as int).\n' + (globals_str + '\n' if globals_str != '' else '') + '</declaration>\n'
           + '  <template>\n'
           + '    <name x="5" y="5">LogicProbe</name>\n'
           + '    <declaration/>\n'
           + locs_str + '\n'
           + '    <init ref="id' + str(init_index) + '"/>\n'
           + edges_str + '\n'
           + '  </template>\n'
           + '  <system>system LogicProbe;</system>\n'
           + '</nta>\n')
    extras = {'queries': '\n'.join(queries) + ('\n' if queries else '')}
    return {'format': 'uppaal', 'primary': xta, 'extras': extras, 'warnings': warnings}


def _export_tla(ex):
    model = ex['model']
    state_ids = ex['stateIds']
    state_id_of = ex['stateIdOf']
    init_id = ex['initId']
    warnings = []
    bs = chr(92)
    CONJ = '/' + bs
    DISJ = bs + '/'
    MEM = bs + 'in'
    NOTIN = bs + 'notin'
    variables = ['pc'] + [v['name'] for v in model.get('variables') or []]
    type_var_parts = []
    for v in model.get('variables') or []:
        lo = _num_value(v.get('min', 0))
        hi = max(1, _num_value(v.get('max', 1)))
        type_var_parts.append(v['name'] + ' ' + MEM + ' ' + str(lo) + '..' + str(hi))
    type_var = (' ' + CONJ + ' ').join(type_var_parts)
    init_parts = ['pc = "' + init_id + '"'] + [v['name'] + ' = ' + str(_num_value(v['init'])) for v in model.get('variables') or []]
    init_str = (' ' + CONJ + ' ').join(init_parts)
    next_parts = []
    for tr in model.get('transitions') or []:
        guard = _guard_expr(tr.get('guard'), CONJ, DISJ, '~', lambda v: v)
        guard = guard.replace(' == ', ' = ').replace(' != ', ' /= ')
        updates = []
        for u in tr.get('updates') or []:
            value = u.get('value', 1)
            if u['op'] == 'set':
                updates.append(u['variable'] + ' = ' + str(value))
            elif u['op'] == 'inc':
                updates.append(u['variable'] + ' = ' + u['variable'] + ' + ' + str(value))
            else:
                updates.append(u['variable'] + ' = ' + u['variable'] + ' - ' + str(value))
        pc_part = "pc'" + ' = "' + state_id_of.get(tr['to'], tr['to']) + '"'
        rest = (' ' + CONJ + ' ' + ' '.join(updates)) if updates else ''
        if guard == '':
            guard_part = 'pc = "' + state_id_of.get(tr['from'], tr['from']) + '"'
        else:
            guard_part = 'pc = "' + state_id_of.get(tr['from'], tr['from']) + '" ' + CONJ + ' ' + guard
        next_parts.append(DISJ + ' ' + guard_part + ' ' + CONJ + ' ' + pc_part + rest)
    next_str = '\n'.join(next_parts)
    forbids = ['"' + state_ids[i] + '"' for i in _forbidden_indexes(ex)]
    props = []
    if forbids:
        props.append('CheckSafety == [] (pc ' + NOTIN + ' {' + ', '.join(forbids) + '})')
    for invariant in model.get('invariants') or []:
        if invariant['kind'] != 'never-states':
            warnings.append('TLA+ v1 does not translate invariant kind ' + invariant['kind'] + '; only never-states becomes a property.')
    state_lit = ', '.join('"' + s + '"' for s in state_ids)
    spec = ('---- MODULE LogicProbe ----\n'
            + 'EXTENDS Integers\n'
            + 'VARIABLES ' + ', '.join(variables) + '\n'
            + 'States == {' + state_lit + '}\n'
            + 'TypeOK == pc ' + MEM + ' States' + ((' ' + CONJ + ' ' + type_var) if type_var != '' else '') + '\n'
            + 'Init == ' + init_str + '\n'
            + 'Next ==\n' + next_str + '\n'
            + (('\n' + '\n\n'.join(props) + '\n') if props else '')
            + '====\n')
    extras = {'properties': '\n'.join(props) + '\n'} if props else {}
    return {'format': 'tla', 'primary': spec, 'extras': extras, 'warnings': warnings}


def _export_prism(ex):
    model = ex['model']
    index_of = ex['indexOf']
    state_id_of = ex['stateIdOf']
    warnings = []
    ranges = []
    for v in model.get('variables') or []:
        ranges.append({'name': v['name'],
                       'lo': _num_value(v.get('min', 0)),
                       'hi': max(1, _num_value(v.get('max', 3))),
                       'init': _num_value(v['init'])})
    valuations = []

    def build(i, acc):
        if i == len(ranges):
            valuations.append(acc)
            return
        for value in range(ranges[i]['lo'], ranges[i]['hi'] + 1):
            copy = dict(acc)
            copy[ranges[i]['name']] = value
            build(i + 1, copy)

    build(0, {})
    size = len(model.get('states') or []) * max(1, len(valuations))
    if size > 20000:
        raise ValueError('PRISM enumeration too large: ' + str(len(model.get('states') or [])) + ' x ' + str(len(valuations)))

    def eval_guard(guard, val):
        if guard is None:
            return True
        if 'variable' in guard:
            if guard['variable'] in val:
                left = val[guard['variable']]
            else:
                init_val = 0
                for v in model.get('variables') or []:
                    if v['name'] == guard['variable']:
                        init_val = _num_value(v.get('init', 0))
                left = init_val
            right = _num_value(guard['value'])
            op = guard['op']
            if op == '==':
                return left == right
            if op == '!=':
                return left != right
            if op == '<':
                return left < right
            if op == '<=':
                return left <= right
            if op == '>':
                return left > right
            if op == '>=':
                return left >= right
            return False
        if 'all' in guard:
            return all(eval_guard(g, val) for g in guard['all'])
        if 'any' in guard:
            return any(eval_guard(g, val) for g in guard['any'])
        if 'not' in guard:
            return not eval_guard(guard['not'], val)
        return False

    def apply_updates(t, val):
        out = dict(val)
        for u in t.get('updates') or []:
            cur = out.get(u['variable'], 0)
            value = u.get('value', 1)
            if u['op'] == 'set':
                out[u['variable']] = value
            elif u['op'] == 'inc':
                out[u['variable']] = cur + value
            else:
                out[u['variable']] = cur - value
        return out

    commands = []
    for state in model.get('states') or []:
        for val in valuations:
            groups = {}
            for t in model.get('transitions') or []:
                if t['from'] == state['id']:
                    groups.setdefault(t['event'], []).append(t)
            outcomes = {}
            total_w = 0
            for group in groups.values():
                guarded = [t for t in group if t.get('guard') is not None and eval_guard(t['guard'], val)]
                chosen = guarded if guarded else [t for t in group if t.get('guard') is None]
                for t in chosen:
                    weight = t.get('weight', 1)
                    nv = apply_updates(t, val)
                    key = str(index_of.get(t['to'])) + '|' + js_stringify(nv)
                    if key not in outcomes:
                        outcomes[key] = {'weight': weight, 'pc': index_of.get(t['to'], 0), 'val': nv}
                        total_w += weight
                    else:
                        outcomes[key]['weight'] += weight
            if len(outcomes) == 0:
                continue
            guard_parts = ['pc = ' + str(index_of.get(state['id'], 0))]
            for r in ranges:
                guard_parts.append(r['name'] + ' = ' + str(val.get(r['name'], r['init'])))
            terms = []
            for item in outcomes.values():
                p = item['weight'] / total_w if total_w > 0 else 0
                prob = format(p, '.6f').rstrip('0').rstrip('.')
                upd = ["(pc' = " + str(item['pc']) + ")"]
                for r in ranges:
                    v = item['val'].get(r['name'], r['init'])
                    if v != val.get(r['name'], r['init']):
                        upd.append("(" + r['name'] + "' = " + str(v) + ")")
                terms.append(prob + ' : ' + ' & '.join(upd))
            commands.append('[] ' + ' & '.join(guard_parts) + ' ->\n    ' + ' +\n    '.join(terms))
    pc_hi = len(model.get('states') or []) - 1
    range_decls = '\n'.join('  ' + r['name'] + ' : [' + str(r['lo']) + '..' + str(r['hi']) + '] init ' + str(r['init']) + ';' for r in ranges)
    module = ('// Generated by logicprobe (DTMC export; booleans as 0/1 integers).\n'
              + 'dtmc\n\n'
              + 'module LogicProbe\n'
              + '  pc : [0..' + str(pc_hi) + '] init ' + str(index_of.get(model['init'], 0)) + ';\n'
              + range_decls + '\n\n'
              + '\n\n'.join(commands) + '\n'
              + 'endmodule\n')
    labels = []
    for state in model.get('states') or []:
        if state.get('terminal'):
            labels.append('label "term_' + (state_id_of.get(state['id'], 's')) + '" = pc = ' + str(index_of.get(state['id'])))
    forb = _forbidden_indexes(ex)
    if forb:
        labels.append('label "forbidden" = ' + ' | '.join('pc = ' + str(i) for i in forb))
    pctl = []
    for invariant in model.get('invariants') or []:
        if invariant['kind'] == 'probability':
            target = index_of.get(invariant['target'])
            if target is not None:
                labels.append('label "target" = pc = ' + str(target))
                pctl.append('P' + invariant['op'] + js_number(invariant['p']) + ' [ F "target" ]')
    if forb:
        pctl.append('P>=1 [ G !"forbidden" ]')
    module = module + '\n' + '\n'.join(labels) + '\n'
    extras = {'properties': '\n'.join(pctl) + '\n'}
    for invariant in model.get('invariants') or []:
        if invariant['kind'] != 'probability' and invariant['kind'] != 'never-states':
            warnings.append('PRISM v1 does not translate invariant kind ' + invariant['kind'] + '.')
    return {'format': 'prism', 'primary': module, 'extras': extras, 'warnings': warnings}


def _export_spin(ex):
    model = ex['model']
    index_of = ex['indexOf']
    warnings = []
    var_decl_parts = []
    for v in model.get('variables') or []:
        var_decl_parts.append('int ' + v['name'] + ' = ' + str(_num_value(v['init'])) + ';')
    var_decl = '\n'.join(var_decl_parts)
    lines = []

    def prom_assigns(updates):
        out = []
        for u in updates or []:
            value = u.get('value', 1)
            if u['op'] == 'set':
                out.append(u['variable'] + ' = ' + str(value))
            elif u['op'] == 'inc':
                out.append(u['variable'] + ' = ' + u['variable'] + ' + ' + str(value))
            else:
                out.append(u['variable'] + ' = ' + u['variable'] + ' - ' + str(value))
        return out

    for t in model.get('transitions') or []:
        guard = _guard_expr(t.get('guard'), '&&', '||', '!', lambda v: v)
        assigns = prom_assigns(t.get('updates'))
        if guard == '':
            cond = 'pc == ' + str(index_of.get(t['from']))
        else:
            cond = 'pc == ' + str(index_of.get(t['from'])) + ' && ' + guard
        prefix = (' ' + '; '.join(assigns) + ';') if assigns else ''
        lines.append('    :: (' + cond + ') ->' + prefix + ' pc = ' + str(index_of.get(t['to'])) + ';')
    for state in model.get('states') or []:
        if state.get('terminal'):
            lines.append('    :: (pc == ' + str(index_of.get(state['id'])) + ') -> goto done;')
    promela = ('// Generated by logicprobe (Promela v1; booleans as 0/1 integers).\n'
               + 'int pc = ' + str(index_of.get(model['init'], 0)) + ';\n'
               + (var_decl + '\n' if var_decl != '' else '')
               + 'active proctype LogicProbe() {\n'
               + '  do\n'
               + '\n'.join(lines) + '\n'
               + '  od\n'
               + 'done: skip\n'
               + '}\n')
    extras = {}
    forb = _forbidden_indexes(ex)
    if forb:
        extras['properties'] = 'ltl safety { [] (!(pc == ' + ' && !(pc == '.join(str(i) for i in forb) + ')) }\n'
    for invariant in model.get('invariants') or []:
        if invariant['kind'] != 'never-states':
            warnings.append('SPIN v1 does not translate invariant kind ' + invariant['kind'] + '.')
    return {'format': 'spin', 'primary': promela, 'extras': extras, 'warnings': warnings}


def export_model(input_value, fmt):
    ex = _prepare_model(input_value)
    if fmt == 'uppaal':
        return _export_uppaal(ex)
    if fmt == 'tla':
        return _export_tla(ex)
    if fmt == 'prism':
        return _export_prism(ex)
    return _export_spin(ex)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _load_json_file(file_path):
    with open(file_path, 'r', encoding='utf-8') as handle:
        return json.load(handle)


def _cmd_verify(args):
    model = _load_json_file(args.model)
    options = {}
    if args.max_states:
        options['maxStates'] = args.max_states
    if args.max_permutation_events:
        options['maxPermutationEvents'] = args.max_permutation_events
    if args.before_model:
        options['beforeModel'] = _load_json_file(args.before_model)
    if args.state_mapping:
        options['stateMapping'] = _load_json_file(args.state_mapping)
    report = run_verification(model, options)
    print(json.dumps(report, indent=2))
    sys.exit(0 if report['ok'] and report['summary'].get('errors', 0) == 0 else 2)


def _cmd_compose(args):
    machines = [_load_json_file(m) for m in args.machines]
    options = {}
    if args.rendezvous:
        options['rendezvous'] = [e for e in args.rendezvous.split(',') if e]
    if args.max_states:
        options['maxStates'] = args.max_states
    report = run_composition_verification(machines, options)
    print(json.dumps(report, indent=2))
    sys.exit(0 if report['ok'] else 2)


def _cmd_export(args):
    model = _load_json_file(args.model)
    try:
        result = export_model(model, args.format)
    except ValueError as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}))
        sys.exit(2)
    out = {'format': result['format'], 'primary': result['primary'],
           'extras': result['extras'], 'warnings': result['warnings']}
    print(json.dumps(out, indent=2))


def _build_parser():
    parser = argparse.ArgumentParser(prog='logicprobe-engine.py',
                                     description='Standalone LogicModelV1 verification + composition + export (non-DSH mirror)')
    sub = parser.add_subparsers(dest='command', required=True)
    p_verify = sub.add_parser('verify', help='verify a LogicModelV1 JSON model (S1-S8/A1-A14/D1-D4)')
    p_verify.add_argument('model')
    p_verify.add_argument('--before-model')
    p_verify.add_argument('--state-mapping')
    p_verify.add_argument('--max-states', type=int)
    p_verify.add_argument('--max-permutation-events', type=int)
    p_verify.set_defaults(func=_cmd_verify)
    p_compose = sub.add_parser('compose', help='compose two or more machines (C1/C2)')
    p_compose.add_argument('machines', nargs='+')
    p_compose.add_argument('--rendezvous', help='comma-separated handshake events')
    p_compose.add_argument('--max-states', type=int)
    p_compose.set_defaults(func=_cmd_compose)
    p_export = sub.add_parser('export', help='export a model to UPPAAL/TLA+/PRISM/SPIN')
    p_export.add_argument('model')
    p_export.add_argument('--format', required=True, choices=['uppaal', 'tla', 'prism', 'spin'])
    p_export.set_defaults(func=_cmd_export)
    return parser


def main(argv=None):
    parser = _build_parser()
    args = parser.parse_args(argv)
    args.func(args)


if __name__ == '__main__':
    main()
