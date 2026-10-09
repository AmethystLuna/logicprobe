# Model Hash Specification

`modelHash` is how a report, an archive record and a CI comparison agree on *which*
model was verified. A hash nobody can recompute is decoration, so the algorithm, the
normalization rules and the excluded keys are published here — and pinned by golden
tests (`tests/engine/run.mjs`, and the parity test).

## Published specifications

| Spec | Since | Normalization |
|------|-------|---------------|
| `v1` | 1.0.0 | sorted keys, no insignificant whitespace, UTF-8 with non-ASCII preserved, **every `_`-prefixed key removed at every level** |
| `v0` | never published | the same normalization **without** metadata filtering — the pre-1.0 behaviour, kept only so an archived hash can be checked against the old engine |

`v0` was never a specification; it is the behaviour that existed before this document
did. Do not record new hashes with it.

For a model that carries no `_`-prefixed key, `v0` and `v1` produce the *identical*
hash. That is why adopting `v1` does not invalidate any hash recorded before it.

## The algorithm (`v1`)

1. Take the model as JSON.
2. Remove every key whose name starts with `_`, at every level — including objects
   nested inside arrays.
3. Serialize deterministically:
   - object keys sorted by code-unit order,
   - tokens separated by `,` and `:` with no whitespace,
   - strings escaped as JSON, non-ASCII preserved (`réussi` stays `réussi`, not `r\u00e9ussi`),
   - numbers written the way JavaScript `JSON.stringify` writes them,
   - `null`, `true`, `false` spelled as JSON.
4. `sha256` of the UTF-8 bytes, lower-case hex.

In other words, with `strip_metadata` removing `_`-prefixed keys at every level:

```text
sha256(json.dumps(strip_metadata(model), sort_keys=True, separators=(',', ':'), ensure_ascii=False))
```

The TypeScript engine does not call `json.dumps`; it implements the same serialization
directly (`stableStringify`), and the parity test compares the two engines
byte-for-byte on every fixture. The specification, not either implementation, is the
contract.

Nothing else is normalized: no key renaming, no default filling, no unit conversion,
no ordering of `states` or `transitions` arrays. Two models that differ only in array
order hash differently — that is intended, because the order is part of the input.

## Recomputing a hash

Both commands below reproduce the engine's value exactly.

```bash
# Node
node -e "const m=JSON.parse(require('fs').readFileSync('model.json','utf8'));const s=(v)=>Array.isArray(v)?v.map(s):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter((k)=>!k.startsWith('_')).map((k)=>[k,s(v[k])])):v;console.log(require('crypto').createHash('sha256').update(JSON.stringify(s(m))).digest('hex'))"

# Node.js
node -e "const c=require('node:crypto'),f=require('node:fs');const s=v=>Array.isArray(v)?'['+v.map(s).join(',')+']':(v&&typeof v==='object'?'{'+Object.keys(v).filter(k=>!k.startsWith('_')).sort().map(k=>JSON.stringify(k)+':'+s(v[k])).join(',')+'}':JSON.stringify(v));console.log(c.createHash('sha256').update(s(JSON.parse(f.readFileSync('model.json','utf8')))).digest('hex'))"
```

The reports carry the specification next to the value, e.g. `"hashSpec": "v1"`, so an
archive record does not need to guess:

```json
{ "hashSpec": "v1", "modelHash": "f583202888b827922ac512a312758fa2d8cf9055b102205ecad18f81a0a7d539" }
```

Round-trip reports (`logicprobe_uml action=review`, `roundTrip`) carry `hashSpec`
alongside `modelHash` and `parsedHash`, so a fidelity comparison is always
spec-qualified.

Every report also aggregates its hashes under `hashes`, so a baseline diff or an archive
record reads one field instead of walking the report:

```json
{ "hashes": { "hashSpec": "v1", "modelHash": "f5832028…", "afterModelHash": "f5832028…" } }
```

A structure review hashes its inputs under the same rule but with its own keys:
`hashes.diagram` (sha256 of the diagram text) and `hashes.matrix` (sha256 of the
canonical — key-sorted — matrix JSON, so key order does not change the hash) when a
dependency matrix was supplied. A data-model report carries `hashes.modelHash`; the
data-model hash uses the same normalization but its schema is not covered by the
published specification.

## Checking an archived hash

`--hash-spec` recomputes under a named specification; `--hash-check` answers whether a
recorded value belongs to any published specification *at all*:

```bash
# verify under a named spec
The repository CLI takes the same flag: `verify model.json --hash-spec v0`

# ask about a recorded hash: prints {checked, matches, published[], verdict, verdictReason}
The repository CLI reports which spec reproduces an archived hash: `verify model.json --hash-check 0000…deadbeef`
```

`--hash-check` exits `0` when a published spec reproduces the value and `2` when none
does, with the explicit answer `no published hash spec reproduces <hex>`. It never
guesses a spec to make a number match.

The in-process equivalents are `modelHash(model, spec)` (TypeScript,
`lib/engine.js`) and `model_hash(model, spec)` in the mirror, plus `hashPayload(model, spec)`
and `hash_payload(model, spec)` for the exact bytes that are hashed.

## When the hash changes

A change that alters the bytes alters the hash, and that is a compatibility event:

- Adding, removing or renaming an *excluded* key (`_`-prefixed): no hash change by
  construction.
- Adding a declared model field that a model actually uses: that model's hash changes.
  The change must be named in the release note, and it is covered by the golden tests
  rather than discovered by a user comparing snapshots.
- Changing any normalization rule (separator, escaping, key order, exclusion set): a
  **new** specification, never a silent change to `v1`. The old spec keeps its name and
  its behaviour so archived hashes stay checkable.

`--hash-spec` changes the reported `modelHash` only. The `beforeModelHash` /
`afterModelHash` pair inside a `comparison` block is a diagnostic of one run and always
uses `v1`.

### Version history

| Release | Hash change | Affected models |
|---------|-------------|-----------------|
| 1.0.0 | `hashSpec: "v1"` published; `_`-prefixed keys are now excluded from the hash (and accepted by the schema) | **None.** Before 1.0.0 a model carrying `_` keys was rejected outright, so no accepted model's hash moves. `v0` reproduces the old behaviour for archived values, and the two specs are byte-identical for a model without `_` keys — pinned by golden tests on `happy-path.json` and `narrative-complete.json`. |
