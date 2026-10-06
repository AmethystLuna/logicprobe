#!/usr/bin/env python3
"""logicprobe-engine.py — standalone JSON-driven mirror of the logicprobe DSH engine.

Reads the same LogicModelV1 JSON schema as the DSH `logicprobe_verify` /
`logicprobe_compose_verify` / `logicprobe_export` tools and runs the same
checks (S1-S8 structural, A1-A14 adversarial, D1-D4 before/after regression,
C1/C2 composition) plus the four external-tool exporters (UPPAAL / TLA+ /
PRISM / SPIN) and the UML front end (render / parse / review, mirroring
`src/uml.ts`). Pure stdlib, no third-party imports.

Usage:
  python logicprobe-engine.py verify model.json [--before-model before.json]
      [--state-mapping map.json] [--max-states N] [--max-permutation-events N]
  python logicprobe-engine.py compose m1.json m2.json [m3.json ...]
      [--rendezvous ev1,ev2] [--max-states N]
  python logicprobe-engine.py export model.json --format uppaal|tla|prism|spin
  python logicprobe-engine.py uml-render model.json [--notation mermaid|plantuml]
      [--diagram state|activity|sequence] [--max-steps N]
  python logicprobe-engine.py uml-parse diagram.txt [--notation auto|mermaid|plantuml]
  python logicprobe-engine.py uml-review [--model model.json] [--diagram diagram.txt]
      [--notation auto|mermaid|plantuml] [--diagram-kind state|activity|sequence]
      [--no-round-trip] [--max-steps N]

Output: JSON verification/composition report on stdout (same shape as the DSH
tool result), or the export result JSON (format / primary / extras / warnings),
or the UML render/parse/review JSON.
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

    # Declared keys per model part. The model schema is closed: a key that is not
    # declared is a typo or an unsupported feature, and silently ignoring it can make
    # the engine report a property the model does not actually have (a mistyped guard
    # variable reads as an always-false guard, which prunes real paths and can yield a
    # false "no deadlock"). Rejecting is the only safe option for a verifier.
    model_keys = {
        'root': ('schemaVersion', 'init', 'states', 'transitions', 'variables', 'invariants',
                 'concurrentPairs', 'boundaryChecks', 'resourcePairs', 'idempotentEvents',
                 'tickEvents', 'narrative'),
        'state': ('id', 'terminal', 'onEntry', 'onExit', 'maxTicks'),
        'transition': ('from', 'event', 'to', 'guard', 'updates', 'cost', 'weight'),
        'update': ('variable', 'op', 'value'),
        'variable': ('name', 'kind', 'init', 'min', 'max', 'monotonic'),
        # LogicModelV1 boundary checks are (variable, values). The data-model engine has
        # its own (entity, field) shape and its own validator — the two must not be mixed.
        'boundaryCheck': ('variable', 'values'),
        'resourcePair': ('resource', 'acquireEvent', 'releaseEvent', 'failEvent'),
        'narrative': ('states', 'events', 'scenarios'),
        'scenario': ('from', 'event', 'scenario'),
    }

    def reject_unknown_keys(value, part, path):
        allowed = model_keys[part]
        unexpected = [k for k in value.keys() if k not in allowed]
        if unexpected:
            bad(path + '.' + unexpected[0], 'unknown field (allowed: ' + ', '.join(allowed) + ')')

    if not _is_plain_object(input_value):
        return (False, ['model: must be an object'])
    root = input_value
    reject_unknown_keys(root, 'root', 'model')
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
            reject_unknown_keys(entry, 'state', 'states[' + str(index) + ']')
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
            reject_unknown_keys(entry, 'transition', p)
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
                        reject_unknown_keys(update, 'update', up)
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
                reject_unknown_keys(entry, 'variable', p)
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
    # Closed schema per kind: a key the selected kind does not declare is rejected
    # rather than silently ignored, because an ignored field still appears in the
    # echoed report and reads as if it took effect. Unknown kinds are skipped so
    # they fail on .kind alone.
    invariant_keys = {
        'never-states': ('id', 'description', 'kind', 'states'),
        'var-in-range': ('id', 'description', 'kind', 'variable', 'min', 'max', 'when'),
        'event-before-state': ('id', 'description', 'kind', 'event', 'state'),
        'leads-to': ('id', 'description', 'kind', 'from', 'to'),
        'sequence': ('id', 'description', 'kind', 'events'),
        'atomicity': ('id', 'description', 'kind', 'events', 'commit', 'rollback'),
        'budget': ('id', 'description', 'kind', 'budget'),
        'probability': ('id', 'description', 'kind', 'target', 'op', 'p'),
    }
    invariant_state_ids = set()
    if isinstance(states, list):
        for state in states:
            if isinstance(state, dict) and isinstance(state.get('id'), str):
                invariant_state_ids.add(state['id'])
    # Reference sets for invariant targets: denormalising a kind's target into the
    # report makes a mistyped id look authoritative, so every reference must resolve.
    invariant_event_ids = set()
    if isinstance(transitions, list):
        for transition in transitions:
            if isinstance(transition, dict) and isinstance(transition.get('event'), str):
                invariant_event_ids.add(transition['event'])
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
                if kind in invariant_keys:
                    allowed_keys = invariant_keys[kind]
                    unexpected = [k for k in entry.keys() if k not in allowed_keys]
                    if unexpected:
                        bad(p + '.' + unexpected[0], 'unknown field for kind ' + str(kind) + ' (allowed: ' + ', '.join(allowed_keys) + ')')
                if kind == 'never-states':
                    s_list = entry.get('states')
                    if not isinstance(s_list, list) or len(s_list) == 0:
                        bad(p + '.states', 'must be a non-empty array')
                    else:
                        for s_index, state in enumerate(s_list):
                            if not isinstance(state, str) or len(state) == 0:
                                bad(p + '.states[' + str(s_index) + ']', 'must be a non-empty string')
                            elif state not in invariant_state_ids:
                                bad(p + '.states[' + str(s_index) + ']', 'references unknown state ' + state)
                elif kind == 'var-in-range':
                    validate_variable_ref(entry.get('variable'), p + '.variable')
                    mn = entry.get('min')
                    mx = entry.get('max')
                    if mn is not None and (not isinstance(mn, (int, float)) or isinstance(mn, bool)):
                        bad(p + '.min', 'must be a number')
                    if mx is not None and (not isinstance(mx, (int, float)) or isinstance(mx, bool)):
                        bad(p + '.max', 'must be a number')
                    if mn is None and mx is None:
                        bad(p, 'requires min or max (a range with neither bound is vacuous)')
                    when = entry.get('when')
                    if when is not None:
                        if not _is_plain_object(when):
                            bad(p + '.when', 'must be an object')
                        elif 'state' in when:
                            for key in when.keys():
                                if key != 'state':
                                    bad(p + '.when.' + key, 'unknown field for a state scope (allowed: state)')
                            scope_state = when.get('state')
                            if not isinstance(scope_state, str) or len(scope_state) == 0:
                                bad(p + '.when.state', 'must be a non-empty string')
                            elif scope_state not in invariant_state_ids:
                                bad(p + '.when.state', 'references unknown state ' + scope_state)
                        else:
                            _validate_guard(when, p + '.when', errors, bad)
                            constrained = entry.get('variable')
                            for wv in _guard_variables(when):
                                if wv == constrained:
                                    bad(p + '.when', 'must not reference the constrained variable ' + str(constrained) + ' (it can mask its own violation)')
                                else:
                                    validate_variable_ref(wv, p + '.when')
                elif kind == 'event-before-state':
                    ev = entry.get('event')
                    if not isinstance(ev, str) or len(ev) == 0:
                        bad(p + '.event', 'must be a non-empty string')
                    elif ev not in invariant_event_ids:
                        bad(p + '.event', 'references unknown event ' + ev)
                    st = entry.get('state')
                    if not isinstance(st, str) or len(st) == 0:
                        bad(p + '.state', 'must be a non-empty string')
                    elif st not in invariant_state_ids:
                        bad(p + '.state', 'references unknown state ' + st)
                elif kind == 'leads-to':
                    lfrom = entry.get('from')
                    if not isinstance(lfrom, str) or len(lfrom) == 0:
                        bad(p + '.from', 'must be a non-empty string')
                    elif lfrom not in invariant_state_ids:
                        bad(p + '.from', 'references unknown state ' + lfrom)
                    lto = entry.get('to')
                    if not isinstance(lto, str) or len(lto) == 0:
                        bad(p + '.to', 'must be a non-empty string')
                    elif lto not in invariant_state_ids:
                        bad(p + '.to', 'references unknown state ' + lto)
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
                    elif target not in invariant_state_ids:
                        bad(p + '.target', 'references unknown state ' + target)
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
                reject_unknown_keys(entry, 'boundaryCheck', p)
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
                reject_unknown_keys(entry, 'resourcePair', p)
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
            reject_unknown_keys(narrative, 'narrative', np_)
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
                    reject_unknown_keys(entry, 'scenario', sp)
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


def _guard_variables(guard):
    """Mirror of the TypeScript guardVariables(): every variable a guard references."""
    if guard is None:
        return []
    if 'variable' in guard:
        return [guard['variable']]
    if 'all' in guard:
        out = []
        for child in guard['all']:
            out.extend(_guard_variables(child))
        return out
    if 'any' in guard:
        out = []
        for child in guard['any']:
            out.extend(_guard_variables(child))
        return out
    if 'not' in guard:
        return _guard_variables(guard['not'])
    return []


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


def _when_scope_holds(when, runtime):
    """Whether a var-in-range `when` scope selects this runtime state."""
    if 'state' in when:
        return when['state'] == runtime['state']
    return _eval_guard(when, runtime['vars'])


def _invariant_holds(invariant, runtime, is_initial=False):
    kind = invariant['kind']
    if kind == 'never-states':
        return runtime['state'] not in invariant['states']
    if kind == 'var-in-range':
        # The initial runtime state is checked unconditionally: a machine must never
        # be able to escape the range simply by starting outside the scope.
        when = invariant.get('when')
        if not is_initial and when is not None and not _when_scope_holds(when, runtime):
            return True
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
    if not _invariant_holds(invariant, init, True):
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
    elif invariant['kind'] == 'var-in-range':
        # A state scope must follow the state rename, otherwise D2 reports a spurious
        # regression when the scope later refers to a state id that no longer exists.
        when = invariant.get('when')
        if when is not None and 'state' in when:
            out['when'] = {'state': _map_state_id(mapping, when['state'])}
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
    # Find a run from start that never reaches target, or None when every run does.
    # The property is universal (see the A9 row in SKILL.md): one branch that loops
    # forever, or that stops before the target, refutes it.
    #
    # Depth-first walk of the run graph with three colours; target runs are success
    # leaves that are never expanded. A node reached while it is on the current walk
    # (GRAY) closes a cycle that avoids the target. A node with no outgoing step at
    # all stops the machine where it stands, which is the same violation for a
    # different reason. A node whose walk completed without a violation is BLACK, and
    # reaching it again from another branch is a shared sub-graph, not a cycle -- that
    # is why the colour map cannot be a plain visited set: a diamond (two branches
    # rejoining) is acyclic and must pass, while a genuine cycle must not. A run is
    # identified by its state plus its variable values.
    if start['state'] == target:
        return None
    GRAY = 1
    BLACK = 2
    color = {}
    stack = [{'runtime': start, 'path': [], 'nexts': None, 'index': 0}]
    color[_runtime_key(start)] = GRAY
    while stack:
        frame = stack[-1]
        if frame['nexts'] is None:
            nexts = []
            for event in _all_events(model):
                for nxt in _step_runtime(model, frame['runtime'], event):
                    nexts.append({'next': nxt, 'event': event})
            frame['nexts'] = nexts
            if not nexts:
                return {'path': frame['path'], 'reason': 'Dead end before target ' + target}
        if frame['index'] >= len(frame['nexts']):
            color[_runtime_key(frame['runtime'])] = BLACK
            stack.pop()
            continue
        item = frame['nexts'][frame['index']]
        frame['index'] += 1
        step = {'from': frame['runtime']['state'], 'event': item['event'], 'to': item['next']['state']}
        if item['next']['state'] == target:
            continue
        key = _runtime_key(item['next'])
        seen = color.get(key)
        if seen == GRAY:
            return {'path': frame['path'] + [step], 'reason': 'Cycle avoids target ' + target}
        if seen == BLACK:
            continue
        color[key] = GRAY
        stack.append({'runtime': item['next'], 'path': frame['path'] + [step], 'nexts': None, 'index': 0})
    # Every branch either reached the target or rejoined a branch that did.
    return None


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
# UML front end (mirror of src/uml.ts)
# ---------------------------------------------------------------------------

UML_NOTATIONS = ('mermaid', 'plantuml')
UML_DIAGRAMS = ('state', 'activity', 'sequence')

# Marker every generated diagram carries; renderers ignore it, the parser uses it.
_DIRECTIVE_NAMESPACE = 'logicprobe:'

# State id / event name characters that would break the generated label syntax.
_UNSAFE_LABEL_RE = re.compile(r'[\[\]/\n\r\t]')

# Mermaid flowchart keywords that cannot stand alone as a node id.
_RESERVED_NODE_IDS = frozenset(['end', 'graph', 'subgraph', 'class', 'classDef', 'click', 'style',
                                'linkStyle', 'direction'])

# Ids the notation can spell without an alias (JS `$` is end-of-input, hence \Z).
_PLAIN_ID_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*\Z')

# JavaScript's \s / String.prototype.trim() character set, so guard tokenising and
# label trimming treat exactly the same characters as whitespace as the TypeScript side.
_JS_WHITESPACE = ('\t\n\x0b\x0c\r \xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007'
                  '\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff')
_JS_SPACE_RE = re.compile('[' + _JS_WHITESPACE + ']')


def _js_trim(text):
    return text.strip(_JS_WHITESPACE)


def _js_string(value):
    """JavaScript String(value) for the value kinds this module renders."""
    if value is None:
        return 'undefined'
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        return js_number(value)
    return str(value)


def _char_at(text, index):
    """JavaScript `text[index]`: '' when out of range (undefined never equals a char)."""
    return text[index] if 0 <= index < len(text) else ''


def _is_digit(ch):
    return len(ch) == 1 and '0' <= ch <= '9'


def _is_ascii_letter(ch):
    return len(ch) == 1 and (('a' <= ch <= 'z') or ('A' <= ch <= 'Z'))


def _is_ident_char(ch):
    return _is_ascii_letter(ch) or _is_digit(ch) or ch == '_' or ch == '.'


def _number_from_token(text):
    """JavaScript Number(literal): exact for integers inside the safe range."""
    value = int(text)
    if -9007199254740991 <= value <= 9007199254740991:
        return value
    return float(text)


def _js_strict_equal(left, right):
    """JavaScript === for guard literal values (booleans are never equal to numbers)."""
    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left == right
    return left == right


def _literal_text(value):
    if isinstance(value, bool):
        return 'true' if value else 'false'
    return js_number(value)


def guard_text(node):
    """Canonical guard text; the inverse of parse_guard_text."""
    if 'variable' in node:
        return node['variable'] + ' ' + node['op'] + ' ' + _literal_text(node['value'])
    if 'all' in node:
        return '(' + ' && '.join(guard_text(child) for child in node['all']) + ')'
    if 'any' in node:
        return '(' + ' || '.join(guard_text(child) for child in node['any']) + ')'
    return '!(' + guard_text(node['not']) + ')'


def _updates_text(updates):
    parts = []
    for update in updates:
        value = update['value'] if update.get('value') is not None else (0 if update['op'] == 'set' else 1)
        if update['op'] == 'set':
            parts.append(update['variable'] + ' := ' + _literal_text(value))
        elif update['op'] == 'inc':
            parts.append(update['variable'] + ' := ' + update['variable'] + ' + ' + _literal_text(value))
        else:
            parts.append(update['variable'] + ' := ' + update['variable'] + ' - ' + _literal_text(value))
    return ', '.join(parts)


def _transition_text(transition):
    text = transition['event']
    if transition.get('guard') is not None:
        text += ' [' + guard_text(transition['guard']) + ']'
    updates = transition.get('updates')
    if updates is not None and len(updates) > 0:
        text += ' / ' + _updates_text(updates)
    return text


def _display_text(text):
    return _js_trim(re.sub(r'[\r\n\t]+', ' ', text).replace('"', "'"))


# ---- rendering ------------------------------------------------------------

def _prepare_render(input_value):
    ok, model_or_errors = validate_model(input_value)
    if not ok:
        raise ValueError('model invalid: ' + '; '.join(model_or_errors))
    model = model_or_errors
    warnings = []
    used = set()
    alias = {}
    display = {}
    for state in model['states']:
        sid = state['id']
        candidate = sid
        if _PLAIN_ID_RE.match(candidate) is None:
            candidate = re.sub(r'[^A-Za-z0-9_]', '_', candidate)
            if candidate == '' or _is_digit(candidate[0]):
                candidate = 'S_' + candidate
            warnings.append('UML_RENDER_ID_SANITIZED: state id "' + sid + '" is not a plain identifier; the diagram draws it as "'
                            + candidate + '" and pins the original with a ' + _DIRECTIVE_NAMESPACE + 'alias directive.')
        if candidate in _RESERVED_NODE_IDS:
            warnings.append('UML_RENDER_RESERVED_ID: state alias "' + candidate + '" collides with a diagram keyword; Mermaid renders it, but a hand edit may not.')
        unique = candidate
        suffix = 2
        while unique in used:
            unique = candidate + '_' + str(suffix)
            suffix += 1
        if unique != candidate:
            warnings.append('UML_RENDER_ALIAS_COLLISION: state id "' + sid + '" shares an alias with another state; the diagram uses "' + unique + '".')
        used.add(unique)
        alias[sid] = unique
        meaning = None
        narrative = model.get('narrative')
        if narrative is not None and narrative.get('states') is not None:
            meaning = narrative['states'].get(sid)
        display[sid] = sid if meaning is None else _display_text(sid + '（' + meaning + '）')
    for transition in model['transitions']:
        if _UNSAFE_LABEL_RE.search(transition['event']):
            warnings.append('UML_RENDER_LABEL_UNSAFE: event "' + transition['event'] + '" contains a character (one of [ ] / or a line break) '
                            'that the diagram label syntax uses; the rendered diagram cannot be read back verbatim.')
    terminal = set(state['id'] for state in model['states'] if state.get('terminal') is True)
    return {'model': model, 'alias': alias, 'display': display, 'terminal': terminal, 'warnings': warnings}


def _directive_lines(notation, diagram, context):
    prefix = '%%' if notation == 'mermaid' else "'"
    model = context['model']
    lines = [prefix + _DIRECTIVE_NAMESPACE + 'uml v1 notation=' + notation + ' diagram=' + diagram]
    lines.append(prefix + _DIRECTIVE_NAMESPACE + 'init ' + model['init'])
    terminals = [state['id'] for state in model['states'] if state.get('terminal') is True]
    if len(terminals) > 0:
        lines.append(prefix + _DIRECTIVE_NAMESPACE + 'terminal ' + ','.join(terminals))
    for state in model['states']:
        if context['alias'].get(state['id']) != state['id']:
            lines.append(prefix + _DIRECTIVE_NAMESPACE + 'alias ' + context['alias'][state['id']] + ' ' + state['id'])
    # Variable kinds are not recoverable from the notation: `armed := 1` reads as an
    # integer assignment whichever kind the model declared. Pinning them keeps the
    # round trip exact instead of reporting a fidelity loss that is really a
    # notation limit.
    for variable in model.get('variables') or []:
        lines.append(prefix + _DIRECTIVE_NAMESPACE + 'variable ' + variable['name'] + ' ' + variable['kind'])
    return lines


def _grouped_transitions(model):
    order = []
    groups = {}
    for transition in model['transitions']:
        frm = transition['from']
        if frm not in groups:
            groups[frm] = [transition]
            order.append(frm)
        else:
            groups[frm].append(transition)
    return [{'from': frm, 'transitions': groups[frm]} for frm in order]


def _render_mermaid_state(context):
    model = context['model']
    alias = context['alias']
    lines = _directive_lines('mermaid', 'state', context)
    lines.append('stateDiagram-v2')
    lines.append('  [*] --> ' + alias[model['init']])
    for state in model['states']:
        state_alias = alias[state['id']]
        label = context['display'].get(state['id'], state['id'])
        # Every state is declared, even when its label equals its alias. A state that
        # no transition touches (an isolated terminal, a start state with no edge yet)
        # would otherwise leave no trace in the text at all, and the round-trip check
        # would have to report a loss the notation never caused.
        lines.append('  state "' + label + '" as ' + state_alias)
    for group in _grouped_transitions(model):
        for transition in group['transitions']:
            lines.append('  ' + alias[transition['from']] + ' --> ' + alias[transition['to']] + ' : ' + _transition_text(transition))
    for state in model['states']:
        if state.get('terminal') is True:
            lines.append('  ' + alias[state['id']] + ' --> [*]')
    return '\n'.join(lines) + '\n'


def _render_plantuml_state(context):
    model = context['model']
    alias = context['alias']
    lines = ['@startuml']
    lines.extend(_directive_lines('plantuml', 'state', context))
    lines.append('[*] --> ' + alias[model['init']])
    for state in model['states']:
        lines.append('state "' + context['display'].get(state['id'], state['id']) + '" as ' + alias[state['id']])
    for group in _grouped_transitions(model):
        for transition in group['transitions']:
            lines.append(alias[transition['from']] + ' --> ' + alias[transition['to']] + ' : ' + _transition_text(transition))
    for state in model['states']:
        if state.get('terminal') is True:
            lines.append(alias[state['id']] + ' --> [*]')
    lines.append('@enduml')
    return '\n'.join(lines) + '\n'


def _render_mermaid_activity(context):
    model = context['model']
    alias = context['alias']
    lines = _directive_lines('mermaid', 'activity', context)
    lines.append('flowchart TD')
    for state in model['states']:
        state_alias = alias[state['id']]
        text = context['display'].get(state['id'], state['id'])
        lines.append('  ' + state_alias + ('(["' + text + '"])' if state.get('terminal') is True else '["' + text + '"]'))
    for group in _grouped_transitions(model):
        for transition in group['transitions']:
            lines.append('  ' + alias[transition['from']] + ' -->|"' + _transition_text(transition) + '"| ' + alias[transition['to']])
    return '\n'.join(lines) + '\n'


def _render_sequence(context, notation, max_steps):
    """One BFS trace of the machine, written as a sequence diagram."""
    model = context['model']
    alias = context['alias']
    lines = []
    if notation == 'mermaid':
        lines.extend(_directive_lines('mermaid', 'sequence', context))
        lines.append('sequenceDiagram')
        lines.append('  participant ENV as Environment')
        lines.append('  participant M as Machine')
    else:
        lines.append('@startuml')
        lines.extend(_directive_lines('plantuml', 'sequence', context))
        lines.append('participant ENV as Environment')
        lines.append('participant M as Machine')
    by_from = {}
    for transition in model['transitions']:
        by_from.setdefault(transition['from'], []).append(transition)
    seen = set([model['init']])
    queue = deque([model['init']])
    arrow = 'ENV->>M: ' if notation == 'mermaid' else 'ENV -> M : '
    note = '  Note over M: ' if notation == 'mermaid' else 'note over M : '
    lines.append(('  ' if notation == 'mermaid' else '') + 'Note over M: init ' + model['init'])
    steps = 0
    truncated = False
    while len(queue) > 0:
        current = queue.popleft()
        for transition in by_from.get(current, []):
            if steps >= max_steps:
                truncated = True
                break
            steps += 1
            lines.append(('  ' if notation == 'mermaid' else '') + arrow + _transition_text(transition))
            lines.append(note + alias[transition['from']] + ' -> ' + alias[transition['to']])
            if transition['to'] not in seen:
                seen.add(transition['to'])
                queue.append(transition['to'])
        if truncated:
            break
    if notation == 'plantuml':
        lines.append('@enduml')
    return {'text': '\n'.join(lines) + '\n', 'truncated': truncated}


def render_uml(input_value, notation='mermaid', diagram='state', max_steps=60):
    """Mirror of renderUml: a validated LogicModelV1 as Mermaid/PlantUML text."""
    if notation not in UML_NOTATIONS:
        raise ValueError('unknown notation "' + _js_string(notation) + '"; expected ' + ' | '.join(UML_NOTATIONS))
    if diagram not in UML_DIAGRAMS:
        raise ValueError('unknown diagram "' + _js_string(diagram) + '"; expected ' + ' | '.join(UML_DIAGRAMS))
    if notation == 'plantuml' and diagram == 'activity':
        raise ValueError('plantuml has no faithful activity view here (its activity syntax is a structured flowchart language; '
                         'a graph with merges or cycles needs a while/if reconstruction logicprobe does not perform) — '
                         'use notation "mermaid" for the activity view, or diagram "state"')
    context = _prepare_render(input_value)
    warnings = list(context['warnings'])
    if diagram == 'state':
        primary = _render_mermaid_state(context) if notation == 'mermaid' else _render_plantuml_state(context)
    elif diagram == 'activity':
        primary = _render_mermaid_activity(context)
    else:
        rendered = _render_sequence(context, notation, max_steps)
        primary = rendered['text']
        if rendered['truncated']:
            warnings.append('UML_RENDER_SEQUENCE_TRUNCATED: the trace was capped at ' + str(max_steps) + ' steps; a sequence diagram is one trace, '
                            'not the whole machine — use diagram "state" for the full topology.')
        warnings.append('UML_RENDER_SEQUENCE_IS_TRACE: a sequence diagram shows one BFS trace; branches appear as separate guarded messages '
                        'and unreachable branches are absent by construction.')
    return {'notation': notation, 'diagram': diagram, 'primary': primary, 'warnings': warnings}


# ---- parsing: guard expressions -------------------------------------------

def _tokenize_guard(text):
    tokens = []
    index = 0
    while index < len(text):
        char = text[index]
        if _JS_SPACE_RE.match(char):
            index += 1
            continue
        if char == '(':
            tokens.append(('lparen', char))
            index += 1
            continue
        if char == ')':
            tokens.append(('rparen', char))
            index += 1
            continue
        if char == '&' and _char_at(text, index + 1) == '&':
            tokens.append(('and', '&&'))
            index += 2
            continue
        if char == '|' and _char_at(text, index + 1) == '|':
            tokens.append(('or', '||'))
            index += 2
            continue
        if char == '!':
            if _char_at(text, index + 1) == '=':
                tokens.append(('op', '!='))
                index += 2
                continue
            tokens.append(('not', '!'))
            index += 1
            continue
        two = text[index:index + 2]
        if two == '==' or two == '<=' or two == '>=':
            tokens.append(('op', two))
            index += 2
            continue
        if char == '<' or char == '>':
            tokens.append(('op', char))
            index += 1
            continue
        if char == '=':
            tokens.append(('op', '=='))
            index += 1
            continue
        if _is_digit(char) or (char == '-' and _is_digit(_char_at(text, index + 1))):
            end = index + 1
            while end < len(text) and _is_digit(text[end]):
                end += 1
            tokens.append(('number', text[index:end]))
            index = end
            continue
        if _is_ascii_letter(char) or char == '_':
            end = index + 1
            while end < len(text) and _is_ident_char(text[end]):
                end += 1
            word = text[index:end]
            index = end
            if word == 'and':
                tokens.append(('and', word))
            elif word == 'or':
                tokens.append(('or', word))
            elif word == 'not':
                tokens.append(('not', word))
            elif word == 'true' or word == 'false':
                tokens.append(('boolean', word))
            else:
                tokens.append(('ident', word))
            continue
        raise ValueError('guard text not understood near "' + text[index:] + '"')
    return tokens


class _GuardReader:
    def __init__(self, tokens, source):
        self.tokens = tokens
        self.source = source
        self.position = 0

    def parse(self):
        node = self._parse_or()
        if self.position != len(self.tokens):
            raise ValueError('trailing tokens in guard "' + self.source + '"')
        return node

    def _peek(self):
        return self.tokens[self.position] if self.position < len(self.tokens) else None

    def _parse_or(self):
        parts = [self._parse_and()]
        while self._peek() is not None and self._peek()[0] == 'or':
            self.position += 1
            parts.append(self._parse_and())
        return parts[0] if len(parts) == 1 else {'any': parts}

    def _parse_and(self):
        parts = [self._parse_unary()]
        while self._peek() is not None and self._peek()[0] == 'and':
            self.position += 1
            parts.append(self._parse_unary())
        return parts[0] if len(parts) == 1 else {'all': parts}

    def _parse_unary(self):
        token = self._peek()
        if token is not None and token[0] == 'not':
            self.position += 1
            return {'not': self._parse_unary()}
        return self._parse_primary()

    def _parse_primary(self):
        token = self._peek()
        if token is not None and token[0] == 'lparen':
            self.position += 1
            inner = self._parse_or()
            closing = self._peek()
            if closing is None or closing[0] != 'rparen':
                raise ValueError('unbalanced parentheses in guard "' + self.source + '"')
            self.position += 1
            return inner
        if token is None or token[0] != 'ident':
            raise ValueError('expected a variable name in guard "' + self.source + '"')
        self.position += 1
        op = self._peek()
        if op is None or op[0] != 'op':
            raise ValueError('expected a comparison operator after "' + token[1] + '" in guard "' + self.source + '"')
        self.position += 1
        value = self._peek()
        if value is not None and value[0] == 'number':
            self.position += 1
            return {'variable': token[1], 'op': op[1], 'value': _number_from_token(value[1])}
        if value is not None and value[0] == 'boolean':
            if op[1] != '==' and op[1] != '!=':
                raise ValueError('boolean variable "' + token[1] + '" only supports == / != (guard "' + self.source + '")')
            self.position += 1
            return {'variable': token[1], 'op': op[1], 'value': value[1] == 'true'}
        raise ValueError('expected a literal value for "' + token[1] + '" in guard "' + self.source + '"')


def parse_guard_text(text):
    """Parse a guard expression such as `(retry < 3 && armed == true)`."""
    return _GuardReader(_tokenize_guard(text), text).parse()


_UPDATE_SHIM_RE = re.compile(r'^([A-Za-z_][A-Za-z0-9_]*)\s*(\+\+|--)\Z')
_UPDATE_ASSIGN_RE = re.compile(r'^([A-Za-z_][A-Za-z0-9_]*)\s*:?=\s*(.+)\Z')
_UPDATE_BOOL_RE = re.compile(r'^(true|false)\Z')
_UPDATE_INT_RE = re.compile(r'^-?[0-9]+\Z')
_UPDATE_ARITH_RE = re.compile(r'^([A-Za-z_][A-Za-z0-9_]*)\s*([+-])\s*([0-9]+)\Z')


def parse_updates_text(text, warnings):
    """Parse a UML action clause such as `retry := retry + 1, armed := true`."""
    out = []
    for raw in text.split(','):
        clause = _js_trim(raw)
        if clause == '':
            continue
        shim = _UPDATE_SHIM_RE.match(clause)
        if shim is not None:
            out.append({'variable': shim.group(1), 'op': 'inc' if shim.group(2) == '++' else 'dec', 'value': 1})
            continue
        assignment = _UPDATE_ASSIGN_RE.match(clause)
        if assignment is None:
            raise ValueError('action clause not understood: "' + clause + '" (expected "var := value")')
        name = assignment.group(1)
        value = _js_trim(assignment.group(2))
        if value == name:
            warnings.append('UML_PARSE_NOOP_UPDATE: action "' + clause + '" assigns the variable to itself; dropped.')
            continue
        if _UPDATE_BOOL_RE.match(value):
            out.append({'variable': name, 'op': 'set', 'value': 1 if value == 'true' else 0})
            continue
        if _UPDATE_INT_RE.match(value):
            out.append({'variable': name, 'op': 'set', 'value': _number_from_token(value)})
            continue
        arithmetic = _UPDATE_ARITH_RE.match(value)
        if arithmetic is None:
            raise ValueError('action value not understood: "' + value + '" (expected a literal, or "var + n" / "var - n")')
        if arithmetic.group(1) != name:
            raise ValueError('action "' + clause + '" reads a different variable; LogicModelV1 updates touch one variable')
        out.append({'variable': name, 'op': 'inc' if arithmetic.group(2) == '+' else 'dec',
                    'value': _number_from_token(arithmetic.group(3))})
    return out


# ---- parsing: diagram text ------------------------------------------------

_STATE_EDGE_RE = re.compile(r'^(.+?)\s*-->\s*(.+?)(?:\s*:\s*(.*))?\Z')
_STATE_NOTE_RE = re.compile(r'^note\s+(?:over|right of|left of)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)\Z', re.I)
_NOTE_RE = re.compile(r'^note\b', re.I)
_END_NOTE_RE = re.compile(r'^end\s*note\Z', re.I)
_STATE_DECL_RE = re.compile(r'^state\s+"([^"]*)"\s+as\s+([A-Za-z_][A-Za-z0-9_]*)\Z')
_BARE_STATE_RE = re.compile(r'^state\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{?\Z')
_CONCURRENCY_RE = re.compile(r'^\}\s*\Z|^--\s*\Z')
_COMPOSITE_STATE_RE = re.compile(r'^state\s+(.+)\s*\{\Z')
_DESCRIPTION_RE = re.compile(r'^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)\Z')
_MERMAID_STATE_SKIP_RE = re.compile(r'^(stateDiagram|stateDiagram-v2|direction\b|classDef\b|class\b|style\b|linkStyle\b|click\b|hide\b|scale\b|title\b|accTitle\b|accDescr\b|%%\{)')
_PLANTUML_STATE_SKIP_RE = re.compile(r'^(@startuml|@enduml|scale\b|skinparam\b|title\b|hide\b|left to right direction|top to bottom direction|autonumber|!theme)')

_ACTIVITY_SKIP_RE = re.compile(r'^(flowchart|graph)\b|^(classDef|class|style|linkStyle|click|direction)\b|^%%\{')
_SUBGRAPH_RE = re.compile(r'^subgraph\b')
_SHAPED_EDGE_RE = re.compile(r'^(.*?)\s*-->\s*\|(.*?)\|\s*(.+)\Z')
_BARE_EDGE_RE = re.compile(r'^(.*?)\s*-->\s*(.+)\Z')
_STRIP_NODE_RE = re.compile(r'^([A-Za-z_][A-Za-z0-9_.-]*)\s*(\(\[|\[\(|\{\{|\[|\(|\(\(|>)?\s*([\s\S]*?)\s*\Z')
_QUOTED_ONLY_RE = re.compile(r'^"([^"]+)"\Z')
_QUOTED_IN_RE = re.compile(r'"([^"]*)"')


def _detect_notation(text):
    if re.search(r'^\s*@start', text, re.M):
        return 'plantuml'
    if re.search(r'^\s*(stateDiagram|stateDiagram-v2|flowchart|graph|sequenceDiagram)\b', text, re.M):
        return 'mermaid'
    raise ValueError('cannot tell whether this is Mermaid or PlantUML text: '
                     'expected `stateDiagram-v2` / `flowchart` / `sequenceDiagram`, or `@startuml`')


def _detect_diagram(text):
    if re.search(r'^\s*stateDiagram', text, re.M):
        return 'state'
    if re.search(r'^\s*(flowchart|graph)\b', text, re.M):
        return 'activity'
    if re.search(r'^\s*sequenceDiagram\b', text, re.M):
        return 'sequence'
    if re.search(r'^\s*@startuml', text, re.M):
        # PlantUML declares the diagram kind by its body; the state keyword is the only
        # structural one logicprobe emits, everything else in that family is a state diagram too.
        if re.search(r'^\s*participant\b', text, re.M) or re.search(r'->>\s*', text):
            return 'sequence'
        return 'state'
    raise ValueError('cannot tell which diagram kind this text declares')


def _comment_prefix(notation):
    return '%%' if notation == 'mermaid' else "'"


def _directive_body(line, notation):
    prefix = _comment_prefix(notation)
    trimmed = _js_trim(line)
    if not trimmed.startswith(prefix):
        return None
    body = _js_trim(trimmed[len(prefix):])
    if not body.startswith(_DIRECTIVE_NAMESPACE):
        return None
    return body[len(_DIRECTIVE_NAMESPACE):]


def _read_directives(lines, notation):
    """Consume the `logicprobe:` directives; returns (directives, body_lines)."""
    directives = {'terminals': [], 'aliases': {}, 'variables': {}}
    body = []
    for line in lines:
        text = _directive_body(line, notation)
        if text is None:
            body.append(line)
            continue
        if text.startswith('uml '):
            continue
        if text.startswith('init '):
            directives['init'] = _js_trim(text[5:])
            continue
        if text.startswith('terminal '):
            for sid in text[9:].split(','):
                trimmed = _js_trim(sid)
                if trimmed != '':
                    directives['terminals'].append(trimmed)
            continue
        if text.startswith('alias '):
            rest = _js_trim(text[6:])
            split = rest.find(' ')
            if split > 0:
                directives['aliases'][rest[:split]] = _js_trim(rest[split + 1:])
            continue
        if text.startswith('variable '):
            rest = _js_trim(text[9:])
            split = rest.rfind(' ')
            if split > 0:
                kind = _js_trim(rest[split + 1:])
                if kind == 'integer' or kind == 'boolean':
                    directives['variables'][_js_trim(rest[:split])] = kind
            continue
        body.append(line)
    return directives, body


def _parse_transition_label(label, warnings):
    rest = _js_trim(label)
    guard = None
    bracket = rest.find('[')
    if bracket >= 0:
        close = rest.rfind(']')
        if close < bracket:
            raise ValueError('unbalanced guard brackets in transition label "' + label + '"')
        guard = parse_guard_text(_js_trim(rest[bracket + 1:close]))
        rest = _js_trim(rest[:bracket] + ' ' + rest[close + 1:])
    updates = None
    slash = rest.find('/')
    if slash >= 0:
        action_text = _js_trim(rest[slash + 1:])
        updates = parse_updates_text(action_text, warnings)
        if len(updates) == 0:
            updates = None
        rest = _js_trim(rest[:slash])
    event = _js_trim(rest)
    if event == '':
        raise ValueError('transition label "' + label + '" carries no event name; label the arrow as `event [guard] / actions`')
    parsed = {'event': event}
    if guard is not None:
        parsed['guard'] = guard
    if updates is not None:
        parsed['updates'] = updates
    return parsed


def _infer_variables(transitions, declared):
    """Recover the variable list from the diagram; directives win, guards/actions are the fallback."""
    kinds = dict(declared)

    def note(name, kind):
        if name in declared:
            return
        current = kinds.get(name)
        if current is None:
            kinds[name] = kind
        elif current != kind:
            kinds[name] = 'integer'

    def walk(guard):
        if guard is None:
            return
        if 'variable' in guard:
            note(guard['variable'], 'boolean' if isinstance(guard['value'], bool) else 'integer')
            return
        if 'all' in guard:
            for child in guard['all']:
                walk(child)
            return
        if 'any' in guard:
            for child in guard['any']:
                walk(child)
            return
        walk(guard['not'])

    for transition in transitions:
        walk(transition.get('guard'))
        for update in transition.get('updates') or []:
            note(update['variable'], 'integer')
    return [{'name': name, 'kind': kind, 'init': False if kind == 'boolean' else 0} for name, kind in kinds.items()]


def _raw_to_model(raw, directives, warnings):
    aliases = directives['aliases']

    def id_of(name):
        return aliases.get(name, name)

    # Alias directives restore ids the notation cannot spell; they win over the alias itself.
    names = []
    seen_names = set()

    def add_name(name):
        if name is None or name in seen_names:
            return
        seen_names.add(name)
        names.append(name)

    for name in raw['states']:
        add_name(name)
    # A state can be known without ever being an edge endpoint: the initial
    # pseudostate (`[*] --> X`) and the final mark (`Y --> [*]`) both name states a
    # hand-written diagram never declares, and an isolated state has no edge at all.
    add_name(raw['initialState'])
    for name in raw['finalMarks']:
        add_name(name)
    for name in raw['terminals']:
        add_name(name)
    for edge in raw['edges']:
        add_name(edge['from'])
        add_name(edge['to'])
    states = []
    seen_states = set()
    for name in names:
        sid = id_of(name)
        if sid in seen_states:
            continue
        seen_states.add(sid)
        states.append({'id': sid})
    transitions = []
    synthetic = set()
    for edge in raw['edges']:
        frm = id_of(edge['from'])
        to = id_of(edge['to'])
        label = _js_trim(edge['label'])
        guard = None
        updates = None
        if label == '':
            candidate = 't_' + frm + '_' + to
            suffix = 2
            while candidate in synthetic:
                candidate = 't_' + frm + '_' + to + '_' + str(suffix)
                suffix += 1
            synthetic.add(candidate)
            event = candidate
            warnings.append('UML_PARSE_SYNTHETIC_EVENT: arrow ' + frm + ' -> ' + to + ' carries no label; it was named "' + candidate
                            + '". Label the arrow as `event [guard] / actions` so the model keeps the real event name.')
        else:
            parsed = _parse_transition_label(label, warnings)
            event = parsed['event']
            guard = parsed.get('guard')
            updates = parsed.get('updates')
        transition = {'from': frm, 'event': event, 'to': to}
        if guard is not None:
            transition['guard'] = guard
        if updates is not None:
            transition['updates'] = updates
        transitions.append(transition)
    # Init: an explicit `[*] --> X` wins; a directive is the fallback the activity
    # view needs (a flowchart has no initial pseudostate).
    init = None
    if raw['initialState'] is not None:
        init = id_of(raw['initialState'])
    if init is None and directives.get('init') is not None:
        init = id_of(directives['init'])
    if raw['initialState'] is not None and directives.get('init') is not None and id_of(raw['initialState']) != directives['init']:
        warnings.append('UML_PARSE_INIT_CONFLICT: the diagram enters ' + id_of(raw['initialState']) + ' from its initial pseudostate but declares init '
                        + directives['init'] + '; the pseudostate wins.')
    if init is None:
        targeted = set(transition['to'] for transition in transitions)
        roots = [state['id'] for state in states if state['id'] not in targeted]
        if len(roots) == 1:
            init = roots[0]
            warnings.append('UML_PARSE_INIT_INFERRED: no initial state was declared; "' + init
                            + '" is the only state nothing enters, so it is used as init.')
        else:
            raise ValueError('no initial state: add `[*] --> <state>` (or a `' + _DIRECTIVE_NAMESPACE
                             + 'init <state>` directive); found ' + str(len(roots)) + ' entry states')
    terminal_names = set(id_of(name) for name in raw['terminals'])
    for name in directives['terminals']:
        terminal_names.add(id_of(name))
    for name in raw['finalMarks']:
        terminal_names.add(id_of(name))
    for state in states:
        if state['id'] in terminal_names:
            state['terminal'] = True
    variables = _infer_variables(transitions, directives['variables'])
    model = {'schemaVersion': 1, 'init': init, 'states': states, 'transitions': transitions}
    if len(variables) > 0:
        model['variables'] = variables
    ok, model_or_errors = validate_model(model)
    if not ok:
        raise ValueError('the diagram parsed into an invalid model: ' + '; '.join(model_or_errors))
    return model_or_errors


def _parse_state_diagram(text, notation):
    lines = re.split(r'\r?\n', text)
    directives, body = _read_directives(lines, notation)
    raw = {'states': [], 'display': {}, 'edges': [], 'initialState': None, 'terminals': [], 'finalMarks': [], 'warnings': []}
    declared = set()

    def declare(name):
        if name not in declared:
            declared.add(name)
            raw['states'].append(name)

    skip = _MERMAID_STATE_SKIP_RE if notation == 'mermaid' else _PLANTUML_STATE_SKIP_RE
    for raw_line in body:
        line = _js_trim(raw_line)
        if line == '' or (line.startswith('--') and '-->' not in line):
            continue
        if skip.match(line):
            continue
        note = _STATE_NOTE_RE.match(line)
        if note is not None:
            declare(note.group(1))
            if note.group(1) not in raw['display']:
                raw['display'][note.group(1)] = _js_trim(note.group(2))
            continue
        if _NOTE_RE.match(line) or _END_NOTE_RE.match(line):
            continue
        state_decl = _STATE_DECL_RE.match(line)
        if state_decl is not None:
            declare(state_decl.group(2))
            raw['display'][state_decl.group(2)] = state_decl.group(1)
            continue
        bare_state = _BARE_STATE_RE.match(line)
        if bare_state is not None:
            declare(bare_state.group(1))
            continue
        if _CONCURRENCY_RE.match(line):
            raw['warnings'].append('UML_PARSE_CONCURRENCY_FLATTENED: a concurrency region or composite block was flattened; '
                                   'LogicModelV1 has no region construct (use logicprobe_compose_verify for parallel machines).')
            continue
        composite = _COMPOSITE_STATE_RE.match(line)
        if composite is not None:
            raw['warnings'].append('UML_PARSE_COMPOSITE_FLATTENED: composite state "' + _js_trim(composite.group(1))
                                   + '" was flattened into its members.')
            continue
        description = _DESCRIPTION_RE.match(line)
        if description is not None:
            declare(description.group(1))
            if description.group(1) not in raw['display']:
                raw['display'][description.group(1)] = _js_trim(description.group(2))
            continue
        edge = _STATE_EDGE_RE.match(line)
        if edge is not None:
            frm = _js_trim(edge.group(1))
            to = _js_trim(edge.group(2))
            label = _js_trim(edge.group(3) or '')
            if frm == '[*]':
                if raw['initialState'] is not None and raw['initialState'] != to:
                    raw['warnings'].append('UML_PARSE_MULTIPLE_INIT: the diagram enters ' + raw['initialState'] + ' and ' + to
                                           + ' from initial pseudostates; LogicModelV1 has one init, so ' + raw['initialState'] + ' is kept.')
                else:
                    raw['initialState'] = to
                continue
            if to == '[*]':
                raw['finalMarks'].append(frm)
                continue
            declare(frm)
            declare(to)
            raw['edges'].append({'from': frm, 'to': to, 'label': label})
            continue
        raw['warnings'].append('UML_PARSE_IGNORED_LINE: "' + line + '" is not a state diagram statement; it was ignored.')
    model = _raw_to_model(raw, directives, raw['warnings'])
    labels = _map_labels(raw['display'], directives)
    return {'notation': notation, 'diagram': 'state', 'model': model, 'labels': labels, 'warnings': raw['warnings']}


def _strip_quotes(text):
    return re.sub(r'^"|"$', '', text)


def _strip_node(text, raw, declare):
    """Read one node reference (`A`, `A["label"]`, `A(["label"])`) and its display label."""
    trimmed = _js_trim(text)
    if trimmed == '':
        return None
    match = _STRIP_NODE_RE.match(trimmed)
    if match is None:
        quoted_only = _QUOTED_ONLY_RE.match(trimmed)
        if quoted_only is not None:
            declare(quoted_only.group(1))
            return quoted_only.group(1)
        return None
    name = match.group(1)
    shape = match.group(2) or ''
    rest = match.group(3) or ''
    declare(name)
    quoted = _QUOTED_IN_RE.search(rest)
    if quoted is not None:
        label = _js_trim(quoted.group(1))
    else:
        label = _js_trim(re.sub(r'[\[\](){}>]+$', '', re.sub(r'^[\[\](){}>]+', '', rest)))
    if label != '' and name not in raw['display']:
        raw['display'][name] = label
    if shape == '([' or shape == '((' or rest.startswith('(['):
        raw['terminals'].append(name)
    return name


def _parse_activity_diagram(text, notation):
    lines = re.split(r'\r?\n', text)
    directives, body = _read_directives(lines, notation)
    raw = {'states': [], 'display': {}, 'edges': [], 'initialState': None, 'terminals': [], 'finalMarks': [], 'warnings': []}
    declared = set()

    def declare(name):
        if name not in declared:
            declared.add(name)
            raw['states'].append(name)

    in_subgraph = False
    for raw_line in body:
        line = _js_trim(raw_line)
        if line == '' or _ACTIVITY_SKIP_RE.match(line):
            continue
        if _SUBGRAPH_RE.match(line):
            if not in_subgraph:
                in_subgraph = True
                raw['warnings'].append('UML_PARSE_SUBGRAPH_FLATTENED: subgraph blocks were flattened; LogicModelV1 has no hierarchy.')
            continue
        if line == 'end':
            in_subgraph = False
            continue
        shaped = _SHAPED_EDGE_RE.match(line)
        bare = None if shaped is not None else _BARE_EDGE_RE.match(line)
        if shaped is not None or bare is not None:
            match = shaped if shaped is not None else bare
            frm = _strip_node(_js_trim(match.group(1)), raw, declare)
            # Flowchart labels live between bars; the state-diagram form `A --> B : label`
            # is accepted too so a hand-written file that mixes the two still reads.
            raw_to = _js_trim(match.group(3) if shaped is not None else match.group(2))
            label = _js_trim(_strip_quotes(match.group(2))) if shaped is not None else ''
            if shaped is None:
                colon = raw_to.find(':')
                if colon >= 0:
                    label = _strip_quotes(_js_trim(raw_to[colon + 1:]))
                    raw_to = _js_trim(raw_to[:colon])
            to = _strip_node(raw_to, raw, declare)
            if frm is None or to is None:
                continue
            raw['edges'].append({'from': frm, 'to': to, 'label': label})
            continue
        node = _strip_node(line, raw, declare)
        if node is None:
            raw['warnings'].append('UML_PARSE_IGNORED_LINE: "' + line + '" is not a flowchart statement; it was ignored.')
    model = _raw_to_model(raw, directives, raw['warnings'])
    labels = _map_labels(raw['display'], directives)
    return {'notation': notation, 'diagram': 'activity', 'model': model, 'labels': labels, 'warnings': raw['warnings']}


def _map_labels(display, directives):
    out = {}
    for name, label in display.items():
        out[directives['aliases'].get(name, name)] = label
    return out


def parse_uml(text, notation='auto'):
    """Parse a Mermaid or PlantUML diagram back into a LogicModelV1."""
    resolved = _detect_notation(text) if notation == 'auto' else notation
    kind = _detect_diagram(text)
    if kind == 'sequence':
        raise ValueError('a sequence diagram is a trace, not a machine: parsing it would drop every branch the trace did not walk. '
                         'Render diagram "state" or "activity" and parse that instead.')
    return _parse_state_diagram(text, resolved) if kind == 'state' else _parse_activity_diagram(text, resolved)


# ---- review ---------------------------------------------------------------

def _reachable_states(model):
    adjacency = {}
    for transition in model['transitions']:
        adjacency.setdefault(transition['from'], []).append(transition['to'])
    visited = set([model['init']])
    queue = deque([model['init']])
    while len(queue) > 0:
        current = queue.popleft()
        for nxt in adjacency.get(current, []):
            if nxt not in visited:
                visited.add(nxt)
                queue.append(nxt)
    return visited


def _canonical_transition(transition):
    guard = guard_text(transition['guard']) if transition.get('guard') is not None else ''
    updates = _updates_text(transition['updates']) if transition.get('updates') is not None else ''
    return transition['from'] + '|' + transition['event'] + '|' + transition['to'] + '|' + guard + '|' + updates


def _documented_meaning(label, sid):
    """The narrative meaning a diagram label carries, if it carries one beyond the bare id."""
    if label is None:
        return None
    trimmed = _js_trim(label)
    if trimmed == '' or trimmed == sid:
        return None
    for open_char, close_char in (('（', '）'), ('(', ')')):
        prefix = sid + open_char
        if trimmed.startswith(prefix) and trimmed.endswith(close_char):
            return trimmed[len(prefix):len(trimmed) - len(close_char)]
    return trimmed


def _collect_guard_variables(guard, sink):
    if 'variable' in guard:
        sink.add(guard['variable'])
        return
    if 'all' in guard:
        for child in guard['all']:
            _collect_guard_variables(child, sink)
        return
    if 'any' in guard:
        for child in guard['any']:
            _collect_guard_variables(child, sink)
        return
    _collect_guard_variables(guard['not'], sink)


def _positive_leaves(guard, sink):
    """Positive, conjunctively-reached leaves — the only ones a complementarity witness may use."""
    if 'variable' in guard:
        sink.append(guard)
        return
    if 'all' in guard:
        for child in guard['all']:
            _positive_leaves(child, sink)
        return
    # `any` and `not` subtrees are skipped on purpose: a leaf under a disjunction is
    # not implied by its branch, and `not (x < 3)` is `x >= 3` only for totally
    # ordered integers — neither is a sound complementarity witness.


_COMPLEMENTS = (('<', '>='), ('<=', '>'), ('==', '!='))


def _complementary_variable(guards):
    """Name a variable whose guards contain a complementary pair, or None when there is none."""
    leaves = []
    for guard in guards:
        _positive_leaves(guard, leaves)
    for i in range(len(leaves)):
        for j in range(i + 1, len(leaves)):
            left = leaves[i]
            right = leaves[j]
            if left['variable'] != right['variable']:
                continue
            if not _js_strict_equal(left['value'], right['value']):
                continue
            for one, other in _COMPLEMENTS:
                if (left['op'] == one and right['op'] == other) or (left['op'] == other and right['op'] == one):
                    return left['variable']
    return None


def _structural_findings(model, labels, warnings):
    findings = []
    reachable = _reachable_states(model)
    outgoing = {}
    for transition in model['transitions']:
        outgoing.setdefault(transition['from'], []).append(transition)

    unreachable = [state['id'] for state in model['states'] if state['id'] not in reachable]
    if len(unreachable) > 0:
        findings.append({
            'code': 'UML002_UNREACHABLE_STATE',
            'severity': 'error',
            'message': str(len(unreachable)) + ' state(s) cannot be entered from init along any transition, so the diagram draws flow nobody can reach.',
            'states': unreachable,
            'detail': 'Structural reachability (guards ignored). Guard-aware reachability is S1 in logicprobe_verify.',
        })

    dead_ends = [state['id'] for state in model['states']
                 if state.get('terminal') is not True and len(outgoing.get(state['id'], [])) == 0]
    if len(dead_ends) > 0:
        findings.append({
            'code': 'UML003_DEAD_END_STATE',
            'severity': 'error',
            'message': str(len(dead_ends)) + ' non-terminal state(s) have no outgoing transition: the flow stops there without a modelled terminal.',
            'states': dead_ends,
            'detail': 'Either the state is terminal (add `X --> [*]`) or the outgoing flow is missing from the model. '
                      'logicprobe_verify S2 reports the same shape at runtime granularity.',
        })

    groups = {}
    for transition in model['transitions']:
        key = transition['from'] + '\u0000' + transition['event']
        groups.setdefault(key, []).append(transition)
    ambiguous = []
    overlapping = []
    inexhaustive = []
    probably_exhaustive = []
    complementary = []
    for group in groups.values():
        unguarded = [transition for transition in group if transition.get('guard') is None]
        guarded = [transition for transition in group if transition.get('guard') is not None]
        if len(unguarded) > 1:
            for transition in unguarded:
                ambiguous.append({'from': transition['from'], 'event': transition['event'], 'to': transition['to']})
        seen_guards = {}
        for transition in guarded:
            text = guard_text(transition['guard'])
            if text in seen_guards:
                overlapping.append({'from': transition['from'], 'event': transition['event'], 'to': transition['to']})
            else:
                seen_guards[text] = transition
        if len(guarded) > 0 and len(unguarded) == 0:
            row = {'from': group[0]['from'], 'event': group[0]['event'], 'to': group[0]['to']}
            # A complementary pair on one variable (`x < 3` / `x >= 3`) is exhaustive for
            # any valuation, so the structural warning would be a false alarm there. The
            # pair test is deliberately narrow — it cannot prove exhaustiveness, only
            # recognise the common shape, which is why the finding stays on the report at
            # info severity and still routes to S6.
            witness = _complementary_variable([transition['guard'] for transition in guarded])
            if witness is None:
                inexhaustive.append(row)
            else:
                probably_exhaustive.append(row)
                complementary.append(witness)
    if len(ambiguous) > 0:
        findings.append({
            'code': 'UML004_AMBIGUOUS_BRANCH',
            'severity': 'error',
            'message': str(len(ambiguous)) + ' branch(es) share a (state, event) with no guard at all: '
                       'the diagram shows two unconditional arrows for one event, which no reader can resolve.',
            'transitions': ambiguous,
            'detail': 'Keep one unguarded branch per (state, event) as the else case, and guard the others. '
                      'logicprobe_verify S4 is the authoritative determinism check.',
        })
    if len(overlapping) > 0:
        findings.append({
            'code': 'UML005_OVERLAPPING_GUARD',
            'severity': 'warning',
            'message': str(len(overlapping)) + ' transition(s) repeat a guard already used by another branch of the same (state, event).',
            'transitions': overlapping,
        })
    if len(inexhaustive) > 0:
        findings.append({
            'code': 'UML006_INEXHAUSTIVE_BRANCH',
            'severity': 'warning',
            'message': str(len(inexhaustive)) + ' (state, event) group(s) have only guarded branches and no default: '
                       'if every guard is false the flow vanishes, and the diagram still implies coverage.',
            'transitions': inexhaustive,
            'detail': 'Add an unguarded else branch, or confirm exhaustiveness with logicprobe_verify S6 (which evaluates guards over real valuations).',
        })
    if len(probably_exhaustive) > 0:
        findings.append({
            'code': 'UML006_INEXHAUSTIVE_BRANCH',
            'severity': 'info',
            'message': str(len(probably_exhaustive)) + ' (state, event) group(s) have guards that look complementary on '
                       + ', '.join(dict.fromkeys(complementary))
                       + ', so they are probably exhaustive — but no default branch exists and only logicprobe_verify S6 can settle it.',
            'transitions': probably_exhaustive,
        })

    events_by_reachable = dict.fromkeys(transition['event'] for transition in model['transitions']
                                        if transition['from'] in reachable)
    events_anywhere = dict.fromkeys(transition['event'] for transition in model['transitions'])
    dead_events = [event for event in events_anywhere if event not in events_by_reachable]
    if len(dead_events) > 0:
        findings.append({
            'code': 'UML007_UNUSED_EVENT',
            'severity': 'warning',
            'message': str(len(dead_events)) + ' event(s) only fire from states nothing can reach, so the diagram shows messages that never arrive.',
            'events': dead_events,
        })

    self_loops = [transition for transition in model['transitions']
                  if transition['from'] == transition['to'] and transition.get('guard') is None
                  and len(outgoing.get(transition['from'], [])) == 1]
    if len(self_loops) > 0:
        findings.append({
            'code': 'UML008_SELF_LOOP_NO_EXIT',
            'severity': 'warning',
            'message': str(len(self_loops)) + ' state(s) have a single unguarded self-loop and no exit: '
                       'the flow can never leave, which the diagram presents as activity.',
            'states': list(dict.fromkeys(transition['from'] for transition in self_loops)),
            'detail': 'logicprobe_verify S3 reports absorbing cycles (liveness).',
        })

    seen_transitions = {}
    for transition in model['transitions']:
        key = _canonical_transition(transition)
        seen_transitions[key] = seen_transitions.get(key, 0) + 1
    duplicates = [transition for transition in model['transitions']
                  if seen_transitions.get(_canonical_transition(transition), 0) > 1]
    if len(duplicates) > 0:
        findings.append({
            'code': 'UML009_DUPLICATE_TRANSITION',
            'severity': 'warning',
            'message': str(len(duplicates)) + ' transition(s) duplicate an identical (from, event, guard, actions, to) row; '
                       'the diagram draws the same arrow twice.',
            'transitions': [{'from': transition['from'], 'event': transition['event'], 'to': transition['to']} for transition in duplicates],
        })

    guard_variables = set()
    for transition in model['transitions']:
        if transition.get('guard') is not None:
            _collect_guard_variables(transition['guard'], guard_variables)
    updated_variables = set()
    for transition in model['transitions']:
        for update in transition.get('updates') or []:
            updated_variables.add(update['variable'])
    unused_variables = [variable['name'] for variable in (model.get('variables') or [])
                        if variable['name'] not in guard_variables and variable['name'] not in updated_variables]
    if len(unused_variables) > 0:
        findings.append({
            'code': 'UML010_UNUSED_VARIABLE',
            'severity': 'warning',
            'message': str(len(unused_variables)) + ' variable(s) are never read by a guard and never written: '
                       'the diagram carries a symbol with no source.',
            'events': unused_variables,
        })
    unbounded = [variable['name'] for variable in (model.get('variables') or [])
                 if variable['kind'] == 'integer' and ('min' not in variable or 'max' not in variable)]
    if len(unbounded) > 0:
        findings.append({
            'code': 'UML011_UNBOUNDED_VARIABLE',
            'severity': 'info',
            'message': str(len(unbounded)) + ' integer variable(s) declare no min/max, so no range invariant can be checked '
                       'and A5 boundary probing has no declared domain.',
            'detail': ', '.join(unbounded),
        })

    terminals = [state['id'] for state in model['states'] if state.get('terminal') is True]
    if len(terminals) == 0:
        findings.append({
            'code': 'UML012_NO_TERMINAL',
            'severity': 'warning',
            'message': 'no state is terminal: the diagram has no `--> [*]`, so completion, failure and a stuck flow look the same.',
            'detail': 'Mark absorbing states terminal, or state explicitly that the machine is non-terminating.',
        })

    if 'narrative' not in model:
        findings.append({
            'code': 'UML013_NO_NARRATIVE',
            'severity': 'info',
            'message': 'the model carries no narrative block: no state, event or scenario has a natural-language meaning, '
                       'so a reader must re-derive every symbol from the source.',
            'detail': 'Add narrative.states / narrative.events / narrative.scenarios — the schema requires all three and full coverage once the block is present.',
        })

    documented = None
    if labels is not None:
        documented = [sid for sid in labels if _documented_meaning(labels[sid], sid) is not None]
    if documented is not None:
        undocumented = [state['id'] for state in model['states']
                        if _documented_meaning(labels.get(state['id']), state['id']) is None]
        if len(undocumented) > 0:
            findings.append({
                'code': 'UML014_UNDOCUMENTED_STATE',
                'severity': 'info',
                'message': str(len(undocumented)) + ' of ' + str(len(model['states']))
                           + ' states carry no meaning in the diagram (they render as their bare id).',
                'states': undocumented,
                'detail': 'Give each state a `state "meaning" as ID` label or `ID : meaning` description so the diagram can be read against the code.',
            })
        narrative = model.get('narrative')
        if narrative is not None and narrative.get('states') is not None:
            drift = []
            for state in model['states']:
                meaning = _documented_meaning(labels.get(state['id']), state['id'])
                declared = narrative['states'].get(state['id'])
                if meaning is not None and declared is not None and meaning != declared:
                    drift.append(state['id'] + ': diagram "' + meaning + '" vs narrative "' + declared + '"')
            if len(drift) > 0:
                findings.append({
                    'code': 'UML015_LABEL_DRIFT',
                    'severity': 'warning',
                    'message': str(len(drift)) + ' state label(s) disagree with the model narrative: one of the two is stale, '
                               'and the review cannot tell which.',
                    'detail': ' | '.join(drift),
                })

    if len(warnings) > 0:
        findings.append({
            'code': 'UML016_DIAGRAM_PARSE_NOTES',
            'severity': 'info',
            'message': str(len(warnings)) + ' note(s) were produced while rendering or reading the diagram; '
                       'they mark information the notation could not carry.',
            'detail': ' | '.join(warnings),
        })

    return findings


def _compiled_model(input_value):
    ok, model_or_errors = validate_model(input_value)
    if not ok:
        raise ValueError('model invalid: ' + '; '.join(model_or_errors))
    return model_or_errors


def _round_trip_of(model, notation, diagram, max_steps):
    rendered = render_uml(model, notation, diagram, max_steps)
    parsed = parse_uml(rendered['primary'], notation)
    diffs = diff_models(model, parsed['model'])
    report = {
        'notation': notation,
        'diagram': diagram,
        'ok': len(diffs) == 0,
        'modelHash': model_hash(model),
        'parsedHash': model_hash(parsed['model']),
        'diffs': diffs,
        'warnings': list(rendered['warnings']) + list(parsed['warnings']),
    }
    return {'report': report, 'primary': rendered['primary']}


def diff_models(left, right):
    """Compare two machines by structure — the fidelity measure behind the round-trip check."""
    diffs = []
    if left['init'] != right['init']:
        diffs.append('init: ' + left['init'] + ' vs ' + right['init'])
    left_states = [state['id'] for state in left['states']]
    right_states = [state['id'] for state in right['states']]
    for sid in left_states:
        if sid not in right_states:
            diffs.append('state missing after parse: ' + sid)
    for sid in right_states:
        if sid not in left_states:
            diffs.append('state invented by the diagram: ' + sid)
    left_terminal = sorted(state['id'] for state in left['states'] if state.get('terminal') is True)
    right_terminal = sorted(state['id'] for state in right['states'] if state.get('terminal') is True)
    if ', '.join(left_terminal) != ', '.join(right_terminal):
        diffs.append('terminal states: [' + ', '.join(left_terminal) + '] vs [' + ', '.join(right_terminal) + ']')
    left_transitions = sorted(_canonical_transition(transition) for transition in left['transitions'])
    right_transitions = sorted(_canonical_transition(transition) for transition in right['transitions'])
    left_count = {}
    for key in left_transitions:
        left_count[key] = left_count.get(key, 0) + 1
    right_count = {}
    for key in right_transitions:
        right_count[key] = right_count.get(key, 0) + 1
    for key, count in left_count.items():
        other = right_count.get(key, 0)
        if other < count:
            diffs.append('transition lost in the diagram (' + str(count - other) + 'x): ' + key.replace('|', ' '))
    for key, count in right_count.items():
        other = left_count.get(key, 0)
        if other < count:
            diffs.append('transition invented by the diagram (' + str(count - other) + 'x): ' + key.replace('|', ' '))
    left_variables = sorted(variable['name'] + ':' + variable['kind'] for variable in (left.get('variables') or []))
    right_variables = sorted(variable['name'] + ':' + variable['kind'] for variable in (right.get('variables') or []))
    for name in left_variables:
        if name not in right_variables:
            diffs.append('variable missing after parse: ' + name)
    for name in right_variables:
        if name not in left_variables:
            diffs.append('variable invented by the diagram: ' + name)
    return diffs


def review_uml(options):
    """Mirror of reviewUml: review a machine, a diagram, or the match between the two."""
    warnings = []
    findings = []
    has_model = 'model' in options
    has_diagram = isinstance(options.get('diagram'), str) and _js_trim(options['diagram']) != ''
    if not has_model and not has_diagram:
        raise ValueError('review needs `model`, `diagram`, or both')

    notation = 'mermaid'
    if options.get('notation') is not None and options['notation'] != 'auto':
        notation = options['notation']
    kind = options['diagramKind'] if options.get('diagramKind') is not None else 'state'
    model = None
    labels = None
    primary = None
    round_trip = None

    if has_diagram:
        try:
            parsed = parse_uml(options['diagram'], options['notation'] if options.get('notation') is not None else 'auto')
        except ValueError as exc:
            return {
                'ok': False,
                'source': 'model+diagram' if has_model else 'diagram',
                'summary': {'errors': 1, 'warnings': 0, 'info': 0, 'states': 0, 'events': 0, 'transitions': 0,
                            'terminalStates': 0, 'reachableStates': 0, 'documentedStates': 0},
                'findings': [{'code': 'UML001_DIAGRAM_UNREADABLE', 'severity': 'error', 'message': str(exc),
                              'detail': 'The diagram could not be read as a Mermaid/PlantUML state or activity diagram.'}],
                'roundTrip': None,
                'warnings': warnings,
                'nextSteps': ['Fix the diagram syntax (or render one from a model with logicprobe_uml action=render) and review again.'],
            }
        notation = parsed['notation']
        labels = parsed['labels']
        warnings.extend(parsed['warnings'])
        if has_model:
            model = _compiled_model(options['model'])
            diffs = diff_models(model, parsed['model'])
            round_trip = {
                'notation': parsed['notation'],
                'diagram': parsed['diagram'],
                'ok': len(diffs) == 0,
                'modelHash': model_hash(model),
                'parsedHash': model_hash(parsed['model']),
                'diffs': diffs,
                'warnings': list(parsed['warnings']),
            }
            if len(diffs) > 0:
                detail = ' | '.join(diffs[:12])
                if len(diffs) > 12:
                    detail += ' | … ' + str(len(diffs) - 12) + ' more'
                findings.append({
                    'code': 'UML017_ROUND_TRIP_MISMATCH',
                    'severity': 'error',
                    'message': 'the diagram does not carry the model it is presented with: ' + str(len(diffs)) + ' structural difference(s).',
                    'detail': detail,
                })
            if len(diffs) == 0 and labels is not None and 'narrative' not in model:
                warnings.append('UML_REVIEW_DIAGRAM_LABELS_IGNORED_BY_MODEL: the diagram carries state labels but the model has no narrative block, '
                                'so the labels live only in the diagram.')
        else:
            model = parsed['model']
            findings.append({
                'code': 'UML018_FIDELITY_UNCHECKED',
                'severity': 'info',
                'message': 'only a diagram was supplied, so the review reads the diagram as the model: nothing here proves the diagram matches the code it claims to describe.',
                'detail': 'Compare the parsed model against the code (each state/event/guard needs a source citation), '
                          'or pass the machine alongside the diagram to check the two against each other.',
            })
    else:
        model = _compiled_model(options['model'])
        max_steps = options['maxSteps'] if options.get('maxSteps') is not None else 60
        # A sequence view is a trace, so parsing it back would drop every branch the
        # walk never took: the fidelity check cannot apply to it, and pretending it did
        # would either fail spuriously or hide the difference. Render it anyway (the
        # caller asked for that view) and say the check does not apply.
        if kind == 'sequence':
            try:
                rendered = render_uml(model, notation, kind, max_steps)
                primary = rendered['primary']
                warnings.extend(rendered['warnings'])
            except ValueError as exc:
                warnings.append('UML_REVIEW_RENDER_SKIPPED: ' + str(exc))
            findings.append({
                'code': 'UML019_ROUND_TRIP_SKIPPED',
                'severity': 'warning',
                'message': 'a sequence view is one trace, not a restatement of the machine, so the render/parse fidelity check does not apply to it; '
                           'render diagram "state" or "activity" to have the diagram checked against the model.',
            })
        elif options.get('roundTrip') is not False:
            try:
                rendered = _round_trip_of(model, notation, kind, max_steps)
                primary = rendered['primary']
                round_trip = rendered['report']
                warnings.extend(rendered['report']['warnings'])
                if not rendered['report']['ok']:
                    findings.append({
                        'code': 'UML017_ROUND_TRIP_MISMATCH',
                        'severity': 'error',
                        'message': 'the rendered diagram does not read back as the model: ' + str(len(rendered['report']['diffs']))
                                   + ' structural difference(s).',
                        'detail': ' | '.join(rendered['report']['diffs'][:12]),
                    })
            except ValueError as exc:
                message = str(exc)
                warnings.append('UML_REVIEW_ROUND_TRIP_SKIPPED: ' + message)
                findings.append({
                    'code': 'UML019_ROUND_TRIP_SKIPPED',
                    'severity': 'warning',
                    'message': 'the fidelity check could not run for ' + notation + '/' + kind + ': ' + message,
                })
        else:
            findings.append({
                'code': 'UML019_ROUND_TRIP_SKIPPED',
                'severity': 'warning',
                'message': 'the fidelity check was switched off (roundTrip=false); nothing here proves the diagram carries the model.',
            })

    findings.extend(_structural_findings(model, labels, warnings))
    errors = len([finding for finding in findings if finding['severity'] == 'error'])
    warning_count = len([finding for finding in findings if finding['severity'] == 'warning'])
    info = len([finding for finding in findings if finding['severity'] == 'info'])
    reachable = _reachable_states(model)
    if labels is None:
        narrative = model.get('narrative')
        documented_states = 0 if narrative is None or narrative.get('states') is None else len(narrative['states'])
    else:
        documented_states = len([sid for sid in labels if _documented_meaning(labels[sid], sid) is not None])
    events = dict.fromkeys(transition['event'] for transition in model['transitions'])
    next_steps = []
    if errors > 0:
        next_steps.append('Resolve the error findings first — a diagram that cannot be read (or that disagrees with its model) '
                          'will mislead every later review.')
    next_steps.append('Run logicprobe_verify on this model for the behavioural checks (S1-S8 structural, A1-A14 adversarial); '
                      'the review above covers modelling, not behaviour.')
    if 'narrative' not in model:
        next_steps.append('Add narrative.states/events/scenarios so the diagram is readable against the code.')
    if any(finding['code'] == 'UML011_UNBOUNDED_VARIABLE' for finding in findings):
        next_steps.append('Declare min/max (or boundaryChecks) before relying on A5 boundary probes.')
    report = {
        'ok': True,
        'source': 'model+diagram' if (has_model and has_diagram) else ('diagram' if has_diagram else 'model'),
        'summary': {
            'errors': errors,
            'warnings': warning_count,
            'info': info,
            'states': len(model['states']),
            'events': len(events),
            'transitions': len(model['transitions']),
            'terminalStates': len([state for state in model['states'] if state.get('terminal') is True]),
            'reachableStates': len(reachable),
            'documentedStates': documented_states,
        },
        'findings': findings,
        'roundTrip': round_trip,
    }
    if labels is not None:
        report['labels'] = labels
    if has_diagram:
        report['model'] = model
    if primary is not None:
        report['primary'] = primary
    report['warnings'] = warnings
    report['nextSteps'] = next_steps
    return report


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


def _cmd_uml_render(args):
    try:
        model = _load_json_file(args.model)
        result = render_uml(model, args.notation, args.diagram, args.max_steps)
    except (OSError, ValueError) as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}))
        sys.exit(2)
    out = {'notation': result['notation'], 'diagram': result['diagram'],
           'primary': result['primary'], 'warnings': result['warnings']}
    print(json.dumps(out, indent=2))


def _cmd_uml_parse(args):
    try:
        with open(args.diagram, 'r', encoding='utf-8') as handle:
            text = handle.read()
        result = parse_uml(text, args.notation)
    except (OSError, ValueError) as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}))
        sys.exit(2)
    out = {'notation': result['notation'], 'diagram': result['diagram'], 'model': result['model'],
           'labels': result['labels'], 'warnings': result['warnings']}
    print(json.dumps(out, indent=2))


def _cmd_uml_review(args):
    try:
        options = {}
        if args.model:
            options['model'] = _load_json_file(args.model)
        if args.diagram:
            with open(args.diagram, 'r', encoding='utf-8') as handle:
                options['diagram'] = handle.read()
        if args.notation is not None:
            options['notation'] = args.notation
        if args.diagram_kind is not None:
            options['diagramKind'] = args.diagram_kind
        if args.no_round_trip:
            options['roundTrip'] = False
        if args.max_steps is not None:
            options['maxSteps'] = args.max_steps
        report = review_uml(options)
    except (OSError, ValueError) as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}))
        sys.exit(2)
    print(json.dumps(report, indent=2))


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
    p_uml_render = sub.add_parser('uml-render', help='render a LogicModelV1 as Mermaid/PlantUML UML text')
    p_uml_render.add_argument('model')
    p_uml_render.add_argument('--notation', choices=['mermaid', 'plantuml'], default='mermaid')
    p_uml_render.add_argument('--diagram', choices=['state', 'activity', 'sequence'], default='state')
    p_uml_render.add_argument('--max-steps', type=int, default=60)
    p_uml_render.set_defaults(func=_cmd_uml_render)
    p_uml_parse = sub.add_parser('uml-parse', help='parse a Mermaid/PlantUML diagram back into a LogicModelV1')
    p_uml_parse.add_argument('diagram')
    p_uml_parse.add_argument('--notation', choices=['auto', 'mermaid', 'plantuml'], default='auto')
    p_uml_parse.set_defaults(func=_cmd_uml_parse)
    p_uml_review = sub.add_parser('uml-review', help='review a machine, a diagram, or the match between the two')
    p_uml_review.add_argument('--model')
    p_uml_review.add_argument('--diagram')
    p_uml_review.add_argument('--notation', choices=['auto', 'mermaid', 'plantuml'], default='auto')
    p_uml_review.add_argument('--diagram-kind', choices=['state', 'activity', 'sequence'])
    p_uml_review.add_argument('--no-round-trip', action='store_true')
    p_uml_review.add_argument('--max-steps', type=int)
    p_uml_review.set_defaults(func=_cmd_uml_review)
    return parser


def main(argv=None):
    parser = _build_parser()
    args = parser.parse_args(argv)
    args.func(args)


if __name__ == '__main__':
    main()
