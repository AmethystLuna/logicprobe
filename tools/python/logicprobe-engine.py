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


# ---------------------------------------------------------------------------
# Report contract: ran / verdict (P0-1) and metadata keys + hash specs (P0-3/P0-4)
# ---------------------------------------------------------------------------

# Published model-hash specifications. The full normalization rules, the excluded
# keys and a one-line recompute command are in skills/logicprobe/references/hash-spec.md.
#   v1 (1.0.0) drops every `_`-prefixed metadata key at every level before hashing.
#   v0 is the pre-1.0.0 behaviour (no metadata filtering), kept for archived hashes.
# For a model without `_` keys the two are byte-identical.
PUBLISHED_HASH_SPECS = ('v0', 'v1')
DEFAULT_HASH_SPEC = 'v1'


def _without_metadata(value):
    if value is None or not isinstance(value, (dict, list, tuple)):
        return value
    if isinstance(value, (list, tuple)):
        return [_without_metadata(item) for item in value]
    return {key: _without_metadata(item) for key, item in value.items() if not str(key).startswith('_')}


def hash_payload(model, spec=DEFAULT_HASH_SPEC):
    """The exact payload a hash spec hashes."""
    return _without_metadata(model) if spec == 'v1' else model


def model_hash(model, spec=DEFAULT_HASH_SPEC):
    return hashlib.sha256(stable_stringify(hash_payload(model, spec)).encode('utf-8')).hexdigest()


def metadata_keys_of(input_value):
    """Paths of every `_`-prefixed key in the input, sorted."""
    keys = []

    def walk(value, path):
        if value is None or not isinstance(value, (dict, list, tuple)):
            return
        if isinstance(value, (list, tuple)):
            for index, item in enumerate(value):
                walk(item, path + '[' + str(index) + ']')
            return
        for key, item in value.items():
            child = key if path == '' else path + '.' + key
            if str(key).startswith('_'):
                keys.append(child)
            walk(item, child)

    walk(input_value, '')
    keys.sort()
    return keys


def verdict_of(errors, warnings, first_code=None):
    """Decide the verdict from finding counts. `ok` says the tool ran; this says how it went."""
    if errors > 0:
        return {'verdict': 'fail',
                'verdictReason': str(errors) + ' error finding(s)' + ('' if first_code is None else ' (first: ' + first_code + ')')}
    if warnings > 0:
        return {'verdict': 'pass_with_findings', 'verdictReason': 'no error findings; ' + str(warnings) + ' warning finding(s)'}
    return {'verdict': 'pass', 'verdictReason': 'no error or warning findings'}


def verdict_of_findings(findings):
    errors = [f for f in findings if f.get('severity') == 'error']
    warnings = [f for f in findings if f.get('severity') == 'warning']
    return verdict_of(len(errors), len(warnings), errors[0].get('code') if errors else None)


def refusal_verdict(reason):
    return {'verdict': 'fail', 'verdictReason': 'the tool did not run: ' + reason}


# ---------------------------------------------------------------------------
# Report diffing (mirror of src/baseline.ts): "did this slice add findings?"
# ---------------------------------------------------------------------------

def finding_identity(finding):
    """The stable identity of a finding: check + code + a canonical locator (prose excluded)."""
    locator = stable_stringify({key: value for key, value in (('evidence', finding.get('evidence')), ('path', finding.get('path')))
                                if value is not None})
    where = 'message:' + finding['message'] if locator == '{}' else locator
    prefix = '' if finding.get('check') is None else finding['check'] + '|'
    return prefix + finding['code'] + '|' + where


def flatten_report_findings(report):
    """Flatten a report of any family into one finding list (`checks[].findings` or `findings[]`)."""
    if not isinstance(report, dict):
        return []
    flat = []
    checks = report.get('checks')
    if isinstance(checks, list):
        for check in checks:
            if not isinstance(check, dict):
                continue
            cid = check.get('id') if isinstance(check.get('id'), str) else None
            for finding in (check.get('findings') or []):
                flat.append(finding if cid is None else {**finding, 'check': cid})
    for finding in (report.get('findings') or []):
        flat.append(finding)
    return flat


def _report_verdict(report):
    if not isinstance(report, dict):
        return 'fail'
    value = report.get('verdict')
    return value if value in ('pass', 'pass_with_findings', 'fail') else 'fail'


def diff_reports(baseline, current):
    """Compare a baseline report with the current one; the verdict describes the delta."""
    before = flatten_report_findings(baseline)
    after = flatten_report_findings(current)
    before_by_identity = {}
    for finding in before:
        before_by_identity[finding_identity(finding)] = finding
    seen = set()
    added = []
    changed = []
    for finding in after:
        identity = finding_identity(finding)
        seen.add(identity)
        previous = before_by_identity.get(identity)
        if previous is None:
            added.append(finding)
            continue
        if previous.get('severity') != finding.get('severity') or previous.get('message') != finding.get('message'):
            changed.append({
                'identity': identity,
                'code': finding['code'],
                'before': {'severity': previous.get('severity'), 'message': previous.get('message')},
                'after': {'severity': finding.get('severity'), 'message': finding.get('message')},
            })
    removed = [finding for finding in before if finding_identity(finding) not in seen]
    added_errors = [finding for finding in added if finding.get('severity') == 'error']
    added_warnings = [finding for finding in added if finding.get('severity') == 'warning']
    if added_errors:
        delta = {'verdict': 'fail',
                 'verdictReason': str(len(added)) + ' new finding(s) (' + str(len(added_errors)) + ' error)'
                                  + ' (first: ' + added_errors[0]['code'] + ')'}
    elif added:
        delta = {'verdict': 'pass_with_findings', 'verdictReason': str(len(added)) + ' new warning finding(s), no new errors'}
    elif removed:
        delta = {'verdict': 'pass', 'verdictReason': 'no new findings; ' + str(len(removed)) + ' finding(s) resolved'}
    else:
        delta = {'verdict': 'pass', 'verdictReason': 'no new findings, nothing resolved'}

    next_steps = []
    if added_errors:
        next_steps.append('Fix or explicitly accept the ' + str(len(added_errors)) + ' new error finding(s) before calling this slice done: the baseline is what "not worse" is measured against.')
    elif added:
        next_steps.append('The new warnings are not failures, but they are new: decide per finding whether the change introduced them or the baseline was incomplete.')
    else:
        next_steps.append('No new findings: re-record the baseline with this report if the slice is accepted, so the next comparison starts from it.')
    if changed:
        next_steps.append('Review the ' + str(len(changed)) + ' changed finding(s): the same locator now reports something different, which usually means the fix moved the problem.')
    if removed:
        next_steps.append(str(len(removed)) + ' finding(s) from the baseline are gone — confirm they were fixed rather than renamed out of the report (a renamed check or a reworded message changes the identity).')
    if _report_verdict(current) == 'fail':
        next_steps.append('The current report still fails on its own terms; the delta being clean does not make the run clean.')

    return {
        'ok': True,
        'ran': True,
        **delta,
        'schema': REPORT_SCHEMAS['baseline'],
        'currentVerdict': _report_verdict(current),
        'added': added,
        'removed': removed,
        'changed': changed,
        'summary': {
            'baseline': len(before),
            'current': len(after),
            'added': len(added),
            'removed': len(removed),
            'changed': len(changed),
            'addedErrors': len(added_errors),
            'addedWarnings': len(added_warnings),
        },
        'nextSteps': next_steps,
    }


# Versioned report contracts: every result carries `schema`, so a consumer can branch on
# the contract instead of sniffing fields.
REPORT_SCHEMAS = {
    'verify': 'logicprobe/verify/v1',
    'compose': 'logicprobe/compose/v1',
    'datamodel': 'logicprobe/datamodel/v1',
    'concurrency': 'logicprobe/concurrency/v1',
    'export': 'logicprobe/export/v1',
    'umlRender': 'logicprobe/uml/render/v1',
    'umlParse': 'logicprobe/uml/parse/v1',
    'umlReview': 'logicprobe/uml/review/v1',
    'structure': 'logicprobe/structure/v1',
    'granularity': 'logicprobe/granularity/v1',
    'baseline': 'logicprobe/baseline/v1',
}


def narrative_coverage_of(model):
    """How much of the model the narrative documents, as `covered/total` per dimension."""
    narrative = model.get('narrative')
    if narrative is None:
        return None
    transitions = model.get('transitions') or []
    groups = set(t['from'] + '|' + t['event'] for t in transitions)
    events = set(t['event'] for t in transitions)
    described_states = 0 if narrative.get('states') is None else len(narrative['states'])
    described_events = 0 if narrative.get('events') is None else len(narrative['events'])
    described_groups = 0 if narrative.get('scenarios') is None else len(set(s['from'] + '|' + s['event'] for s in narrative['scenarios']))
    return {
        'states': str(described_states) + '/' + str(len(model.get('states') or [])),
        'events': str(described_events) + '/' + str(len(events)),
        'scenarios': str(described_groups) + '/' + str(len(groups)),
    }


def narrative_complete(coverage):
    if coverage is None:
        return False
    return all(part.split('/')[0] == part.split('/')[1] for part in coverage.values())


def verification_next_steps(checks, coverage):
    """Mirror of verificationNextSteps: derived only from the checks and the coverage."""
    steps = []
    failed = [check['id'] + ' ' + check['name'] for check in checks if check['status'] == 'fail']
    warning_codes = sorted(set(finding['code'] for check in checks for finding in check['findings']
                               if finding.get('severity') == 'warning'))
    if failed:
        steps.append('Resolve the failing checks first: ' + ', '.join(failed) + '.')
    if warning_codes:
        steps.append('Review the warning findings (' + ', '.join(warning_codes) + '): they are not failures, but they are not silence either.')
    if coverage is not None and not narrative_complete(coverage):
        steps.append('Complete the narrative (states ' + coverage['states'] + ', events ' + coverage['events']
                     + ', scenarios ' + coverage['scenarios'] + ') — a partial narrative is valid, but a reader still has to re-derive the missing symbols.')
    steps.append('Re-run with beforeModel/stateMapping after the change to prove the behaviour did not regress (D1-D4).')
    return steps


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
        # `_`-prefixed keys are annotation metadata (provenance, verification
        # snapshots, extraction caveats): ignored here and excluded from the hash, so a
        # model can carry its own archive record instead of a sidecar that drifts.
        unexpected = [k for k in value.keys() if k not in allowed and not str(k).startswith('_')]
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
                    unexpected = [k for k in entry.keys() if k not in allowed_keys and not str(k).startswith('_')]
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
                                if key != 'state' and not str(key).startswith('_'):
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
                    # `to` is one state id or a target set. A set with a duplicate
                    # member is a model-authoring slip that would otherwise give one
                    # meaning two hashes, so it is rejected rather than deduplicated.
                    lto = entry.get('to')
                    if isinstance(lto, str):
                        if len(lto) == 0:
                            bad(p + '.to', 'must be a non-empty string')
                        elif lto not in invariant_state_ids:
                            bad(p + '.to', 'references unknown state ' + lto)
                    elif isinstance(lto, list):
                        if len(lto) == 0:
                            bad(p + '.to', 'must be a non-empty array of state ids')
                        else:
                            seen_targets = set()
                            for target_index, target in enumerate(lto):
                                at = p + '.to[' + str(target_index) + ']'
                                if not isinstance(target, str) or len(target) == 0:
                                    bad(at, 'must be a non-empty string')
                                elif target not in invariant_state_ids:
                                    bad(at, 'references unknown state ' + target)
                                elif target in seen_targets:
                                    bad(at, 'duplicates state ' + target + ' in the target set')
                                else:
                                    seen_targets.add(target)
                    else:
                        bad(p + '.to', 'must be a state id or a non-empty array of state ids')
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
            # A narrative is allowed to cover part of the model: states first, events and
            # scenarios later is the natural authoring order, and `narrativeCoverage`
            # reports what is still missing instead of rejecting the file. What stays an
            # error is a narrative that is *wrong* (unknown id, empty description,
            # duplicate scenario) or empty — an empty block claims documentation that
            # does not exist.
            declared_dimensions = [key for key in ('states', 'events', 'scenarios') if narrative.get(key) is not None]
            if not declared_dimensions:
                bad(np_, 'declares no dimension: give at least one of states, events or scenarios (a partial narrative is fine)')
            if narrative.get('states') is not None:
                nstates = narrative.get('states')
                if not _is_plain_object(nstates):
                    bad(np_ + '.states', 'must be an object mapping state id -> natural-language description')
                else:
                    for sid, description in nstates.items():
                        if sid not in state_ids:
                            bad(np_ + '.states', 'references unknown state ' + str(sid))
                        if not isinstance(description, str) or len(description) == 0:
                            bad(np_ + '.states.' + str(sid), 'must be a non-empty string')
            if narrative.get('events') is not None:
                nevents = narrative.get('events')
                if not _is_plain_object(nevents):
                    bad(np_ + '.events', 'must be an object mapping event id -> natural-language description')
                else:
                    for eid, description in nevents.items():
                        if eid not in event_ids:
                            bad(np_ + '.events', 'references unknown event ' + str(eid))
                        if not isinstance(description, str) or len(description) == 0:
                            bad(np_ + '.events.' + str(eid), 'must be a non-empty string')
            if narrative.get('scenarios') is not None:
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
# S1-S8
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


def _is_path_property_invariant(invariant):
    # Whether an invariant asserts a property of whole runs rather than of a single
    # runtime state. These kinds cannot be decided by a state predicate, so they are
    # not part of _shortest_violation_for_invariant (and therefore not of S7), which
    # owns the states; A9-A13 own the verdicts, and _path_property_violation below
    # makes the same verdicts available to A7 and D2.
    return invariant['kind'] in ('leads-to', 'sequence', 'atomicity', 'budget', 'probability')


def _probability_violated(invariant, probability):
    # Whether a probability invariant's bound fails for the computed hit probability.
    eps = 1e-9
    op = invariant['op']
    if op == '>=':
        return probability < invariant['p'] - eps
    if op == '>':
        return probability <= invariant['p'] + eps
    if op == '<=':
        return probability > invariant['p'] + eps
    return probability >= invariant['p'] - eps


def _reachable_runtime_states(model, max_states):
    # Every runtime state reachable from init, capped like the other searches.
    init = _initial_state(model)
    visited = set([_runtime_key(init)])
    reached = [init]
    queue = deque([init])
    steps = 0
    while queue:
        steps += 1
        if steps > max_states:
            break
        current = queue.popleft()
        for event in _all_events(model):
            for nxt in _step_runtime(model, current, event):
                k = _runtime_key(nxt)
                if k in visited:
                    continue
                visited.add(k)
                reached.append(nxt)
                queue.append(nxt)
    return reached


def _path_property_violation(model, max_states, invariant):
    # Violation of a path-property invariant, or None when it holds. Each kind
    # delegates to the search its dedicated probe uses (A9 leads-to, A10 sequence, A11
    # atomicity, A12 budget, A13 probability), so a verdict reported here can never
    # disagree with the probe that owns the kind.
    kind = invariant['kind']
    if kind == 'leads-to':
        targets = set(_leads_to_targets(invariant))
        label = _leads_to_target_label(invariant)
        for runtime in _reachable_runtime_states(model, max_states):
            if runtime['state'] != invariant['from']:
                continue
            bad = _find_leads_to_bad_path(model, runtime, targets, label)
            if bad is not None:
                return {'invariant': invariant, 'path': bad['path'], 'reason': bad['reason']}
        return None
    if kind == 'sequence':
        return _find_sequence_violation(model, max_states, invariant)
    if kind == 'atomicity':
        return _find_atomicity_violation(model, max_states, invariant)
    if kind == 'budget':
        violation = _find_budget_violation(model, max_states, invariant)
        if violation is None:
            return None
        reason = ('a reachable cycle keeps accumulating cost, so no finite budget holds'
                  if violation['unbounded']
                  else 'a run accumulates cost ' + str(violation['cost']) + ', above the declared budget ' + str(invariant['budget']))
        return {'invariant': invariant, 'path': violation['path'], 'reason': reason}
    if kind == 'probability':
        computed = _compute_hit_probability(model, max_states, invariant['target'])
        probability = computed['probability']
        if not _probability_violated(invariant, probability):
            return None
        reason = ('P(hit ' + invariant['target'] + ') = ' + '{:.6f}'.format(probability)
                  + ' does not satisfy ' + invariant['op'] + ' ' + str(invariant['p'])
                  + ('' if computed['converged'] else ' (value iteration did not converge)'))
        return {'invariant': invariant, 'path': [], 'reason': reason}
    return None


def _run_invariants(model, max_states, include_path_properties=False):
    violations = []
    for invariant in model.get('invariants') or []:
        if include_path_properties and _is_path_property_invariant(invariant):
            violation = _path_property_violation(model, max_states, invariant)
        else:
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
# A1-A14
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
    # Path-property invariants are included: "for any invariant that fails" is this
    # check's contract, and a check that silently skips five of the eight kinds cannot
    # honour it. The searches for the state kinds, for sequence, atomicity and budget
    # are breadth-first, so their first witness is the shortest one; the leads-to walk
    # and the probability bound have no such guarantee, and their message says what it
    # found instead of claiming minimality.
    violations = _run_invariants(model, max_states, True)
    findings = []
    for violation in violations:
        invariant = violation['invariant']
        path_length = len(violation['path'])
        if _is_path_property_invariant(invariant):
            message = ('Invariant "' + invariant['id'] + '" violated: ' + violation['reason']
                       + ('' if path_length == 0 else ' (witness path length: ' + str(path_length) + ')'))
        else:
            message = ('Invariant "' + invariant['id'] + '" shortest violating path length: ' + str(path_length)
                       + (' (initial state)' if path_length == 0 else ''))
        findings.append({
            'code': 'A7_SHORTEST_COUNTEREXAMPLE',
            'severity': 'warning',
            'message': message,
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
    elif invariant['kind'] == 'leads-to':
        # A target set maps member by member; a rename that drops a state is reported by
        # D2's own mapped-state check rather than silently changing the property.
        out['from'] = _map_state_id(mapping, invariant['from'])
        to = invariant['to']
        out['to'] = _map_state_id(mapping, to) if isinstance(to, str) else [_map_state_id(mapping, s) for s in to]
    elif invariant['kind'] == 'probability':
        out['target'] = _map_state_id(mapping, invariant['target'])
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
        elif mapped['kind'] == 'leads-to':
            # The state references of a path-property invariant must follow stateMapping
            # too, otherwise a pure rename searches for a state AFTER does not declare.
            for state in [mapped['from']] + _leads_to_targets(mapped):
                if state not in after_states:
                    findings.append({
                        'code': 'D2_MAPPED_STATE_MISSING',
                        'severity': 'warning',
                        'message': 'BEFORE invariant "' + invariant['id'] + '" maps to state ' + state + ', which is not declared in AFTER.',
                        'evidence': {'invariant': invariant['id'], 'state': state},
                    })
        elif mapped['kind'] == 'probability':
            if mapped['target'] not in after_states:
                findings.append({
                    'code': 'D2_MAPPED_STATE_MISSING',
                    'severity': 'warning',
                    'message': 'BEFORE invariant "' + invariant['id'] + '" maps to state ' + mapped['target'] + ', which is not declared in AFTER.',
                    'evidence': {'invariant': invariant['id'], 'state': mapped['target']},
                })
        # Every invariant the engine can decide is re-decided against AFTER.
        # Path-property kinds go through the same searches their dedicated probes use,
        # so D2 can no longer report "all BEFORE invariants continue to hold" while
        # A9-A13 fail on the very same model.
        if _is_path_property_invariant(mapped):
            violation = _path_property_violation(after, max_states, mapped)
        else:
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


def _leads_to_targets(invariant):
    # Target states of a leads-to invariant. The schema accepts one state id or a
    # non-empty array of them, so "reach any of these" needs no separate kind.
    to = invariant['to']
    return [to] if isinstance(to, str) else list(to)


def _leads_to_target_label(invariant):
    # Target list as findings print it. A single target renders as its bare id, so
    # existing messages stay byte-identical.
    return ', '.join(_leads_to_targets(invariant))


def _find_leads_to_bad_path(model, start, targets, label):
    # Find a run from start that reaches none of targets, or None when every run
    # reaches at least one of them. The property is universal (see the A9 row in
    # SKILL.md): one branch that loops forever, or that stops before any target,
    # refutes it.
    #
    # Depth-first walk of the run graph with three colours; runs at a target are
    # success leaves that are never expanded. A node reached while it is on the
    # current walk (GRAY) closes a cycle that avoids every target. A node with no
    # outgoing step at all stops the machine where it stands, which is the same
    # violation for a different reason. A node whose walk completed without a
    # violation is BLACK, and reaching it again from another branch is a shared
    # sub-graph, not a cycle -- that is why the colour map cannot be a plain visited
    # set: a diamond (two branches rejoining) is acyclic and must pass, while a
    # genuine cycle must not. A run is identified by its state plus its variable
    # values.
    if start['state'] in targets:
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
                return {'path': frame['path'], 'reason': 'Dead end before target ' + label}
        if frame['index'] >= len(frame['nexts']):
            color[_runtime_key(frame['runtime'])] = BLACK
            stack.pop()
            continue
        item = frame['nexts'][frame['index']]
        frame['index'] += 1
        step = {'from': frame['runtime']['state'], 'event': item['event'], 'to': item['next']['state']}
        if item['next']['state'] in targets:
            continue
        key = _runtime_key(item['next'])
        seen = color.get(key)
        if seen == GRAY:
            return {'path': frame['path'] + [step], 'reason': 'Cycle avoids target ' + label}
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
        targets = set(_leads_to_targets(invariant))
        label = _leads_to_target_label(invariant)
        for runtime in exploration['reachable']:
            if runtime['state'] != invariant['from']:
                continue
            bad = _find_leads_to_bad_path(model, runtime, targets, label)
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
    for invariant in model.get('invariants') or []:
        if invariant['kind'] != 'probability':
            continue
        result = _compute_hit_probability(model, max_states, invariant['target'])
        probability = result['probability']
        converged = result['converged']
        op = invariant['op']
        p_bound = invariant['p']
        if _probability_violated(invariant, probability):
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
    hash_spec = options.get('hashSpec', DEFAULT_HASH_SPEC)
    metadata_keys = metadata_keys_of(input_value)
    metadata = {} if not metadata_keys else {'metadataKeys': metadata_keys}
    ok_model, model_or_errors = validate_model(input_value)
    if not ok_model:
        errors = model_or_errors
        findings = [{'code': 'MODEL_INVALID', 'severity': 'error', 'message': message} for message in errors]
        model_check = {
            'id': 'MODEL',
            'name': 'Model Validation',
            'status': 'fail',
            'detail': 'Model schema validation failed: ' + str(len(errors)) + ' errors',
            'findings': findings,
        }
        return {
            'ok': False,
            'ran': True,
            **verdict_of_findings(findings),
            'schema': REPORT_SCHEMAS['verify'],
            'schemaVersion': 1,
            'hashSpec': hash_spec,
            'modelHash': '',
            'hashes': {'hashSpec': hash_spec, 'modelHash': ''},
            **metadata,
            'summary': {'states': 0, 'transitions': 0, 'errors': len(errors), 'warnings': 0, 'checksRun': 0},
            'checks': [model_check],
            'nextSteps': verification_next_steps([model_check], None),
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
            before_findings = [{'code': 'BEFORE_MODEL_INVALID', 'severity': 'error', 'message': message} for message in before_errors]
            all_findings = [f for check in checks for f in check['findings']] + before_findings
            return {
                'ok': False,
                'ran': True,
                **verdict_of_findings(all_findings),
                'schema': REPORT_SCHEMAS['verify'],
                'schemaVersion': 1,
                'hashSpec': hash_spec,
                'modelHash': model_hash(model, hash_spec),
                'hashes': {'hashSpec': hash_spec, 'modelHash': model_hash(model, hash_spec),
                           'afterModelHash': model_hash(model, hash_spec)},
                **metadata,
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
                    'findings': before_findings,
                }],
                'nextSteps': verification_next_steps(checks, narrative_coverage_of(model)),
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
    narrative_coverage = narrative_coverage_of(model)
    report = {
        'ok': True,
        'ran': True,
        **verdict_of_findings([f for check in checks for f in check['findings']]),
        'schema': REPORT_SCHEMAS['verify'],
        'schemaVersion': 1,
        'hashSpec': hash_spec,
        'modelHash': model_hash(model, hash_spec),
        'hashes': {
            'hashSpec': hash_spec,
            'modelHash': model_hash(model, hash_spec),
            **({} if comparison is None else {'beforeModelHash': comparison['beforeModelHash'],
                                              'afterModelHash': comparison['afterModelHash']}),
        },
        **metadata,
        **({} if narrative_coverage is None else {'narrativeCoverage': narrative_coverage}),
        'summary': {
            'states': len(model.get('states') or []),
            'transitions': len(model.get('transitions') or []),
            'errors': errors,
            'warnings': warnings,
            'checksRun': len(checks),
            'truncated': exploration['truncated'],
        },
        'checks': checks,
        'nextSteps': verification_next_steps(checks, narrative_coverage),
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
    # `rendezvous_order` keeps the caller's order for report iteration; the set is only
    # for membership tests (a Python set's iteration order is hash-based, and the C2
    # findings must come out in the same sequence as the TypeScript engine's).
    rendezvous_order = list(dict.fromkeys(options.get('rendezvous') or []))
    rendezvous_set = set(rendezvous_order)
    max_states = options.get('maxStates', DEFAULT_MAX_STATES)
    hash_spec = options.get('hashSpec', DEFAULT_HASH_SPEC)
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
            hashes.append(model_hash(model_or_errors, hash_spec))
    machine_summary = [{'modelHash': hashes[i] if i < len(hashes) else '', 'states': len(m['states'] or []), 'transitions': len(m['transitions'] or [])}
                       for i, m in enumerate(models)]
    if model_findings or len(models) < 2:
        if len(models) < 2 and not model_findings:
            model_findings.append({'code': 'MODEL_INVALID', 'severity': 'error',
                                   'message': 'composition requires at least two machines'})
        return {
            'ok': False,
            'ran': True,
            **verdict_of_findings(model_findings),
            'schema': REPORT_SCHEMAS['compose'],
            'hashSpec': hash_spec,
            'hashes': {'hashSpec': hash_spec, 'machines': hashes},
            'summary': {'machineCount': len(models), 'machines': machine_summary, 'compositeStates': 0,
                        'errors': len(model_findings), 'warnings': 0, 'truncated': False},
            'checks': [{'id': 'MODEL', 'name': 'Machine Validation', 'status': 'fail',
                        'detail': 'composition input validation failed', 'findings': model_findings}],
            'nextSteps': ['Fix the machine that failed validation, then re-run the composition.'],
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
    # Per-machine enablement, collected while the state space is explored: a rendezvous
    # that never fires must say *which* machine never had it enabled.
    ever_enabled = {}
    enabled_states = {}
    co_enabled_nodes = {}
    for event in rendezvous_set:
        fired_count[event] = 0
        ever_enabled[event] = set()
        enabled_states[event] = [[] for _ in models]
        co_enabled_nodes[event] = 0
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
        # Enablement census for C2: which machines could fire each rendezvous here.
        for event in rendezvous_set:
            declaring = [i for i in range(len(models)) if event in machine_event_sets[i]]
            if not declaring:
                continue
            all_enabled = len(declaring) >= 2
            for i in declaring:
                enabled = (not _is_terminal(models[i], node['runtimes'][i]['state'])
                           and len(_step_runtime(models[i], node['runtimes'][i], event)) > 0)
                if not enabled:
                    all_enabled = False
                    continue
                ever_enabled[event].add(i)
                states = enabled_states[event][i]
                if node['runtimes'][i]['state'] not in states and len(states) < 8:
                    states.append(node['runtimes'][i]['state'])
            if all_enabled:
                co_enabled_nodes[event] = co_enabled_nodes.get(event, 0) + 1
        if not moves and not all_terminal:
            # Why nobody can advance, per machine: its state, its alphabet, and for every
            # event either the rendezvous partner that is not ready or the transition that
            # does not fire.
            per_machine = []
            for i, runtime in enumerate(node['runtimes']):
                terminal = _is_terminal(models[i], runtime['state'])
                blocked = []
                if not terminal:
                    for event in _all_events(models[i]):
                        enabled = len(_step_runtime(models[i], runtime, event)) > 0
                        # A rendezvous event is not fireable just because this machine has a
                        # transition: it needs every declaring machine enabled at once.
                        if event not in rendezvous_set:
                            blocked.append({'event': event, 'reason': 'enabled' if enabled else 'no-enabled-transition'})
                            continue
                        declaring = [j for j in range(len(models)) if event in machine_event_sets[j]]
                        if len(declaring) < 2:
                            blocked.append({'event': event, 'reason': 'rendezvous-needs-partner'})
                            continue
                        partners_ready = all(not _is_terminal(models[j], node['runtimes'][j]['state'])
                                             and len(_step_runtime(models[j], node['runtimes'][j], event)) > 0
                                             for j in declaring)
                        if not partners_ready:
                            blocked.append({'event': event, 'reason': 'rendezvous-partner-not-ready'})
                            continue
                        blocked.append({'event': event, 'reason': 'enabled' if enabled else 'no-enabled-transition'})
                per_machine.append({'index': i, 'state': runtime['state'], 'terminal': terminal, 'blocked': blocked})
            reasons = []
            for machine in per_machine:
                if machine['terminal']:
                    continue
                detail = ('empty event alphabet' if not machine['blocked']
                          else ', '.join(entry['event'] + ' (' + entry['reason'] + ')' for entry in machine['blocked']))
                reasons.append('machine ' + str(machine['index']) + ' at ' + machine['state'] + ': ' + detail)
            c1_findings.append({
                'code': 'C1_COMPOSITION_DEADLOCK',
                'severity': 'error',
                'message': 'Composition deadlock: no machine can advance from (' + ', '.join(r['state'] for r in node['runtimes']) + ') while at least one is not terminal.',
                'detail': 'Shortest counterexample (breadth-first): ' + str(len(node['path'])) + ' step(s) to reach it. ' + ' | '.join(reasons),
                'evidence': {'steps': node['path'], 'states': [r['state'] for r in node['runtimes']],
                             'depth': len(node['path']), 'perMachine': per_machine, 'reasons': reasons},
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
    # Iterate the caller's order, not a set's hash order: the C2 findings are part of the
    # report contract, so two engines must list them in the same sequence.
    for event in rendezvous_order:
        if event not in all_events_set:
            continue
        if fired_count.get(event, 0) == 0:
            machines = [{'index': index, 'declares': event in machine_event_sets[index],
                         'everEnabled': index in ever_enabled[event],
                         'enabledAt': enabled_states[event][index]}
                        for index in range(len(models))]
            declaring = [machine for machine in machines if machine['declares']]
            never_enabled = [machine for machine in declaring if not machine['everEnabled']]
            co_enabled = co_enabled_nodes.get(event, 0)
            if len(declaring) < 2:
                reason = ('only ' + str(len(declaring)) + ' machine(s) declare it (machine '
                          + ', '.join(str(machine['index']) for machine in declaring) + '); a handshake needs at least two')
            elif never_enabled:
                reason = ('machine ' + ', '.join(str(machine['index']) for machine in never_enabled)
                          + ' declares it but never has it enabled (no transition, or the guard never holds)')
            else:
                reason = ('every declaring machine enables it somewhere, but never at the same time ('
                          + str(co_enabled) + ' composite state(s) had all of them ready)')
            # A truncated exploration cannot prove that a handshake never happens.
            caveat = (' The search was truncated at ' + str(max_states) + ' composite states, so this may be an artefact of the cap rather than a property of the model.'
                      if truncated else '')
            c2_findings.append({
                'code': 'C2_RENDEZVOUS_NEVER_FIRES',
                'severity': 'warning',
                'message': 'Rendezvous event ' + event + ' can never fire: ' + reason + '.' + caveat,
                'detail': ' | '.join('machine ' + str(machine['index']) + (' declares' if machine['declares'] else ' does not declare')
                                     + (', enabled at ' + ('/'.join(machine['enabledAt']) if machine['enabledAt'] else 'no visited state')
                                        if machine['everEnabled'] else ', never enabled') for machine in machines),
                'evidence': {'event': event, 'machines': machines, 'declaring': [machine['index'] for machine in declaring],
                             'coEnabledNodes': co_enabled, 'reason': reason, 'truncated': truncated},
            })
    errors = len(c1_findings)
    warnings = len(c2_findings)
    if c1_findings:
        c1_detail = 'Composition deadlocks: ' + str(len(c1_findings))
    elif truncated:
        c1_detail = ('No composition deadlock found, but the search was truncated at ' + str(max_states)
                     + ' composite states: absence is not proven')
    else:
        c1_detail = 'No composition deadlock reachable'
    if c2_findings:
        c2_detail = 'Rendezvous warnings: ' + str(len(c2_findings))
    elif truncated:
        c2_detail = ('All rendezvous events fired, but the search was truncated at ' + str(max_states) + ' composite states')
    else:
        c2_detail = 'All rendezvous events can fire'
    checks = [
        _check_result('C1', 'Composition Deadlock', c1_findings, c1_detail),
        _check_result('C2', 'Rendezvous Sync', c2_findings, c2_detail),
    ]
    next_steps = []
    if errors > 0:
        next_steps.append('Resolve the error findings first: the composition deadlocks at a reachable state, so at least one machine is missing an exit or a handshake partner.')
    if warnings > 0:
        next_steps.append('Review the warning findings: a rendezvous event that can never fire means the handshake is declared but unreachable.')
    next_steps.append('Re-run the composition after the change; every machine must be able to advance, or explain why it is terminal.')
    return {
        'ok': errors == 0,
        'ran': True,
        **verdict_of(errors, warnings, (c1_findings[0]['code'] if c1_findings else (c2_findings[0]['code'] if c2_findings else None))),
        'schema': REPORT_SCHEMAS['compose'],
        'hashSpec': hash_spec,
        'hashes': {'hashSpec': hash_spec, 'machines': hashes},
        'summary': {'machineCount': len(models), 'machines': machine_summary, 'compositeStates': composite_states,
                    'errors': errors, 'warnings': warnings, 'truncated': truncated},
        'checks': checks,
        'nextSteps': next_steps,
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

# PlantUML keywords that declare a construct LogicModelV1 has no place for. Their
# presence marks the text as a component/package/class/deployment/database diagram —
# a different diagram family. A state parser still reads *something* out of such a
# file (the arrows look like transitions), which is why the discarded declarations
# are collected and reported instead of being ignored.
_PLANTUML_OTHER_CONSTRUCT_RE = re.compile(
    r'(component|package|class|interface|enum|enumeration|object|actor|usecase|node|artifact|database|'
    r'rectangle|folder|frame|cloud|storage|collections|queue|stack|agent|boundary|control|entity|deployment|'
    r'protocol|struct|exception|metaclass|stereotype|circle|hexagon|label|port|portin|portout)\b', re.I)

# Mermaid diagram-family headers that are neither a state machine nor a flow.
_MERMAID_OTHER_FAMILIES = (
    'classDiagram', 'erDiagram', 'gantt', 'pie', 'journey', 'mindmap', 'gitGraph',
    'C4Context', 'C4Container', 'C4Component', 'C4Dynamic', 'C4Deployment',
    'requirementDiagram', 'timeline', 'quadrantChart', 'sankey-beta', 'block-beta',
    'packet-beta', 'architecture-beta', 'radar-beta', 'treemap-beta', 'xychart-beta',
)

def _other_mermaid_family(text):
    for family in _MERMAID_OTHER_FAMILIES:
        if re.search(r'^\s*' + family + r'\b', text, re.M):
            return family
    return None


def _declared_identifier(text):
    """The node identifier a declaration introduces (`… as ID`, or a bare `component ID`)."""
    alias = re.search(r'\bas\s+([A-Za-z_][A-Za-z0-9_]*)\s*;?\Z', text)
    if alias is not None:
        return alias.group(1)
    bare = re.match(r'^[A-Za-z]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*;?\Z', text)
    return None if bare is None else bare.group(1)


class UmlRefusal(ValueError):
    """A UML front-end refusal; `code` lets the CLI report why instead of a generic input error."""

    def __init__(self, message, code='UML_INPUT'):
        super().__init__(message)
        self.code = code


def parse_findings(parsed):
    """Findings a parse result carries on its own (mirror of the TypeScript parseFindings)."""
    if not parsed['discardedConstructs']:
        return []
    counts = {}
    for entry in parsed['discardedConstructs']:
        counts[entry['construct']] = counts.get(entry['construct'], 0) + 1
    summary = ', '.join(name + ' ×' + str(counts[name]) for name in sorted(counts))
    shown = ' | '.join('line ' + str(entry['line']) + ': ' + entry['text'] for entry in parsed['discardedConstructs'][:12])
    return [{
        'code': 'UML_NOT_A_STATE_DIAGRAM',
        'severity': 'error',
        'message': 'the text is not a state or activity diagram: ' + str(len(parsed['discardedConstructs']))
                   + ' declaration(s) of unsupported construct(s) (' + summary + ') and ' + str(parsed['discardedEdges'])
                   + ' arrow(s) between them were read as states and transitions, so the parsed model is not this diagram.',
        'detail': shown + (' | … ' + str(len(parsed['discardedConstructs']) - 12) + ' more' if len(parsed['discardedConstructs']) > 12 else ''),
    }]


def _detect_notation(text):
    if re.search(r'^\s*@start', text, re.M):
        return 'plantuml'
    if re.search(r'^\s*(stateDiagram|stateDiagram-v2|flowchart|graph|sequenceDiagram)\b', text, re.M):
        return 'mermaid'
    # A known Mermaid family is still Mermaid: say so, and let _detect_diagram refuse
    # it by name instead of blaming the notation.
    if _other_mermaid_family(text) is not None:
        return 'mermaid'
    raise UmlRefusal('cannot tell whether this is Mermaid or PlantUML text: '
                     'expected `stateDiagram-v2` / `flowchart` / `sequenceDiagram`, or `@startuml`')


def _detect_diagram(text):
    if re.search(r'^\s*stateDiagram', text, re.M):
        return 'state'
    if re.search(r'^\s*(flowchart|graph)\b', text, re.M):
        return 'activity'
    if re.search(r'^\s*sequenceDiagram\b', text, re.M):
        return 'sequence'
    family = _other_mermaid_family(text)
    if family is not None:
        raise UmlRefusal('`' + family + '` is not a state or activity diagram: logicprobe models state machines and flows, '
                         'so this diagram family cannot be parsed into a LogicModelV1. Discarded: ' + family + ' ×1. '
                         'Render the machine with logicprobe_uml action=render and keep this diagram as its own view.',
                         'UML_NOT_A_STATE_DIAGRAM')
    if re.search(r'^\s*@startuml', text, re.M):
        # PlantUML declares the diagram kind by its body; the state keyword is the only
        # structural one logicprobe emits, everything else in that family is a state diagram too.
        if re.search(r'^\s*participant\b', text, re.M) or re.search(r'->>\s*', text):
            return 'sequence'
        return 'state'
    raise UmlRefusal('cannot tell which diagram kind this text declares')


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
    raw = {'states': [], 'display': {}, 'edges': [], 'initialState': None, 'terminals': [], 'finalMarks': [],
           'warnings': [], 'discarded': [], 'discardedNodes': set()}
    discarded_edges = 0
    declared = set()

    def declare(name):
        if name not in declared:
            declared.add(name)
            raw['states'].append(name)

    skip = _MERMAID_STATE_SKIP_RE if notation == 'mermaid' else _PLANTUML_STATE_SKIP_RE
    in_note = False
    for index, raw_line in enumerate(body):
        line = _js_trim(raw_line)
        if line == '' or (line.startswith('--') and '-->' not in line):
            continue
        if skip.match(line):
            continue
        note_start = _NOTE_RE.match(line) is not None
        note_end = _END_NOTE_RE.match(line) is not None
        if notation == 'plantuml' and not in_note and not note_start and not note_end:
            other = _PLANTUML_OTHER_CONSTRUCT_RE.match(line)
            if other is not None:
                raw['discarded'].append({'construct': other.group(1).lower(), 'line': index + 1, 'text': line})
                identifier = _declared_identifier(line)
                if identifier is not None:
                    raw['discardedNodes'].add(identifier)
                continue
        if note_end:
            in_note = False
            continue
        # A multi-line note body is prose, not a statement: skip it silently rather than
        # reporting one ignored line per line of text.
        if in_note:
            continue
        if note_start and not re.search(r':\s*.+\Z', line):
            in_note = True
            continue
        note = _STATE_NOTE_RE.match(line)
        if note is not None:
            declare(note.group(1))
            if note.group(1) not in raw['display']:
                raw['display'][note.group(1)] = _js_trim(note.group(2))
            continue
        if note_start:
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
            if frm in raw['discardedNodes'] or to in raw['discardedNodes']:
                discarded_edges += 1
            raw['edges'].append({'from': frm, 'to': to, 'label': label})
            continue
        raw['warnings'].append('UML_PARSE_IGNORED_LINE: "' + line + '" is not a state diagram statement; it was ignored.')
    model = _raw_to_model(raw, directives, raw['warnings'])
    labels = _map_labels(raw['display'], directives)
    return {'notation': notation, 'diagram': 'state', 'model': model, 'labels': labels,
            'discardedConstructs': raw['discarded'], 'discardedEdges': discarded_edges, 'warnings': raw['warnings']}


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
    return {'notation': notation, 'diagram': 'activity', 'model': model, 'labels': labels,
            'discardedConstructs': [], 'discardedEdges': 0, 'warnings': raw['warnings']}


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
        raise UmlRefusal('a sequence diagram is a trace, not a machine: parsing it would drop every branch the trace did not walk. '
                         'Render diagram "state" or "activity" and parse that instead.', 'UML_NOT_A_STATE_DIAGRAM')
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
            'detail': 'Add narrative.states / narrative.events / narrative.scenarios — a partial narrative is valid and its coverage is reported; write the states first and fill the rest in later.',
        })
    else:
        # A narrative that covers part of the model is valid: the gap is reported as
        # coverage (and as this info finding), never as a validation failure.
        coverage = narrative_coverage_of(model)
        if coverage is not None and not narrative_complete(coverage):
            findings.append({
                'code': 'UML027_NARRATIVE_PARTIAL',
                'severity': 'info',
                'message': 'the narrative covers part of the model: states ' + coverage['states'] + ', events ' + coverage['events']
                           + ', scenarios ' + coverage['scenarios'] + '. Every uncovered symbol still has to be re-derived from the source.',
                'detail': 'narrativeCoverage carries the same numbers; complete the missing entries when the behaviour settles.',
                'evidence': {'narrativeCoverage': coverage},
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
        'hashSpec': DEFAULT_HASH_SPEC,
        'modelHash': model_hash(model),
        'parsedHash': model_hash(parsed['model']),
        'diffs': diffs,
        'warnings': list(rendered['warnings']) + list(parsed['warnings']),
    }
    return {'report': report, 'primary': rendered['primary'], 'parsed': parsed}


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
    metadata_keys = metadata_keys_of(options['model']) if has_model else []
    metadata = {} if not metadata_keys else {'metadataKeys': metadata_keys}
    discarded_constructs = []
    discarded_edges = 0

    if has_diagram:
        try:
            parsed = parse_uml(options['diagram'], options['notation'] if options.get('notation') is not None else 'auto')
        except ValueError as exc:
            unreadable = {'code': 'UML001_DIAGRAM_UNREADABLE', 'severity': 'error', 'message': str(exc),
                          'detail': 'The diagram could not be read as a Mermaid/PlantUML state or activity diagram.'}
            return {
                'ok': False,
                'ran': True,
                **verdict_of_findings([unreadable]),
                'schema': REPORT_SCHEMAS['umlReview'],
                'source': 'model+diagram' if has_model else 'diagram',
                'summary': {'errors': 1, 'warnings': 0, 'info': 0, 'states': 0, 'events': 0, 'transitions': 0,
                            'terminalStates': 0, 'reachableStates': 0, 'documentedStates': 0},
                'findings': [unreadable],
                'roundTrip': None,
                **metadata,
                'hashes': {'hashSpec': DEFAULT_HASH_SPEC},
                'warnings': warnings,
                'nextSteps': ['Fix the diagram syntax (or render one from a model with logicprobe_uml action=render) and review again.'],
            }
        notation = parsed['notation']
        labels = parsed['labels']
        warnings.extend(parsed['warnings'])
        # A diagram from another family parses into something; that something must never
        # be read as a model of this file, so the parse defects are review findings too.
        findings.extend(parse_findings(parsed))
        if parsed['discardedConstructs']:
            discarded_constructs = parsed['discardedConstructs']
            discarded_edges = parsed['discardedEdges']
        if has_model:
            model = _compiled_model(options['model'])
            diffs = diff_models(model, parsed['model'])
            round_trip = {
                'notation': parsed['notation'],
                'diagram': parsed['diagram'],
                'ok': len(diffs) == 0,
                'hashSpec': DEFAULT_HASH_SPEC,
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
    narrative_coverage = narrative_coverage_of(model)
    next_steps = []
    if errors > 0:
        next_steps.append('Resolve the error findings first — a diagram that cannot be read (or that disagrees with its model) '
                          'will mislead every later review.')
    if any(finding['code'] == 'UML_NOT_A_STATE_DIAGRAM' for finding in findings):
        next_steps.append('This text is not a state or activity diagram: keep it as its own view and model the machine as a '
                          'state/activity diagram before reviewing it.')
    next_steps.append('Run logicprobe_verify on this model for the behavioural checks (S1-S8 structural, A1-A14 adversarial); '
                      'the review above covers modelling, not behaviour.')
    if 'narrative' not in model:
        next_steps.append('Add narrative.states/events/scenarios so the diagram is readable against the code.')
    if any(finding['code'] == 'UML011_UNBOUNDED_VARIABLE' for finding in findings):
        next_steps.append('Declare min/max (or boundaryChecks) before relying on A5 boundary probes.')
    report = {
        'ok': True,
        'ran': True,
        **verdict_of_findings(findings),
        'schema': REPORT_SCHEMAS['umlReview'],
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
    report.update(metadata)
    if narrative_coverage is not None:
        report['narrativeCoverage'] = narrative_coverage
    report['hashes'] = {'hashSpec': DEFAULT_HASH_SPEC, **({} if round_trip is None else {
        'modelHash': round_trip['modelHash'], 'parsedHash': round_trip['parsedHash']})}
    if discarded_constructs:
        report['discardedConstructs'] = discarded_constructs
        report['discardedEdges'] = discarded_edges
    report['warnings'] = warnings
    report['nextSteps'] = next_steps
    return report


# ---------------------------------------------------------------------------
# Structure-diagram review (mirror of src/structure.ts)
#
# A structure diagram is not a state machine: this reads the dependency graph the
# diagram draws (components, packages, classes, deployment nodes and their arrows)
# and audits it against an optional dependency matrix. The state-machine front end
# refuses the same text; this is the honest reading of it.
# ---------------------------------------------------------------------------

_STRUCTURE_CONSTRUCT_KIND = {
    'component': 'component', 'componentdiagram': 'component', 'class': 'class',
    'abstract': 'class', 'interface': 'interface', 'enum': 'class', 'object': 'component',
    'actor': 'actor', 'usecase': 'component', 'database': 'database', 'node': 'node',
    'artifact': 'node', 'deployment': 'node', 'rectangle': 'rectangle', 'folder': 'package',
    'frame': 'rectangle', 'cloud': 'cloud', 'queue': 'queue', 'stack': 'queue',
    'storage': 'database', 'collections': 'queue', 'agent': 'component', 'boundary': 'component',
    'control': 'component', 'entity': 'component', 'package': 'package', 'namespace': 'package',
    'module': 'package',
}

_STRUCTURE_CONTAINER_KINDS = ('package',)

_STRUCTURE_DECLARATION_RE = re.compile(
    r'^\s*(component|componentDiagram|class|abstract|interface|enum|object|actor|usecase|database|node|'
    r'artifact|deployment|rectangle|folder|frame|cloud|queue|stack|storage|collections|agent|boundary|'
    r'control|entity|package|namespace|module)\b\s*(.*)\Z', re.I)
_STRUCTURE_PLANTUML_EDGE_RE = re.compile(r'^\s*(.+?)\s*(-->|->|\.\.>|--|==>|<--|<\.\.)\s*(.+?)\s*\Z')
_STRUCTURE_MERMAID_EDGE_RE = re.compile(r'^\s*(.+?)\s*(-->|\.\.>|--\|>|\.\.\|>|--|\.\.)\s*(.+?)\s*\Z')
_STRUCTURE_MERMAID_CLASS_RE = re.compile(r'^\s*class\s+([A-Za-z_][A-Za-z0-9_.-]*)\s*(?:\["([^"]*)"\])?\s*\Z')
_STRUCTURE_MERMAID_BLOCK_RE = re.compile(r'^\s*class\s+([A-Za-z_][A-Za-z0-9_.-]*)\s*\{\Z')
_STRUCTURE_MERMAID_MEMBER_RE = re.compile(r'^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*(?::|\{)')
_STRUCTURE_SKIP_RE = re.compile(r"^skinparam\b|^scale\b|^title\b|^hide\b|^left to right direction|"
                                r"^top to bottom direction|^!theme|^legend\b|^end legend$", re.I)
_STRUCTURE_NOTE_START_RE = re.compile(r'^note\b', re.I)
_STRUCTURE_NOTE_END_RE = re.compile(r'^end\s*note\Z', re.I)


def _structure_clean_label(value):
    trimmed = re.sub(r'^"|"$', '', re.sub(r'^\[|\]$', '', value.strip())).strip()
    return None if trimmed == '' else trimmed


def _structure_read_declaration(rest):
    """Read `X as Y`, `"X" as Y`, `[X] as Y`, `X` -> (id, label)."""
    trimmed = re.sub(r'[;{]\s*\Z', '', rest.strip()).strip()
    if trimmed == '':
        return None, None
    aliased = re.match(r'^(.*?)\s+as\s+([A-Za-z_][A-Za-z0-9_.-]*)\s*\Z', trimmed)
    if aliased is not None:
        return aliased.group(2), _structure_clean_label(aliased.group(1))
    bare = re.match(r'^([A-Za-z_][A-Za-z0-9_.-]*)\s*\Z', trimmed)
    if bare is not None:
        return bare.group(1), None
    quoted = re.match(r'^"([^"]+)"\s*\Z', trimmed)
    if quoted is not None:
        return quoted.group(1), quoted.group(1)
    bracketed = re.match(r'^\[([^\]]+)\]\s*\Z', trimmed)
    if bracketed is not None:
        return bracketed.group(1).strip(), bracketed.group(1).strip()
    return None, _structure_clean_label(trimmed)


def _structure_split_target(text):
    colon = text.find(':')
    if colon < 0:
        return text.strip(), None
    return text[:colon].strip(), text[colon + 1:].strip()


def _structure_node_id(reference):
    trimmed = reference.strip()
    quoted = re.match(r'^"([^"]+)"\Z', trimmed)
    if quoted is not None:
        return quoted.group(1)
    bracketed = re.match(r'^\[([^\]]+)\]\Z', trimmed)
    if bracketed is not None:
        return bracketed.group(1).strip()
    return re.sub(r'^"|"$', '', trimmed)


def _structure_declare(builder, node_id, kind, line, label=None):
    existing = builder['nodes'].get(node_id)
    container = kind in _STRUCTURE_CONTAINER_KINDS
    if existing is None:
        node = {'id': node_id, 'kind': kind, 'container': container, 'line': line, 'declared': True}
        if label is not None:
            node['label'] = label
        if builder['stack']:
            node['parent'] = builder['stack'][-1]
        builder['nodes'][node_id] = node
        return
    existing['declared'] = True
    existing['kind'] = kind
    existing['container'] = container
    if label is not None and 'label' not in existing:
        existing['label'] = label
    if existing.get('line') is None:
        existing['line'] = line


def _structure_reference(builder, node_id, line):
    if node_id in builder['nodes']:
        return
    node = {'id': node_id, 'kind': 'unknown', 'container': False, 'line': line, 'declared': False}
    if builder['stack']:
        node['parent'] = builder['stack'][-1]
    builder['nodes'][node_id] = node


def _parse_plantuml_structure(text):
    builder = {'nodes': {}, 'edges': [], 'warnings': [], 'stack': []}
    in_note = False
    for index, raw_line in enumerate(re.split(r'\r?\n', text)):
        line_number = index + 1
        line = _js_trim(raw_line)
        if line == '':
            continue
        if line.startswith('@start') or line.startswith('@end'):
            continue
        if line.startswith("'") or line.startswith('//'):
            continue
        note_start = _STRUCTURE_NOTE_START_RE.match(line) is not None
        note_end = _STRUCTURE_NOTE_END_RE.match(line) is not None
        if note_end:
            in_note = False
            continue
        if in_note:
            continue
        if note_start and not re.search(r':\s*.+\Z', line):
            in_note = True
            continue
        if note_start:
            continue
        if _STRUCTURE_SKIP_RE.match(line):
            continue
        if line == '}':
            if builder['stack']:
                builder['stack'].pop()
            continue
        declaration = _STRUCTURE_DECLARATION_RE.match(line)
        if declaration is not None:
            kind = _STRUCTURE_CONSTRUCT_KIND.get(declaration.group(1).lower(), 'unknown')
            node_id, label = _structure_read_declaration(declaration.group(2))
            if node_id is None:
                node_id = declaration.group(2).strip()
            if node_id != '':
                _structure_declare(builder, node_id, kind, line_number, label)
                if line.endswith('{'):
                    builder['stack'].append(node_id)
            continue
        edge = _STRUCTURE_PLANTUML_EDGE_RE.match(line)
        if edge is not None:
            frm = _structure_node_id(edge.group(1))
            to_raw, label = _structure_split_target(edge.group(3))
            to = _structure_node_id(to_raw)
            if frm == '' or to == '':
                continue
            _structure_reference(builder, frm, line_number)
            _structure_reference(builder, to, line_number)
            item = {'from': frm, 'to': to, 'line': line_number}
            if label is not None:
                item['label'] = label
            builder['edges'].append(item)
            continue
        builder['warnings'].append('STRUCTURE_IGNORED_LINE: "' + line + '" is not a component, package, class or edge statement; it was ignored.')
    return {'notation': 'plantuml', 'nodes': list(builder['nodes'].values()), 'edges': builder['edges'], 'warnings': builder['warnings']}


def _parse_mermaid_class(text):
    builder = {'nodes': {}, 'edges': [], 'warnings': [], 'stack': []}
    for index, raw_line in enumerate(re.split(r'\r?\n', text)):
        line_number = index + 1
        line = _js_trim(raw_line)
        if line == '' or re.match(r'^classDiagram\b', line) or line.startswith('%%'):
            continue
        if line == '}':
            if builder['stack']:
                builder['stack'].pop()
            continue
        declaration = _STRUCTURE_MERMAID_CLASS_RE.match(line)
        if declaration is not None:
            _structure_declare(builder, declaration.group(1), 'class', line_number, declaration.group(2))
            continue
        block = _STRUCTURE_MERMAID_BLOCK_RE.match(line)
        if block is not None:
            _structure_declare(builder, block.group(1), 'class', line_number)
            builder['stack'].append(block.group(1))
            continue
        edge = _STRUCTURE_MERMAID_EDGE_RE.match(line)
        if edge is not None:
            frm = _structure_node_id(edge.group(1))
            to_raw, label = _structure_split_target(edge.group(3))
            to = _structure_node_id(to_raw)
            if frm == '' or to == '':
                continue
            _structure_reference(builder, frm, line_number)
            _structure_reference(builder, to, line_number)
            item = {'from': frm, 'to': to, 'line': line_number}
            if label is not None:
                item['label'] = label
            builder['edges'].append(item)
            continue
        if builder['stack']:
            continue
        member = _STRUCTURE_MERMAID_MEMBER_RE.match(line)
        if member is not None:
            _structure_declare(builder, member.group(1), 'class', line_number)
            continue
        builder['warnings'].append('STRUCTURE_IGNORED_LINE: "' + line + '" is not a class or edge statement; it was ignored.')
    return {'notation': 'mermaid', 'nodes': list(builder['nodes'].values()), 'edges': builder['edges'], 'warnings': builder['warnings']}


def _detect_structure_notation(text):
    if re.search(r'^\s*@start', text, re.M):
        return 'plantuml'
    if re.search(r'^\s*classDiagram\b', text, re.M):
        return 'mermaid'
    if re.search(r'^\s*(component|package|deployment)\b', text, re.M | re.I):
        return 'plantuml'
    return 'plantuml'


def parse_structure(text, notation='auto'):
    """Parse a structure diagram into nodes and dependency edges (mirror of parseStructure)."""
    resolved = _detect_structure_notation(text) if notation == 'auto' else notation
    return _parse_mermaid_class(text) if resolved == 'mermaid' else _parse_plantuml_structure(text)


def glob_matches(pattern, value):
    """`*` matches any run of characters, `?` exactly one."""
    if pattern == value:
        return True
    if '*' not in pattern and '?' not in pattern:
        return False
    escaped = re.sub(r'([.+^${}()|\[\]\\])', r'\\\1', pattern).replace('*', '.*').replace('?', '.')
    return re.match('^' + escaped + r'\Z', value) is not None


def _matches_any(patterns, value):
    if patterns is None:
        return None
    for pattern in patterns:
        if glob_matches(pattern, value):
            return pattern
    return None


def validate_matrix(input_value):
    """Mirror of validateMatrix: returns (ok, matrix_or_errors)."""
    errors = []
    if not _is_plain_object(input_value):
        return (False, ['matrix: must be an object'])
    allowed = ('rules', 'layers', 'default')
    for key in input_value.keys():
        if key not in allowed:
            errors.append('matrix.' + key + ': unknown field (allowed: rules, layers, default)')
    if input_value.get('default') is not None and input_value['default'] not in ('allow', 'deny'):
        errors.append("matrix.default: must be 'allow' or 'deny'")
    rules = input_value.get('rules')
    if rules is not None:
        if not isinstance(rules, list):
            errors.append('matrix.rules: must be an array')
        else:
            seen = set()
            for index, entry in enumerate(rules):
                path = 'matrix.rules[' + str(index) + ']'
                if not _is_plain_object(entry):
                    errors.append(path + ': must be an object')
                    continue
                for key in entry.keys():
                    if key not in ('id', 'source', 'allow', 'deny', 'require'):
                        errors.append(path + '.' + key + ': unknown field (allowed: id, source, allow, deny, require)')
                rule_id = entry.get('id')
                if not isinstance(rule_id, str) or rule_id == '':
                    errors.append(path + '.id: must be a non-empty string')
                elif rule_id in seen:
                    errors.append(path + '.id: duplicate rule id ' + rule_id)
                else:
                    seen.add(rule_id)
                if entry.get('source') is not None and not isinstance(entry['source'], str):
                    errors.append(path + '.source: must be a string')
                for field in ('allow', 'deny'):
                    value = entry.get(field)
                    if value is None:
                        continue
                    if not isinstance(value, list) or len(value) == 0:
                        errors.append(path + '.' + field + ': must be a non-empty array')
                    elif any(not isinstance(item, str) or item == '' for item in value):
                        errors.append(path + '.' + field + ': every entry must be a non-empty string')
                if entry.get('require') is not None and not isinstance(entry['require'], bool):
                    errors.append(path + '.require: must be a boolean')
                if entry.get('require') is True and entry.get('allow') is None:
                    errors.append(path + '.require: needs `allow` to say which edges must exist')
    layers = input_value.get('layers')
    if layers is not None:
        if not isinstance(layers, list):
            errors.append('matrix.layers: must be an array')
        else:
            for index, entry in enumerate(layers):
                path = 'matrix.layers[' + str(index) + ']'
                if not _is_plain_object(entry):
                    errors.append(path + ': must be an object')
                    continue
                for key in entry.keys():
                    if key not in ('name', 'members'):
                        errors.append(path + '.' + key + ': unknown field (allowed: name, members)')
                if not isinstance(entry.get('name'), str) or entry['name'] == '':
                    errors.append(path + '.name: must be a non-empty string')
                members = entry.get('members')
                if not isinstance(members, list) or len(members) == 0:
                    errors.append(path + '.members: must be a non-empty array')
                elif any(not isinstance(item, str) or item == '' for item in members):
                    errors.append(path + '.members: every entry must be a non-empty string')
    if errors:
        return (False, errors)
    return (True, input_value)


def _structure_layer_of(layers, node_id):
    for index, layer in enumerate(layers):
        if _matches_any(layer['members'], node_id) is not None:
            return index
    return None


def shortest_cycle(nodes, edges):
    """Shortest directed cycle as a node path with the start repeated (mirror of shortestCycle)."""
    adjacency = {}
    for node in nodes:
        adjacency[node] = []
    for edge in edges:
        if edge['from'] == edge['to']:
            return [edge['from'], edge['from']]
        listing = adjacency.get(edge['from'])
        if listing is not None and edge['to'] not in listing:
            listing.append(edge['to'])
    best = None
    for start in nodes:
        previous = {}
        queue = deque([start])
        seen = set([start])
        found = False
        while queue and not found:
            current = queue.popleft()
            for nxt in adjacency.get(current, []):
                if nxt == start:
                    chain = []
                    cursor = current
                    while cursor != start:
                        chain.append(cursor)
                        cursor = previous[cursor]
                    chain.reverse()
                    path = [start] + chain + [start]
                    if best is None or len(path) < len(best):
                        best = path
                    found = True
                    break
                if nxt in seen:
                    continue
                seen.add(nxt)
                previous[nxt] = current
                queue.append(nxt)
    return best


def review_structure(options):
    """Mirror of reviewStructure: audit a structure diagram against an optional matrix."""
    graph = parse_structure(options['diagram'], options.get('notation') or 'auto')
    warnings = list(graph['warnings'])
    findings = []
    nodes = graph['nodes']
    node_ids = [node['id'] for node in nodes]

    if not nodes:
        findings.append({
            'code': 'UML026_NO_NODES',
            'severity': 'error',
            'message': 'no node was declared in this text, so there is no structure to review.',
            'evidence': {'notation': graph['notation']},
        })

    dangling = [node for node in nodes if not node['declared']]
    if dangling:
        findings.append({
            'code': 'UML021_DANGLING_REFERENCE',
            'severity': 'error',
            'message': str(len(dangling)) + ' arrow endpoint(s) are used without ever being declared: ' + ', '.join(node['id'] for node in dangling) + '. In a component diagram this is how a dependency on a component that does not exist stays invisible.',
            'evidence': {'nodes': [{'id': node['id'], 'line': node.get('line')} for node in dangling]},
        })

    degree = dict((node_id, 0) for node_id in node_ids)
    for edge in graph['edges']:
        degree[edge['from']] = degree.get(edge['from'], 0) + 1
        degree[edge['to']] = degree.get(edge['to'], 0) + 1
    isolated = [node for node in nodes if not node['container'] and node['declared'] and degree.get(node['id'], 0) == 0]
    if isolated:
        findings.append({
            'code': 'UML020_ISOLATED_NODE',
            'severity': 'warning',
            'message': str(len(isolated)) + ' node(s) have no edge at all: ' + ', '.join(node['id'] for node in isolated) + '. Either they are dead entries or the diagram is missing their dependencies.',
            'evidence': {'nodes': [{'id': node['id'], 'line': node.get('line')} for node in isolated]},
        })

    cycle = shortest_cycle(node_ids, graph['edges'])
    if cycle is not None:
        findings.append({
            'code': 'UML022_CYCLE',
            'severity': 'error',
            'message': 'the dependency graph has a directed cycle: ' + ' → '.join(cycle) + '. A cycle means no build order and no layering can hold.',
            'path': [{'from': cycle[index], 'event': 'depends-on', 'to': cycle[index + 1]} for index in range(len(cycle) - 1)],
            'evidence': {'cycle': cycle},
        })

    edge_verdicts = []
    rules = []
    layers = []
    matrix_default = 'allow'
    if options.get('matrix') is not None:
        ok_matrix, matrix_or_errors = validate_matrix(options['matrix'])
        if not ok_matrix:
            findings.extend({'code': 'MATRIX_INVALID', 'severity': 'error', 'message': message} for message in matrix_or_errors)
        else:
            rules = matrix_or_errors.get('rules') or []
            layers = matrix_or_errors.get('layers') or []
            matrix_default = matrix_or_errors.get('default') or 'allow'

    for edge in graph['edges']:
        matched_rules = []
        denied_by = None
        allowed_by = None
        for rule in rules:
            if rule.get('source') is None:
                continue
            if _matches_any([rule['source']], edge['from']) is None:
                continue
            matched_rules.append(rule['id'])
            if denied_by is None and _matches_any(rule.get('deny'), edge['to']) is not None:
                denied_by = rule
            if allowed_by is None and _matches_any(rule.get('allow'), edge['to']) is not None:
                allowed_by = rule
        # Deny wins globally: a later rule's allow must not resurrect a forbidden edge.
        if denied_by is not None:
            allowed = False
            basis = 'deny'
        elif allowed_by is not None:
            allowed = True
            basis = 'allow'
        elif matrix_default == 'deny':
            allowed = False
            basis = 'unlisted'
        else:
            allowed = True
            basis = 'default'
        edge_verdicts.append({'from': edge['from'], 'to': edge['to'], 'line': edge['line'],
                              'matchedRules': matched_rules, 'allowed': allowed, 'basis': basis})
        if not allowed:
            rule = denied_by
            if rule is None:
                message = 'edge ' + edge['from'] + ' → ' + edge['to'] + ' is not permitted: no rule allows it and the matrix default is deny.'
            else:
                message = ('edge ' + edge['from'] + ' → ' + edge['to'] + ' violates rule ' + rule['id']
                           + ('' if rule.get('deny') is None else ' (deny ' + ', '.join(rule['deny']) + ')') + '.')
            evidence = {'edge': {'from': edge['from'], 'to': edge['to'], 'line': edge['line']},
                        'matchedRules': matched_rules, 'basis': basis}
            if rule is not None:
                evidence['rule'] = rule['id']
            findings.append({
                'code': 'UML023_DISALLOWED_EDGE',
                'severity': 'error',
                'message': message,
                'evidence': evidence,
            })

    layer_violations = []
    if layers:
        for edge in graph['edges']:
            from_layer = _structure_layer_of(layers, edge['from'])
            to_layer = _structure_layer_of(layers, edge['to'])
            if from_layer is None or to_layer is None:
                continue
            if from_layer > to_layer:
                layer_violations.append({'from': edge['from'], 'to': edge['to'],
                                         'fromLayer': layers[from_layer]['name'], 'toLayer': layers[to_layer]['name'],
                                         'line': edge['line']})
        if layer_violations:
            findings.append({
                'code': 'UML024_LAYER_VIOLATION',
                'severity': 'error',
                'message': str(len(layer_violations)) + ' edge(s) point from a lower layer into a higher one: '
                           + '; '.join(entry['from'] + ' (' + entry['fromLayer'] + ') → ' + entry['to'] + ' (' + entry['toLayer'] + ')' for entry in layer_violations)
                           + '. Declared layers allow downward dependencies only.',
                'evidence': {'violations': layer_violations},
            })

    missing = []
    for rule in rules:
        if rule.get('require') is not True or rule.get('source') is None or rule.get('allow') is None:
            continue
        sources = [node_id for node_id in node_ids if _matches_any([rule['source']], node_id) is not None]
        if not sources:
            missing.append({'rule': rule['id'], 'source': rule['source'], 'expected': rule['allow'],
                            'unsatisfiedFrom': [], 'noSourceMatch': True})
            continue
        unsatisfied = [source for source in sources
                       if not any(edge['from'] == source and _matches_any(rule['allow'], edge['to']) is not None
                                  for edge in graph['edges'])]
        if unsatisfied:
            missing.append({'rule': rule['id'], 'source': rule['source'], 'expected': rule['allow'],
                            'unsatisfiedFrom': unsatisfied, 'noSourceMatch': False})
    if missing:
        parts = []
        for entry in missing:
            if entry['noSourceMatch']:
                parts.append(entry['rule'] + ' requires an edge from ' + entry['source'] + ' to ' + ', '.join(entry['expected'])
                             + ', but no node matches ' + entry['source'])
            else:
                parts.append(entry['rule'] + ' requires an edge from ' + ', '.join(entry['unsatisfiedFrom']) + ' to '
                             + ', '.join(entry['expected']) + ', and the diagram draws none')
        findings.append({
            'code': 'UML025_MISSING_EXPECTED_EDGE',
            'severity': 'warning',
            'message': str(len(missing)) + ' required edge(s) are absent from the diagram: ' + '; '.join(parts) + '. The matrix and the diagram disagree.',
            'evidence': {'missing': missing},
        })

    errors = len([finding for finding in findings if finding['severity'] == 'error'])
    warning_count = len([finding for finding in findings if finding['severity'] == 'warning'])
    summary = {
        'nodes': len(nodes),
        'edges': len(graph['edges']),
        'containers': len([node for node in nodes if node['container']]),
        'isolated': len(isolated),
        'dangling': len(dangling),
        'cycles': 0 if cycle is None else 1,
        'disallowedEdges': len([verdict for verdict in edge_verdicts if not verdict['allowed']]),
        'layerViolations': len(layer_violations),
        'missingExpectedEdges': len(missing),
        'errors': errors,
        'warnings': warning_count,
        'rules': len(rules),
    }

    next_steps = []
    if errors > 0:
        next_steps.append('Resolve the error findings first: a dangling endpoint or a layer violation means the diagram and the intended architecture disagree.')
    if not rules:
        next_steps.append('Supply a dependency matrix (rules/layers) to have every edge judged and named; without one only the structural checks run.')
    next_steps.append('Reconcile the result with the source-side checker: this audits the diagram, an include/graph scan audits the code, and the difference between them is the finding worth chasing.')
    if graph['notation'] == 'plantuml':
        next_steps.append('State machines are a different question — for a state or activity diagram use logicprobe_uml action=review and logicprobe_verify.')

    report = {
        'ok': True,
        'ran': True,
        **verdict_of_findings(findings),
        'schema': REPORT_SCHEMAS['structure'],
        'notation': graph['notation'],
        'graph': graph,
    }
    if options.get('matrix') is not None:
        report['edgeVerdicts'] = edge_verdicts
    report['findings'] = findings
    report['summary'] = summary
    report['hashes'] = {'diagram': hashlib.sha256(options['diagram'].encode('utf-8')).hexdigest(),
                        **({} if options.get('matrix') is None else {'matrix': hashlib.sha256(stable_stringify(options['matrix']).encode('utf-8')).hexdigest()})}
    report['warnings'] = warnings
    report['nextSteps'] = next_steps
    return report


# ---------------------------------------------------------------------------
# Multi-granularity structure review (mirror of src/granularity.ts)
#
# One architecture at several levels of detail: a child diagram must be a refinement of
# its declared parent. A level that invents a parent-level dependency, or drops one
# without expanding it into a path, breaks the hierarchy as a rule source.
# ---------------------------------------------------------------------------

def _granularity_reaches(graph, frm, to):
    adjacency = {}
    for node in graph['nodes']:
        adjacency[node['id']] = []
    for edge in graph['edges']:
        adjacency.get(edge['from'], []).append(edge['to'])
    seen = set([frm])
    queue = deque([frm])
    while queue:
        current = queue.popleft()
        for nxt in adjacency.get(current, []):
            if nxt == to:
                return True
            if nxt in seen:
                continue
            seen.add(nxt)
            queue.append(nxt)
    return False


def _granularity_parent_cycle(diagrams):
    by_name = dict((entry['name'], entry) for entry in diagrams)
    for start in diagrams:
        path = [start['name']]
        seen = set([start['name']])
        cursor = start.get('parent')
        while cursor is not None:
            if cursor in seen:
                path.append(cursor)
                return path
            seen.add(cursor)
            path.append(cursor)
            cursor = by_name.get(cursor, {}).get('parent')
    return None


def review_granularity(options):
    """Review a set of structure diagrams with declared parent relations."""
    diagrams = options['diagrams']
    findings = []
    warnings = []
    diagram_summaries = []
    graphs = {}

    if not diagrams:
        findings.append({'code': 'UML031_NO_DIAGRAMS', 'severity': 'error',
                         'message': 'no diagram was supplied, so there are no granularity levels to compare.'})

    cycle = _granularity_parent_cycle(diagrams)
    if cycle is not None:
        findings.append({
            'code': 'UML030_PARENT_CYCLE',
            'severity': 'error',
            'message': 'the declared parent relation has a cycle: ' + ' → '.join(cycle) + '. A refinement hierarchy must be a forest, or "which level owns this dependency" has no answer.',
            'evidence': {'cycle': cycle},
        })

    known_names = set(entry['name'] for entry in diagrams)
    for entry in diagrams:
        parent = entry.get('parent')
        if parent is not None and parent not in known_names:
            findings.append({
                'code': 'UML028_UNKNOWN_PARENT',
                'severity': 'error',
                'message': 'diagram "' + entry['name'] + '" declares parent "' + parent + '", which is not part of this set.',
                'file': entry['name'],
                'evidence': {'diagram': entry['name'], 'parent': parent, 'known': sorted(known_names)},
            })
        report = review_structure({'diagram': entry['diagram'],
                                   'notation': options.get('notation') or 'auto',
                                   **({} if options.get('matrix') is None else {'matrix': options['matrix']})})
        graphs[entry['name']] = report['graph']
        # Tag every finding with the diagram it came from: with several diagrams in one
        # report, an untagged finding is unactionable.
        for finding in report['findings']:
            findings.append({**finding, 'file': entry['name']})
        warnings.extend(entry['name'] + ': ' + warning for warning in report['warnings'])
        summary = {'name': entry['name'], 'notation': report['notation'], 'nodes': report['summary']['nodes'],
                   'edges': report['summary']['edges'], 'verdict': report['verdict'],
                   'findings': len(report['findings'])}
        if parent is not None:
            summary['parent'] = parent
        diagram_summaries.append(summary)

    pairs = []
    for child in diagrams:
        parent_name = child.get('parent')
        if parent_name is None:
            continue
        parent_graph = graphs.get(parent_name)
        child_graph = graphs.get(child['name'])
        if parent_graph is None or child_graph is None:
            continue
        parent_nodes = set(node['id'] for node in parent_graph['nodes'])
        child_nodes = set(node['id'] for node in child_graph['nodes'])
        parent_edges = set(edge['from'] + '\u0000' + edge['to'] for edge in parent_graph['edges'])
        child_edges = set(edge['from'] + '\u0000' + edge['to'] for edge in child_graph['edges'])

        inherited_edges = 0
        new_edges = 0
        invented_edges = []
        for edge in child_graph['edges']:
            has_from = edge['from'] in parent_nodes
            has_to = edge['to'] in parent_nodes
            if not has_from or not has_to:
                new_edges += 1
                continue
            if edge['from'] + '\u0000' + edge['to'] in parent_edges:
                inherited_edges += 1
                continue
            invented_edges.append({'from': edge['from'], 'to': edge['to'], 'line': edge['line']})

        expanded_edges = []
        missing_edges = []
        for edge in parent_graph['edges']:
            if edge['from'] + '\u0000' + edge['to'] in child_edges:
                continue
            # The child only has to answer for a parent edge whose ends it also carries.
            if edge['from'] not in child_nodes or edge['to'] not in child_nodes:
                continue
            entry = {'from': edge['from'], 'to': edge['to'], 'line': edge['line']}
            if _granularity_reaches(child_graph, edge['from'], edge['to']):
                expanded_edges.append(entry)
            else:
                missing_edges.append(entry)

        if invented_edges:
            findings.append({
                'code': 'UML029_REFINEMENT_VIOLATION',
                'severity': 'error',
                'message': 'diagram "' + child['name'] + '" draws ' + str(len(invented_edges)) + ' dependency(ies) between nodes its parent "' + parent_name + '" also has, but the parent does not: '
                           + ', '.join(edge['from'] + ' → ' + edge['to'] for edge in invented_edges)
                           + '. A refinement may add detail below the parent level, never a dependency at the parent level.',
                'file': child['name'],
                'evidence': {'kind': 'invented-edge', 'parent': parent_name, 'edges': invented_edges},
            })
        if missing_edges:
            findings.append({
                'code': 'UML029_REFINEMENT_VIOLATION',
                'severity': 'error',
                'message': 'diagram "' + child['name'] + '" drops ' + str(len(missing_edges)) + ' dependency(ies) its parent "' + parent_name + '" draws, without expanding them into a path: '
                           + ', '.join(edge['from'] + ' → ' + edge['to'] for edge in missing_edges) + '.',
                'file': child['name'],
                'evidence': {'kind': 'unexpanded-edge', 'parent': parent_name, 'edges': missing_edges},
            })
        pairs.append({
            'parent': parent_name,
            'child': child['name'],
            'parentNodes': len(parent_nodes),
            'childNodes': len(child_nodes),
            'parentEdges': len(parent_graph['edges']),
            'childEdges': len(child_graph['edges']),
            'inheritedEdges': inherited_edges,
            'newEdges': new_edges,
            'expandedEdges': expanded_edges,
            'missingEdges': missing_edges,
            'inventedEdges': invented_edges,
        })

    errors = len([finding for finding in findings if finding['severity'] == 'error'])
    warning_count = len([finding for finding in findings if finding['severity'] == 'warning'])
    invented = sum(len(pair['inventedEdges']) for pair in pairs)
    missing = sum(len(pair['missingEdges']) for pair in pairs)
    expanded = sum(len(pair['expandedEdges']) for pair in pairs)

    next_steps = []
    if errors > 0:
        next_steps.append('Fix the refinement violations first: a level that invents or drops a parent-level dependency makes the hierarchy unusable as a rule source.')
    if not pairs and diagrams:
        next_steps.append('Give the levels a `parent` so the refinement can be checked; a set of unrelated diagrams has no consistency property to verify.')
    if expanded > 0:
        next_steps.append(str(expanded) + ' parent edge(s) are drawn as a path in the child — that is a legitimate expansion, and it is listed per pair so a reviewer can confirm each one.')
    next_steps.append('Reconcile the levels with the source-side scan: the diagram pair is consistent or not, and neither says anything about the code until it is scanned.')

    return {
        'ok': True,
        'ran': True,
        **verdict_of_findings(findings),
        'schema': REPORT_SCHEMAS['granularity'],
        'diagrams': diagram_summaries,
        'pairs': pairs,
        'findings': findings,
        'summary': {
            'diagrams': len(diagrams),
            'roots': len([entry for entry in diagrams if entry.get('parent') is None]),
            'pairs': len(pairs),
            'nodes': sum(len(graphs.get(entry['name'], {'nodes': []})['nodes']) for entry in diagrams),
            'edges': sum(len(graphs.get(entry['name'], {'edges': []})['edges']) for entry in diagrams),
            'inventedEdges': invented,
            'missingEdges': missing,
            'expandedEdges': expanded,
            'errors': errors,
            'warnings': warning_count,
        },
        'hashes': {'diagrams': [{'name': entry['name'], 'hash': hashlib.sha256(entry['diagram'].encode('utf-8')).hexdigest()}
                                for entry in diagrams]},
        'warnings': warnings,
        'nextSteps': next_steps,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _load_json_file(file_path):
    with open(file_path, 'r', encoding='utf-8') as handle:
        return json.load(handle)


def _refusal_json(exc):
    return {'ok': False, 'ran': False, **refusal_verdict(str(exc)),
            'errorCode': getattr(exc, 'code', 'UML_INPUT'), 'error': str(exc)}


def _hash_check(model, target):
    """Answer "which published hash spec reproduces this archived hash?" (never guesses)."""
    published = [{'hashSpec': spec, 'modelHash': model_hash(model, spec)} for spec in PUBLISHED_HASH_SPECS]
    matches = [entry['hashSpec'] for entry in published if entry['modelHash'] == target]
    return {
        'ran': True,
        'verdict': 'pass' if matches else 'fail',
        'verdictReason': ('hash reproduced by spec(s) ' + ', '.join(matches)) if matches
                         else ('no published hash spec reproduces ' + target),
        'checked': target,
        'matches': matches,
        'hashSpec': DEFAULT_HASH_SPEC,
        'modelHash': model_hash(model),
        'published': published,
    }


def _emit_report(report, baseline_path=None):
    """Print a report (or its diff against a baseline) and exit on the verdict."""
    if baseline_path:
        report = diff_reports(_load_json_file(baseline_path), report)
    print(json.dumps(report, indent=2))
    # The exit code follows the verdict, not `ok`: a report that ran and failed is a failure.
    sys.exit(0 if report['verdict'] != 'fail' else 2)


def _cmd_verify(args):
    model = _load_json_file(args.model)
    if args.hash_check:
        report = _hash_check(model, args.hash_check)
        print(json.dumps(report, indent=2))
        sys.exit(0 if report['matches'] else 2)
    options = {'hashSpec': args.hash_spec}
    if args.max_states:
        options['maxStates'] = args.max_states
    if args.max_permutation_events:
        options['maxPermutationEvents'] = args.max_permutation_events
    if args.before_model:
        options['beforeModel'] = _load_json_file(args.before_model)
    if args.state_mapping:
        options['stateMapping'] = _load_json_file(args.state_mapping)
    report = run_verification(model, options)
    _emit_report(report, args.baseline)


def _cmd_compose(args):
    machines = [_load_json_file(m) for m in args.machines]
    options = {'hashSpec': args.hash_spec}
    if args.rendezvous:
        options['rendezvous'] = [e for e in args.rendezvous.split(',') if e]
    if args.max_states:
        options['maxStates'] = args.max_states
    report = run_composition_verification(machines, options)
    _emit_report(report, args.baseline)


def _cmd_export(args):
    model = _load_json_file(args.model)
    try:
        result = export_model(model, args.format)
    except ValueError as exc:
        print(json.dumps(_refusal_json(exc)))
        sys.exit(2)
    out = {'format': result['format'], 'primary': result['primary'],
           'extras': result['extras'], 'warnings': result['warnings']}
    print(json.dumps(out, indent=2))


def _cmd_uml_render(args):
    try:
        model = _load_json_file(args.model)
        result = render_uml(model, args.notation, args.diagram, args.max_steps)
    except (OSError, ValueError) as exc:
        print(json.dumps(_refusal_json(exc)))
        sys.exit(2)
    out = {'notation': result['notation'], 'diagram': result['diagram'],
           'primary': result['primary'], 'warnings': result['warnings']}
    print(json.dumps(out, indent=2))


def _cmd_uml_parse(args):
    try:
        # newline='' keeps the bytes as they are on disk: the diagram hash must not depend on the checkout's line endings.
        with open(args.diagram, 'r', encoding='utf-8', newline='') as handle:
            text = handle.read()
        result = parse_uml(text, args.notation)
    except (OSError, ValueError) as exc:
        print(json.dumps(_refusal_json(exc)))
        sys.exit(2)
    out = {'notation': result['notation'], 'diagram': result['diagram'], 'model': result['model'],
           'labels': result['labels'], 'discardedConstructs': result['discardedConstructs'],
           'discardedEdges': result['discardedEdges'], 'warnings': result['warnings']}
    print(json.dumps(out, indent=2))
    # A diagram from another family parses into something; that is an error, not a success.
    sys.exit(2 if any(finding['severity'] == 'error' for finding in parse_findings(result)) else 0)


def _cmd_structure(args):
    try:
        # newline='' keeps the bytes as they are on disk: the diagram hash must not depend on the checkout's line endings.
        with open(args.diagram, 'r', encoding='utf-8', newline='') as handle:
            text = handle.read()
        options = {'diagram': text}
        if args.notation is not None and args.notation != 'auto':
            options['notation'] = args.notation
        if args.matrix:
            options['matrix'] = _load_json_file(args.matrix)
        report = review_structure(options)
    except (OSError, ValueError) as exc:
        print(json.dumps(_refusal_json(exc)))
        sys.exit(2)
    _emit_report(report, args.baseline)


def _cmd_granularity(args):
    try:
        manifest = _load_json_file(args.manifest)
        diagrams = []
        for entry in manifest.get('diagrams') or []:
            diagram = {'name': entry['name'], 'diagram': entry.get('diagram')}
            if entry.get('file'):
                # newline='' keeps the bytes as they are on disk: the diagram hash must not depend on the checkout's line endings.
                with open(entry['file'], 'r', encoding='utf-8', newline='') as handle:
                    diagram['diagram'] = handle.read()
            if entry.get('parent') is not None:
                diagram['parent'] = entry['parent']
            diagrams.append(diagram)
        options = {'diagrams': diagrams}
        if args.notation is not None and args.notation != 'auto':
            options['notation'] = args.notation
        if args.matrix:
            options['matrix'] = _load_json_file(args.matrix)
        report = review_granularity(options)
    except (OSError, KeyError, ValueError) as exc:
        print(json.dumps(_refusal_json(exc)))
        sys.exit(2)
    _emit_report(report, args.baseline)


def explain_labels(notation='mermaid'):
    """What the front end expects of labels and comments (mirror of explainLabels)."""
    prefix = _comment_prefix(notation)
    return {
        'notation': notation,
        'directivePrefix': prefix + _DIRECTIVE_NAMESPACE,
        'directiveLines': [
            {'example': prefix + _DIRECTIVE_NAMESPACE + 'uml v1 notation=' + notation + ' diagram=state',
             'meaning': 'declares the notation and diagram kind the file was rendered for'},
            {'example': prefix + _DIRECTIVE_NAMESPACE + 'init ID',
             'meaning': 'pins the initial state (otherwise it is inferred as the only state nothing enters)'},
            {'example': prefix + _DIRECTIVE_NAMESPACE + 'terminal ID',
             'meaning': 'marks a terminal state; comma-separate several'},
            {'example': prefix + _DIRECTIVE_NAMESPACE + 'alias NOTATION_ID model_id',
             'meaning': 'restores a state id the notation cannot spell verbatim'},
            {'example': prefix + _DIRECTIVE_NAMESPACE + 'variable NAME integer',
             'meaning': 'restores a variable and its kind'},
        ],
        'acceptedLabelForms': [
            {'form': 'bare id', 'example': 'state "IDLE" as IDLE',
             'note': 'counts as NO meaning: the state stays undocumented (UML014)'},
            {'form': 'ID（meaning）', 'example': 'state "IDLE（waiting for power）" as IDLE',
             'note': 'the form the renderer writes; full-width parentheses'},
            {'form': 'ID(meaning)', 'example': 'state "IDLE(waiting for power)" as IDLE', 'note': 'accepted as well'},
            {'form': 'a description line', 'example': 'IDLE : waiting for power',
             'note': 'the same meaning written as a state description'},
            {'form': 'a single-line note', 'example': 'note right of IDLE : waiting for power',
             'note': 'read as the state meaning, not as a comment'},
            {'form': 'any other text', 'example': 'state "waiting for power" as IDLE',
             'note': 'taken as the meaning verbatim'},
        ],
        'renderedForm': 'state "ID（meaning）" as ID',
        'ignoredLines': [
            {'pattern': 'a `' + prefix + '` comment line that is not a `logicprobe:` directive',
             'behaviour': 'UML_PARSE_IGNORED_LINE warning: it carries no state-machine statement'},
            {'pattern': 'a `note …` block written over several lines',
             'behaviour': 'skipped silently (a block is not a state meaning)'},
            {'pattern': 'notation chrome: @startuml/@enduml, stateDiagram-v2, direction, classDef/style/linkStyle/click, scale, skinparam, title, hide, autonumber',
             'behaviour': 'skipped silently'},
            {'pattern': 'anything else the parser cannot read',
             'behaviour': 'UML_PARSE_IGNORED_LINE warning, and the model is built from what it did read'},
        ],
        'rules': [
            'Label drift (UML015) compares the meaning inside the label with narrative.states[id]: the wrapper is stripped, the remaining text must match character for character.',
            'A meaning that differs only in wording is still drift — one of the two is stale, and the review cannot tell which.',
            'Keep non-directive comments out of the diagram: `logicprobe:` directives are the only comment lines the parser consumes.',
            'A missing label is not an error: the state renders as its bare id and is reported as undocumented (UML014).',
        ],
    }


def _cmd_uml_review(args):
    if args.explain_labels:
        print(json.dumps(explain_labels(args.notation if args.notation != 'auto' else 'mermaid'), indent=2))
        sys.exit(0)
    try:
        options = {}
        if args.model:
            options['model'] = _load_json_file(args.model)
        if args.diagram:
            # newline='' keeps the bytes as they are on disk: the diagram hash must not depend on the checkout's line endings.
            with open(args.diagram, 'r', encoding='utf-8', newline='') as handle:
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
        print(json.dumps(_refusal_json(exc)))
        sys.exit(2)
    _emit_report(report, args.baseline)


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
    p_verify.add_argument('--hash-spec', choices=list(PUBLISHED_HASH_SPECS), default=DEFAULT_HASH_SPEC,
                          help='model-hash specification to report (default v1; v0 = pre-1.0.0 behaviour)')
    p_verify.add_argument('--baseline', metavar='REPORT',
                          help='compare against an earlier report of the same family and print the diff (a new error finding fails it)')
    p_verify.add_argument('--hash-check', metavar='HEX',
                          help='report which published hash spec reproduces this archived hash, then exit')
    p_verify.set_defaults(func=_cmd_verify)
    p_compose = sub.add_parser('compose', help='compose two or more machines (C1/C2)')
    p_compose.add_argument('machines', nargs='+')
    p_compose.add_argument('--rendezvous', help='comma-separated handshake events')
    p_compose.add_argument('--max-states', type=int)
    p_compose.add_argument('--hash-spec', choices=list(PUBLISHED_HASH_SPECS), default=DEFAULT_HASH_SPEC)
    p_compose.add_argument('--baseline', metavar='REPORT', help='compare against an earlier report and print the diff')
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
    p_uml_review.add_argument('--baseline', metavar='REPORT', help='compare against an earlier report and print the diff')
    p_uml_review.add_argument('--explain-labels', action='store_true',
                              help='print the label/comment conventions the parser expects, then exit')
    p_uml_review.set_defaults(func=_cmd_uml_review)
    p_structure = sub.add_parser('structure', help='audit a structure/dependency diagram (UML020-UML026)')
    p_structure.add_argument('diagram')
    p_structure.add_argument('--notation', choices=['auto', 'plantuml', 'mermaid'], default='auto')
    p_structure.add_argument('--matrix', help='dependency matrix JSON: {rules, layers, default}')
    p_structure.add_argument('--baseline', metavar='REPORT', help='compare against an earlier report and print the diff')
    p_structure.set_defaults(func=_cmd_structure)
    p_granularity = sub.add_parser('granularity', help='review several structure diagrams with declared parents (UML028-UML031)')
    p_granularity.add_argument('manifest', help='JSON: {diagrams: [{name, file|diagram, parent?}]}')
    p_granularity.add_argument('--notation', choices=['auto', 'plantuml', 'mermaid'], default='auto')
    p_granularity.add_argument('--matrix', help='dependency matrix applied to every level')
    p_granularity.add_argument('--baseline', metavar='REPORT', help='compare against an earlier report and print the diff')
    p_granularity.set_defaults(func=_cmd_granularity)
    return parser


def main(argv=None):
    parser = _build_parser()
    args = parser.parse_args(argv)
    args.func(args)


if __name__ == '__main__':
    main()
