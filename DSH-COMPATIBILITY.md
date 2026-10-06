# DSH Compatibility Evidence — Logic Probe

Evidence for the DSH STORE fixed-Commit contract: per-release install / start /
uninstall verification of this plugin's native dsh bundle against the DSH
releases listed in `dsh.compatibility.dshReleases` (author-remediation track
[AI-Scarlett/DSH-Store#252](https://github.com/AI-Scarlett/DSH-Store/issues/252)).

## Environment

| Item | Value |
|---|---|
| Host | Windows 11 (x64), build 19045 |
| Node.js | v24.17.0 |
| npm | 11.13.0 |
| pnpm | 11.21.0 |
| Test date | 2026-09-25 (headless rounds) · 2026-09-29 (live-field and degradation rounds) · 2026-10-05 (headless round for 0.2.1-alpha.1) · 2026-10-06 (headless round for 0.9.0 on 0.1.7-rc.2) |
| Package under test | `dsh-logicprobe` 0.9.0 (bundle patch `cordis.patch.yml`, entry id `logicprobe`) |

## Method (one disposable profile per version)

Each DSH release was run from its own runtime (global CLI for
0.1.0-rc.7 … 0.1.2-alpha.3; temporary npm install under an isolated prefix for
0.1.2-alpha.4 through 0.2.0-rc.2) against a fresh `DSH_HOME`, so no state
leaked between versions. 0.1.3-alpha.1 predates its npm publish, so it ran from
a local pnpm workspace build of git tag `dsh-v0.1.3-alpha.1`; every later row was
installed from its published npm release. The `fs-ext` native dependency
introduced in 0.1.3 (cross-process session write lease) is a POSIX `flock` shim
that the Windows lease path never calls — it takes a kernel semaphore instead —
so the two 0.1.3 rows ran with `fs-ext` substituted by a no-op stub on this
MSVC-less host (`npm install --ignore-scripts`). 0.1.5-alpha.1 replaced `fs-ext`
with the lazily loaded prebuilt `@deepseek-ai/node-addon-system/flock`, so that
row installed exactly as published.

The 2026-10-05 round (`0.2.1-alpha.1`) repeated that procedure from a temporary npm
install prefix:

```bash
npm install --prefix <dir> @deepseek-ai/dsh@0.2.1-alpha.1
```

`registry.npmjs.org` reset the connection twice while that tree was downloading. The
first reset was a stall with no progress for 20 minutes. The second was a hard
`npm error network aborted`. The prefix was therefore installed from
`registry.npmmirror.com`, with `--fetch-retries=8 --fetch-retry-maxtimeout=120000`.
The plugin installs inside it were pointed at the same mirror through
`npm_config_registry`. The packages are the published `0.2.1-alpha.1` tarballs; only
the transport changed.

```bash
# 1) install: fresh profile, plugin added as a file: dependency
dsh plugin --profile headless add "file:<this-repo>"      # pnpm add succeeds

# 2) mount check: composed tree contains the plugin row, enabled
dsh --profile headless --dump-config                       # id: logicprobe / enabled: true

# 3) start: headless boot with a deliberately invalid API key.
#    Expected: tree mounts and the app reaches the model-provider stage,
#    failing only with AUTH for the fake key; no plugin load errors.
DEEPSEEK_API_KEY=fake-key-for-boot-test dsh --profile headless "reply OK"

# 4) uninstall: plugin removed, row gone from the composed tree
dsh plugin --profile headless remove dsh-logicprobe
dsh --profile headless --dump-config                       # no logicprobe row
```

The headless `AUTH` rejection proves the profile booted with the plugin applied
(any bundle apply error would surface before the provider call). End-to-end
model calls were not exercised (no real provider key used).

The live-field round (2026-09-29) used a different procedure, because the
capability it measures lives in the Web client rather than the headless path:
each release was installed with `npm install --prefix <dir>
@deepseek-ai/dsh@<version>`, given a fresh `DSH_HOME`, and booted as
`dsh --from-default-profile web --profile compat` followed by
`dsh --profile compat --port 0 --no-open` on an OS-assigned port (`--port 0`),
never a fixed one. Both plugins were added with `dsh plugin --profile compat add
"file:<this-repo>"`. Evidence was read from three surfaces rather than a
headless boot: the injected `window.__DSH_BOOT__` client graph (are this
package's client bundles supplied?), `POST /api/pluginManager/listPlugins`
(fiber phase of each plugin row), and `POST /api/settings/describe` (is the
namespace served, and does its schema hold exactly one `enabled` boolean?).
Uninstall was re-run for every release in this round, through the same profile:
row present → `dsh plugin --profile compat remove <package>` → row gone from
`--dump-config` → re-add → row restored.

One measurement caveat belongs here: on the newest releases the namespace schema
must be read through the root node, `refs[schema.uid]` — the root's `.dict` maps
`enabled` to a ref id and `schema.dict` itself is undefined — and those ref ids are
regenerated on every call, so a naive `schema.dict` read reports an empty schema.

The degradation round (same day) ran the same procedure against releases whose
schemastery predates `.volatile()`, to measure what the plugin does on a host that
cannot carry a live field: dsh 0.1.5-rc.3 (ships schemastery 3.18.2) was booted
twice on OS-assigned ports and probed with the built artifact, after confirming
the installed copy was SHA256-identical to this repository's `lib/index.js`. One
probe-plan correction belongs here: on 0.1.5-rc.3 `POST
/api/pluginManager/listPlugins` **does not exist** (HTTP 404) — that release
serves the equivalent inventory as `pluginInventory/list`, so the 404 is a probe
mismatch, not a plugin failure. A row counts as loaded on such a release from
`fiberPhase: "active"` on the inventory surface plus a boot log free of plugin
errors.

The degradation branch is executable evidence rather than a claim:
`tests/dsh-volatile-fallback.test.mjs` deletes `.volatile` from the real
schemastery prototype **before** importing the built artifact, so the module is
evaluated exactly as a 3.18.2 host would evaluate it. It asserts that the module
evaluates at all, that the field degrades to an ordinary boolean, that `apply`
reads it, that the gate still injects, and that an off switch suppresses
injection. `tests/dsh-client-half.test.mjs` additionally asserts that a host whose
settings service lacks `whileServed` registers nothing and does not throw. Both
run in CI and in this package's `test:engine`.

Every row re-run in this round also asserts that the install and the boot were
**not** refused by the plugin-compatibility preflight that DSH 0.1.7-rc.1
introduced (see Notes): `dsh plugin add` must not report the named package as
incompatible, `--dump-config` must not contain a `disabling profile plugin`
line, and the boot must not contain `incompatible` or `skipping profile bundle`.
The preflight only exists on 0.1.7-rc.1 and later, so the 0.1.7-rc.1,
0.1.7-rc.2 and 0.2.0-rc.2 rows are the ones that actually exercise it; on the
older rows the same assertions only confirm the refusal wording is absent. The
pre-install check is evaluated from this package's `peerDependencies`, never
from `dsh.compatibility.dshReleases`.

Since 0.6.9 each row is further inspected at the session-log level with a
format-agnostic scanner (`seam-scan.mjs`) that decompresses every zstd frame and
asserts four seams at once: the injected gate landed as a `user/message` carrying
this producer's message source, the `logicprobe:mode` section assembled into the
runtime-context message, all five `logicprobe_*` tools appear in the logged
`request/header` tool list, and the `logicprobe` skill reached the session skill
catalog. All six runtimes re-verified in this round (0.1.5-rc.3, 0.1.6-alpha.2,
0.1.7-alpha.1, 0.1.7-alpha.2, 0.1.7-rc.1, 0.1.7-rc.2 × both plugins) passed 12/12,
recording session format v3 on 0.1.5-rc.3 and 0.1.6-alpha.2 and v4 on the four
0.1.7 releases.

For the 0.1.3-alpha.2 row the boot was additionally inspected at the session-log
level: the persisted v2 log (`session.v2.jsonl.zstd`) records the injected gate
as a `user/message` event with `data.source = {"kind":"plugin",
"plugin":"logicprobe"}`, and the system-prompt snapshot in the same log carries
the plugin's `logicprobe:mode` context section. That proves the `agent/pre-step`
hook ran, its `Session` snapshot read resolved, and the prompt-context
registration still assembles on the new release. The 0.1.5-alpha.1 row repeated
that inspection against the v3 log (`session.v3.jsonl.zstd`, a multi-frame zstd
stream): the gate is recorded the same way, the rendered prompt now lives in a
`system/message` surface node, and the runtime-context `user/message` still
carries the `logicprobe:mode` section. The 0.1.5-alpha.2, 0.1.5-rc.1, 0.1.5-rc.2, 0.1.6-alpha.1 and 0.1.6-alpha.2 rows repeated the same v3 inspection with the same result. The 0.1.7-alpha.1 row inspected the v4 log (`session.v4.jsonl.zstd`): the gate is recorded as a `user/message` whose source is now the producer-owned `{"kind":"plugin:logicprobe"}` (see Notes), and the rendered prompt still arrives as a `system/message` surface node. The 0.1.5-rc.3, 0.1.6-alpha.2 and 0.1.7-alpha.1 regression rows and the 0.1.7-alpha.2, 0.1.7-rc.1 and 0.1.7-rc.2 new rows repeated that inspection with the four-seam assertions described above; on the v3 rows the runtime-context source is still the retired `{kind:'plugin',plugin:'@deepseek-ai/dsh-system-prompt'}` wrapper, so the scanner matches the section name instead of the producer identity.

## Results

The results fall into four groups, kept apart on purpose. The first group is the row
measured for 0.9.0 on dsh 0.1.7-rc.2. The second group is the row re-measured on the
0.8.x builds (0.2.1-alpha.1). The third group is the rows re-measured against the 0.7.1
build on 2026-09-29. The last group is the rows carried over from earlier rounds. A
carried-over row is still declared compatible. It was produced by an earlier round's
procedure, though, and was not re-run against this build, so presenting it as newly
verified would overstate the evidence.

### Re-measured on `0.1.7-rc.2` (`0.9.0` on 2026-10-06)

| dsh release | install | host boot | uninstall | rows active | client bundles in `__DSH_BOOT__` | settings namespace served | Web switch |
|---|---|---:|---:|---|---:|---:|---|
| 0.1.7-rc.2 | pass | pass | pass | not probed (headless round) | not probed | not probed | not probed |

All four steps ran against a fresh `DSH_HOME` on this host, on one disposable `headless`
profile that was added with `file:<this-repo>` and removed again afterwards. Install exited
0 and printed no refusal wording; its only warning was pnpm's advisory
`Issues with peer dependencies found`, the same one the 0.8.x rows below record.
`--dump-config` showed the `logicprobe` row with `enabled: true` and no
`disabling profile plugin` line. The boot reached the model-provider stage with a
deliberately invalid key and printed only
`dsh: AUTH: Authentication Fails, Your api key: ****test is invalid`, so the tree mounted
and applied before the provider call. After the uninstall, `--dump-config` carried no
`logicprobe` row.

Two method deviations belong here, and they make this row weaker than the two below, not
stronger. It ran the **globally installed** dsh 0.1.7-rc.2 (`dsh --version` → `0.1.7-rc.2`)
rather than a temporary npm install of that release, and it did **not** run the session-log
seam scan: the boot failed at provider authentication, so no session was opened to scan.

0.9.0 changes model-visible text and the version strings, and nothing on a DSH-facing seam:
it registers the same six tools through the same `ctx.tools.register` calls, injects
through the same `agent/pre-step` listener, and registers the same `logicprobe:mode`
prompt context and the same skills provider. `0.2.1-alpha.1` was therefore not re-measured
for this build; the 0.8.0 and 0.8.1 rows below remain the reference for the seams they
exercised on it.

### Re-measured on `0.2.1-alpha.1` (`0.8.0` on 2026-10-05, `0.8.1` on 2026-10-06)

| dsh release | install | host boot | uninstall | rows active | client bundles in `__DSH_BOOT__` | settings namespace served | Web switch |
|---|---|---:|---:|---|---:|---:|---|
| 0.2.1-alpha.1 | pass | pass | pass | not probed (headless round) | not probed | not probed | not probed |

Both releases cleared the same four steps on this dsh release, each against its own
fresh `DSH_HOME`. The plugins are `dsh-logicprobe` and the sibling
`dsh-embedded-workbench` 0.9.1.

0.8.1 re-ran the identical procedure and passed identically. That release changes only
`lib/engine.js` (an A9 `leads-to` fix) with its tests, so the DSH-facing seams are the
same code the 0.8.0 row measured.

The round ran twice. The first pass was at 22:02. The second pass was at 22:33, after
an internal fix to the bundled UML module. Every step passed identically in both, so
the output below is quoted from the second pass, which measured the frozen build:

```text
dsh plugin --profile headless add "file:<this-repo>"
  -> dsh-logicprobe: Progress: resolved 1, reused 1, downloaded 0, added 1, done | Done in 1.9s using pnpm v11.21.0
  -> dsh-embedded-workbench: Packages: +1 | Done in 1.8s using pnpm v11.21.0
dsh --profile headless --dump-config
  -> - id: logicprobe            name: dsh-logicprobe            enabled: true
  -> - id: embedded-workbench    name: dsh-embedded-workbench    enabled: true
DEEPSEEK_API_KEY=fake-key-for-boot-test dsh --profile headless "reply OK"
  -> dsh: AUTH: Authentication Fails, Your api key: ****test is invalid (request_id: ...)
dsh plugin --profile headless remove <package>  &&  dsh --profile headless --dump-config
  -> row gone (both plugins)
```

The boot output is that one `AUTH` line and nothing else. There is no
`plugin tree failed to load`, no `volatile is not a function`, no
`ERR_MODULE_NOT_FOUND` and no `Cannot find module`. The 0.1.7 and 0.2.0 rows recorded
the same clean-boot signature. It shows both bundles applied before the
model-provider call, rather than merely installing.

pnpm printed its advisory warning
`[WARN] Issues with peer dependencies found. Run "pnpm peers check" to list them.`
intermittently. It appeared for `dsh-embedded-workbench` only in the first pass, for
both packages in the second pass, and for neither package in two ad-hoc repeat
installs into fresh profiles on the same host. The warning is advisory in every case:
the install exited 0, and the mount, boot and uninstall steps all passed. It is
recorded here so a later reader does not mistake it for a compatibility failure.

**On this release the peer-range widening is a declaration, not a gate.** A copy of
this manifest was added to a fresh profile on 0.2.1-alpha.1, with the pre-widening
ranges (peers and `dsh.compatibility.dsh` both ending at `^0.2.0-rc.1`). It installed
cleanly: exit 0, 733 ms, pnpm reached, no preflight refusal. On 0.2.0-rc.2 the same
shape was refused before pnpm ran. The `|| ^0.2.1-alpha.1` branch is therefore added
to the peer ranges and the `dsh` range because that is the release this round
measured, not because the host would otherwise reject the package.

### Re-measured in the 2026-09-29 round against `0.7.1`

| dsh release | install | host boot | uninstall | rows active | client bundles in `__DSH_BOOT__` | settings namespace served | Web switch |
|---|---|---:|---:|---|---:|---:|---|
| 0.1.5-rc.3 | pass | pass ×2 | pass | active ×2 (`pluginInventory/list`; `pluginManager/listPlugins` is 404 here) | not probed | no — expected: nothing sits under a `.volatile()` node | absent, silently (degraded path) |
| 0.1.5-rc.2 | pass (pnpm's advisory peer WARN only, although the bundle declares `schemastery: ^3.18.4` while this release ships 3.18.2) | pass | pass | active ×2 (`pluginInventory/list`; `pluginManager/listPlugins` is 404 here too) | yes ×2 (HTTP 200, ~9030 / ~9158 chars) | no — expected: schemastery 3.18.2 holds 0 occurrences of `volatile`, so `Schema.volatile` and an instance's `.volatile` are both undefined | absent, silently (degraded path) |
| 0.1.6-alpha.2 | pass | pass | pass | active ×2 | yes ×2 (HTTP 200) | no | absent, silently |
| 0.1.7-alpha.1 | pass | pass | pass | active ×2 | yes ×2 | yes ×2 — one `enabled` boolean, `default: true`, `applies: "live"` | **works** |
| 0.1.7-alpha.2 | pass | pass | pass | active ×2 | yes ×2 | yes ×2 | **works** |
| 0.1.7-rc.1 | pass | pass | pass | active ×2 | yes ×2 | yes ×2 | **works** |
| 0.1.7-rc.2 | pass | pass | pass | active ×2 | yes ×2 | yes ×2 | **works** |
| 0.2.0-rc.1 | pass | pass | pass | active ×2 | not probed | yes ×2 — one `enabled` boolean, `default: true`, `value: true`, `applies: "live"` | **works** |
| 0.2.0-rc.2 | pass | pass | pass | active ×2 | yes ×2 (HTTP 200) | yes ×2 — `value: {"enabled": true}`, `applies: "live"` | **works** |

Uninstall was re-run on every re-measured release — 9 releases × 2 plugins = 18/18
pass, each: row present → `plugin remove` → row gone → re-add → row restored.

`0.1.5-rc.3` is the row that justifies the degradation guard. Before it, adding
either plugin made that host **fail to boot** with
`z.boolean(...).default(...).volatile is not a function` at
`dsh-logicprobe/lib/index.js:73`; after it, each boot log is 83 bytes containing
only the `dsh web: http://127.0.0.1:<port>/?token=…` line, with zero occurrences
of `volatile is not a function`, `plugin tree failed to load`, or `Error`, and
both plugin rows report `fiberPhase: "active"`. `settings/describe` returns 14
namespaces with neither plugin namespace present — the correct degraded outcome
for a host with no live field, not a failure.

`0.1.5-rc.2` was measured for the same reason and behaves identically: the
pre-guard boot failure is the same one, and with the guard the host boots with no
error output and both rows `active`. It adds one observation the 0.1.5-rc.3 row
could not make — **both client bundles serve HTTP 200 and both client entries
appear in `window.__DSH_BOOT__`**, so the browser half really is delivered and
executed on these hosts. That is what makes the `whileServed` check in
`src/client.js` load-bearing rather than defensive: without it, this plugin's own
client activation would throw on a host whose settings service has no
`whileServed`.

`0.2.0-rc.2` still serves both namespaces, which is what shows the guard did not
disable the live field on a modern host: a namespace is served only when
`meta.volatile` is set. It installs only after the peer ranges were widened with
`|| ^0.2.0-rc.1`; before that widening this release's install preflight refused
both plugins as incompatible and `dsh plugin add` never reached pnpm. `0.2.0-rc.1`
was measured afterwards and clears the preflight the same way, serving both
namespaces with one `enabled` boolean, so that added range branch now has a row of
its own rather than only its `rc.2` sibling; it ships schemastery 3.18.4, whose
`lib/index.cjs` defines `Schema.prototype.volatile` at line 235. On
`0.1.7-alpha.1` a live write was round-tripped end to end: `enabled` set to
`false` at revision 1, then unset at revision 2, leaving the value back at the
schema default.

### Carried over from earlier rounds

These rows were verified by an earlier round's headless procedure and remain
declared compatible for this release, but were **not** re-measured against the
0.7.1 build. The 0.1.5.x rows previously carried an explicit expectation that the
guard would restore them; the two that were then tested (0.1.5-rc.2 and
0.1.5-rc.3) are now measured and live in the table above, and the rest stay
unverified.

| dsh release | earlier result | note |
|---|---|---|
| 0.1.0-rc.7 | pass (AUTH-only) | not re-measured |
| 0.1.0-rc.8 | pass (AUTH-only) | untestable this round — no `--from-default-profile`, and its web profile already hard-crashes on a stock plugin-free boot: `@deepseek-ai/dsh-web-app/cordis.patch.yml` disables the `hmr` row while `runProfile`/`watchUserPatches` requires the HMR service |
| 0.1.1-rc.1 | pass (AUTH-only) | not re-measured |
| 0.1.1-rc.2 | pass (AUTH-only) | not re-measured |
| 0.1.2-alpha.2 | pass (AUTH-only) | not re-measured |
| 0.1.2-alpha.3 | pass (AUTH-only) | not re-measured |
| 0.1.2-alpha.4 | pass (AUTH-only) | not re-measured |
| 0.1.2-alpha.5 | pass (AUTH-only) | not re-measured |
| 0.1.2-rc.1 | pass (AUTH-only) | not re-measured |
| 0.1.3-alpha.1 | pass (AUTH-only) | not re-measured |
| 0.1.3-alpha.2 | pass (AUTH-only) | not re-measured |
| 0.1.5-alpha.1 | pass (AUTH-only) | not re-measured |
| 0.1.5-alpha.2 | pass (AUTH-only) | not re-measured |
| 0.1.5-rc.1 | pass (AUTH-only) | not re-measured |
| 0.1.6-alpha.1 | pass (AUTH-only) | untestable — the published CLI is itself broken: `@deepseek-ai/dsh-app-boot` does not export `watchUserPatches`, because its caret range `^0.1.6-alpha.1` resolved the whole `@deepseek-ai/*` family to alpha.2, so every dsh subcommand dies at module load |

## Declared compatibility (package.json)

Quoted from the manifest of 0.8.0. The `peerDependencies` block is included because
the install preflight evaluates it, not `dshReleases`
(`@deepseek-ai/dsh-app-boot/lib/index.js:289-293`).

```json
"engines": { "node": ">=20" },
"peerDependencies": {
  "@deepseek-ai/cordis": "^4.0.4",
  "@deepseek-ai/dsh-agent": "^0.1.0-rc.6 || ^0.2.0-rc.1 || ^0.2.1-alpha.1",
  "@deepseek-ai/dsh-llm": "^0.1.0-rc.6 || ^0.2.0-rc.1 || ^0.2.1-alpha.1",
  "@deepseek-ai/dsh-session": "^0.1.0-rc.6 || ^0.2.0-rc.1 || ^0.2.1-alpha.1",
  "@deepseek-ai/dsh-skill-filesystem": "^0.1.0-rc.8 || ^0.2.0-rc.1 || ^0.2.1-alpha.1",
  "@deepseek-ai/dsh-tools": "^0.1.0-rc.6 || ^0.2.0-rc.1 || ^0.2.1-alpha.1",
  "@deepseek-ai/schemastery": "^3.18.4"
},
"dsh": {
  "engines": { "dsh": ">=0.1.0-rc.7" },
  "compatibility": {
    "dsh": "^0.1.0-rc.7 || ^0.1.1-rc.1 || ^0.1.2-alpha.2 || ^0.1.2-alpha.3 || ^0.1.2-alpha.4 || ^0.1.2-alpha.5 || ^0.1.2-rc.1 || ^0.1.3-alpha.1 || ^0.1.3-alpha.2 || ^0.1.5-alpha.1 || ^0.1.5-rc.1 || ^0.1.5-alpha.2 || ^0.1.5-rc.2 || ^0.1.5-rc.3 || ^0.1.6-alpha.1 || ^0.1.6-alpha.2 || ^0.1.7-alpha.1 || ^0.1.7-alpha.2 || ^0.1.7-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.1 || ^0.2.1-alpha.1",
    "dshReleases": {
      "0.1.0-rc.7": "compatible",
      "0.1.0-rc.8": "compatible",
      "0.1.1-rc.1": "compatible",
      "0.1.1-rc.2": "compatible",
      "0.1.2-alpha.2": "compatible",
      "0.1.2-alpha.3": "compatible",
      "0.1.2-alpha.4": "compatible",
      "0.1.2-alpha.5": "compatible",
      "0.1.2-rc.1": "compatible",
      "0.1.3-alpha.1": "compatible",
      "0.1.3-alpha.2": "compatible",
      "0.1.5-alpha.1": "compatible",
      "0.1.5-alpha.2": "compatible",
      "0.1.5-rc.1": "compatible",
      "0.1.5-rc.2": "compatible",
      "0.1.5-rc.3": "compatible",
      "0.1.6-alpha.1": "compatible",
      "0.1.6-alpha.2": "compatible",
      "0.1.7-alpha.1": "compatible",
      "0.1.7-alpha.2": "compatible",
      "0.1.7-rc.1": "compatible",
      "0.1.7-rc.2": "compatible",
      "0.2.0-rc.1": "compatible",
      "0.2.0-rc.2": "compatible",
      "0.2.1-alpha.1": "compatible"
    },
    "profiles": ["headless", "web"]
  }
}
```

`@deepseek-ai/schemastery` stays at `^3.18.4` rather than being relaxed to the
3.18.3 that first shipped `.volatile()`. The guard is what makes a host without
the method usable, and the hosts it targets (≤ 0.1.6-alpha.2) have no install
preflight to enforce a peer range anyway. From 0.1.7-rc.1 on, the preflight does
enforce it, so an install there is refused unless the host really provides the
schemastery this package was tested against. The guard lowers the failure mode; it
does not licence a support claim that was never measured.

On 0.2.1-alpha.1 the preflight did **not** refuse the pre-widening manifest. That is
a measurement, not an assumption. The extra `|| ^0.2.1-alpha.1` branch therefore
records the release this package was actually run against. It is not a gate the host
imposes.

## Notes

These bullets are grouped by the round that produced them. The first governs
0.7.1. Several later ones describe what an **older** plugin version was verified
against, so where one reads "keeps 0.1.0-rc.7 … X working" it means that round's
plugin version, not this one. The Results tables above are the authoritative
statement for 0.8.0.

- **The 0.2.1-alpha.1 round measured four steps, not the Web half.** Install,
  mount, headless boot and uninstall were re-run for both plugins on 2026-10-05.
  See the Results section. `rows active`, `__DSH_BOOT__`, the settings namespace and
  the live Web switch were **not** probed for that row, so its table cells read
  "not probed" instead of inheriting the 0.2.0-rc.2 result. The row still establishes
  that the bundle applies on the new release: the boot reached the model-provider
  stage with no plugin load error. That cannot happen if a row failed to compose.
- **A version bump resets old-version evidence. This release adds a tool but no new
  host seam.** 0.8.0 adds `logicprobe_uml` to `ctx.tools`, next to the five existing
  tools, and extends the `logicprobe:mode` context text. Tool registration and the
  `cordisInspect` status projection are the same calls this package has made since
  0.1.0-rc.7. The 0.7.1 rows above therefore remain the reference for the seams they
  exercised. The 0.8.0 row speaks for installation and boot on 0.2.1-alpha.1.

- **The Web switch needs a live field; the plugin no longer needs one in order to
  load.** 0.7.1 declares `enabled` live so the dsh Web GUI can edit the
  gate-injection switch in place. Declaring it is guarded: `live<T>(field)` probes
  `typeof field.volatile === 'function'` and calls `.volatile()` only where the
  host's schemastery provides it, returning the field unchanged otherwise, and
  `Config.enabled` is typed `Volatile<boolean> | boolean`. `injectionEnabled(config)`
  reads either shape, and both the `agent/pre-step` hook and the inspect provider
  go through it. A host that cannot carry a live field therefore still loads, still
  injects the gate, and still registers skills and tools — it simply has no switch.
  - **Two independent reasons the switch is absent on an older host, and neither
    one errors.** (a) schemastery older than 3.18.3 leaves `enabled` an ordinary
    boolean, so nothing sits under a `.volatile()` node for the settings service to
    project. (b) A settings service without `whileServed` makes the client half
    return early and register nothing — it is checked rather than called, because
    calling it would throw inside the plugin's own client activation, which the Web
    boot audit reports as a failed client entry. Measured: dsh 0.1.6-alpha.2 boots
    with both rows `active` and both client bundles serving, yet
    `settings/describe` returns 15 namespaces without this package's; dsh
    0.1.5-rc.3 returns 14 without it. Nothing logs an error, which is what makes
    this case quiet rather than broken.
  - **Measured.** On `0.1.5-rc.3` (schemastery 3.18.2), adding either plugin made
    the host fail to boot with `z.boolean(...).default(...).volatile is not a
    function` **before** the guard; after it, the host boots cleanly on two
    OS-assigned ports with both rows `active` and a boot log free of errors. On
    `0.2.0-rc.2`, both namespaces are still served with
    `value: {"enabled": true}` and `applies: "live"`, which is what shows the guard
    did not disable the live field on a modern host. The switch itself works from
    `0.1.7-alpha.1`, also measured on 0.1.7-alpha.2, 0.1.7-rc.1, 0.1.7-rc.2,
    0.2.0-rc.1 and 0.2.0-rc.2.
  - **Executable evidence, not a claim.** `tests/dsh-volatile-fallback.test.mjs`
    removes `.volatile` from the real schemastery prototype before importing the
    built artifact, so the degradation branch is exercised in CI rather than only
    on a user's machine; `tests/dsh-client-half.test.mjs` covers the missing
    `whileServed` path. Without those two, this degradation story would describe
    code that never runs in this repository.
  - **The declared `schemastery` peer stays `^3.18.4`.** The guard is what makes an
    ungated host work, and the hosts it targets (≤ 0.1.6-alpha.2) have no install
    preflight to enforce a peer range anyway. From 0.1.7-rc.1 on the preflight does
    enforce it, so an install there is refused unless the host really provides the
    schemastery this package was tested against: the guard lowers the failure mode,
    it does not licence a support claim that was never measured.
- DSH 0.1.2-alpha.4 removed the `Session.events` getter and replaced it with
  on-demand reads (`seq` / `eventAt()` / `snapshotEvents()`). 0.6.0 reads
  session history through a version-adaptive helper (`readSessionEvents`) that
  prefers `snapshotEvents()` when present and falls back to the `events`
  snapshot on earlier releases, so the gate injection keeps working on every
  declared DSH release. Regression-checked with harnessed `agent/pre-step`
  runs against both session event-source shapes (12/12 pass) in addition to
  the per-release boot matrix above.
- DSH 0.1.2-alpha.5 (session-projection cache v6 read compatibility and
  storage salvage) and 0.1.2-rc.1 (release-candidate stabilization on top of
  alpha.5) do not change the plugin-facing seams this bundle relies on
  (`agent/pre-step`, `Session` event reads, `ctx.tools`/provider
  registration); verified per release with the disposable-profile matrix above
  (0.6.0 keeps 0.1.0-rc.7 … 0.1.2-rc.1 working).
- DSH 0.1.3-alpha.1 (session format v2 with released migration, embedded
  assistant streams, and the new `agent/assistant-stream` live event) does not
  change the plugin-facing seams this bundle relies on (`agent/pre-step`,
  `Session` snapshot event reads, `ctx.skills`/`ctx.tools` registration);
  `assistant/chunk` log events were removed in v2 but this bundle never reads
  them. Verified per release with the disposable-profile matrix above (0.6.1
  keeps 0.1.0-rc.7 … 0.1.3-alpha.1 working). The 0.1.3-alpha.1 row ran a local
  source build of the git tag with the new `fs-ext` native dependency stubbed
  out on this no-MSVC host (see Method); 0.1.3-alpha.2 re-verified the same
  seams from the published npm release.
- DSH 0.1.3-alpha.2 (persona configuration split into prefix/suffix, default
  read/write/edit file tools for SDK/Headless/ACP, and subprocess handles
  dropping `pid`) renames `PERSONA_SECTION` to `PERSONA_PREFIX_SECTION` and
  replaces `Config.persona` with `personaPrefix`/`personaSuffix`, but this
  bundle never reads the persona slot — it registers its own `logicprobe:mode`
  prompt-context section, which still assembles (visible in the recorded session
  log) — and it touches neither subprocess handles nor the `agent/pre-step` /
  `Session` snapshot seams. `Session.fromRestore` gained a fifth `eventState`
  parameter and `dsh-session` dropped its internal `chunk-rows` exports; this
  bundle uses neither. Verified with the disposable-profile matrix above plus
  the session-log gate evidence (0.6.2 keeps 0.1.0-rc.7 … 0.1.3-alpha.2
  working).
- DSH 0.1.5-alpha.1 (session format v3, the `system/message` surface node that
  now carries the rendered system prompt, the released v2-to-v3 migration, the
  `tool/code-dispatch*` → `tool/ptc-dispatch*` rename, and stricter event
  validation) does not change the plugin-facing seams this bundle relies on
  (`agent/pre-step`, `Session` snapshot event reads, `ctx.skills`/`ctx.tools`
  registration, `systemPrompt.context`). The stricter validation constrains
  only `request/header` and `tool/result`, while `user/message` still projects
  verbatim, so the injected gate remains valid; the `logicprobe:mode` context
  still assembles into the runtime-context message. `fs-ext` was replaced by
  the lazily loaded prebuilt `@deepseek-ai/node-addon-system/flock`, so this row
  installed from the published npm release as-is. Verified with the
  disposable-profile matrix plus the v3 session-log gate evidence (0.6.3 keeps
  0.1.0-rc.7 … 0.1.5-alpha.1 working).
- DSH 0.1.5-rc.1 (release-candidate stabilization over alpha.1: 198 commits
  dominated by Web/Client sidebar, file-preview, diagram and workspace-files
  work; additive `deliverables/presented` and `subagent/catalog` event types;
  an optional `LlmConfigurableProvider.error` diagnostic; `chokidar` added to
  app-boot) keeps session format v3 and leaves the `agent/pre-step`, `Session`
  snapshot, `ctx.skills`/`ctx.tools`, `systemPrompt.context` and `createUserMessage`
  seams unchanged. Verified with the disposable-profile matrix plus the v3
  session-log gate evidence (0.6.4 keeps 0.1.0-rc.7 … 0.1.5-rc.1 working).
- DSH 0.1.5-alpha.2 (185 commits on the same Web/Client stabilization line;
  its plugin-facing delta matches the rc.1 row) and 0.1.5-rc.2 (a two-commit
  version-bump-only release over rc.1) keep session format v3 and leave the
  `agent/pre-step`, `Session` snapshot,
  `ctx.skills`/`ctx.tools`, `systemPrompt.context` and `createUserMessage`
  seams unchanged. Verified with the disposable-profile matrix plus the v3
  session-log gate evidence (0.6.5 keeps 0.1.0-rc.7 … 0.1.5-rc.2 working).
- DSH 0.1.6-alpha.1 (550 non-merge commits over rc.2: a large Web/Client
  push, the `llm-deepseek` split into `chat-completions`/`messages` protocol
  adapters, the `code-runtime` → `ptc-runtime` rename, and new `ssh` /
  browser-use / MCP-resources packages) keeps session format v3
  (`SESSION_FORMAT_VERSION` is still `3`) and leaves the plugin-facing seams
  this bundle relies on unchanged: `agent/pre-step` is unchanged from 0.1.5-rc.2
  (same payload and an unchanged `PreStepDecision` contract),
  `ctx.skills.registerProvider`, `ctx.tools` registration,
  `systemPrompt.context` (only an additive optional `interpolate` flag) and
  `createUserMessage` keep their signatures. `Session.snapshotEvents()` /
  `eventAt()` / `ownEvents()` are marked `@deprecated` for new callers but still
  behave identically, so the version-adaptive `readSessionEvents` helper keeps
  working. The new `image/offload` event type requires a
  `SessionMessageProjection` interpreter from its owning plugin; this bundle
  emits no session events, so it registers none. The renamed
  `Session.surface.replaceGeneration` → `contentGeneration` and `dsh-llm`'s
  `AssistantProvenance` → `AssistantProviderMetadata` are not referenced by this
  bundle. Verified with the disposable-profile matrix plus the v3 session-log
  gate evidence (0.6.6 keeps 0.1.0-rc.7 … 0.1.6-alpha.1 working).
- DSH 0.1.6-alpha.2 (548 non-merge commits over alpha.1: the new
  `boot/plugin-manager`, `boot/hmr` and `client/ui-plugin-manager` packages, a
  large session-controller / terminal / attachment pass, and `tool-cordis`
  rewritten from the dynamic define/run/stop tools to read-only inspection)
  keeps session format v3 (`SESSION_FORMAT_VERSION` is still `3`) and leaves the
  plugin-facing seams this bundle relies on unchanged: `agent/pre-step` keeps the
  same payload and an unchanged `PreStepDecision`
  (`core/agent/src/runtime-types.ts`), and `ctx.skills.registerProvider`,
  `ctx.tools` registration, `systemPrompt.context`, `createUserMessage`,
  `Session.snapshotEvents()` and `ctx.get('cordisInspect')` register the same
  way. `known-event-types.ts` gains one additive `workspace/changes` event type,
  and the rewritten `tool-cordis` drops `dynamicCordisRunner` from its own
  injections — this bundle registers only a read-only inspection provider, so
  neither affects it. `dsh plugin add` still forwards to pnpm with the same
  `file:`/name specs and `--dump-config` still prints the composed tree; the only
  launcher change is that `dsh <name>` now abbreviates `dsh --profile <name>` for
  every profile rather than just `web`, so the documented commands keep working.
  Verified with the disposable-profile matrix plus the v3 session-log gate
  evidence (0.6.7 keeps 0.1.0-rc.7 … 0.1.6-alpha.2 working).
- DSH 0.1.7-alpha.1 (910 non-merge commits over alpha.2; session format
  **v4**) is the first release that breaks this bundle, and 0.6.8 carries the
  fix. V4 retires the shared `{ kind: 'plugin', plugin }` message-source
  wrapper: native source admission refuses it in every declared durable message
  slot, so the gate append failed with `format v4 message requires a
  producer-owned source kind` and the headless boot aborted. This bundle now
  declares its own kind through `MessageSourceMap` and writes
  `{ kind: 'plugin:logicprobe' }` — the exact identity the official V3→V4
  migration derives for this producer — while the history guard still accepts
  the pre-v4 wrapper, so sessions written by older builds keep their
  once-per-session gate. `agent/pre-step`, `PreStepDecision`,
  `ctx.skills.registerProvider`, `ctx.tools` registration,
  `systemPrompt.context`, `Session.snapshotEvents()` and
  `ctx.get('cordisInspect')` are otherwise unchanged; `known-event-types.ts`
  only adds `developer/message`, and `ContextFormed` still allows an
  undeclared form. Verified with the disposable-profile matrix against
  0.1.7-alpha.1 plus regression passes on 0.1.6-alpha.2 and 0.1.5-rc.2, and by
  type-checking the sources against the 0.1.7-alpha.1 declarations (0.6.8 keeps
  0.1.0-rc.7 … 0.1.7-alpha.1 working).
- DSH 0.1.5-rc.3 is a three-commit release-pin fix over 0.1.5-rc.2
  (`release(dsh): 0.1.5-rc.3`, `fix(release): pin vendor dependencies for dsh
  0.1.5`) with no source change on any plugin-facing seam. It is the release the
  npm `latest` dist-tag points at, so it is what a plain `npm install -g
  @deepseek-ai/dsh` resolves to; it is now declared and verified rather than left
  implicit in the `^0.1.5-rc.2` branch. Verified with the disposable-profile
  matrix plus the v3 session-log seam evidence (0.6.9 keeps 0.1.0-rc.7 …
  0.1.5-rc.3 working).
- DSH 0.1.7-alpha.2 (162 non-merge commits over alpha.1), 0.1.7-rc.1 (156 over
  alpha.2) and 0.1.7-rc.2 (346 over rc.1; five new packages — `client/shortcuts`,
  `client/ui-shortcuts`, `llm/llm-deepseek-account`, `llm/llm-deepseek-api-key`,
  `util/code-language`) are a client/Web/schedule stabilization line and do not
  break this bundle. The work is dominated by `client/ui-*` (chat, tool,
  conversation, sidebar, workspace, theme, schedule), with
  `boot/plugin-manager`, `boot/app-boot`, `schedule/schedule`,
  `spill/spill-policy`, `subprocess/subprocess-local` and `llm/llm-deepseek`
  behind it. Session format is still **v4** (`SESSION_FORMAT_VERSION` is `4` in
  `packages/core/session/src/types.ts`) and the seams this bundle relies on are
  unchanged or additively widened:
  - `core/agent/src/runtime-types.ts` — which declares both the `agent/pre-step`
    payload (`{ agent, messages, turn, step, signal }`) and `PreStepDecision` —
    is byte-identical between 0.1.7-alpha.1 and 0.1.7-rc.2.
  - `llm/llm/src/message.ts` (`createUserMessage`, `MessageSourceMap`,
    `ContextFormed`) and `session-format-v3-to-v4/src/message-sources.ts` are
    unchanged, so declaring `plugin:logicprobe` through `MessageSourceMap` and
    writing `{ kind: 'plugin:logicprobe' }` still passes native source admission
    (the rule is unchanged: any non-empty producer-owned `kind` other than the
    retired `'plugin'`).
  - `skill/skill-filesystem`, `core/system-prompt` and
    `extensions/cordis-host-runner` contain no source change, and `skill/skill`'s
    `registerProvider(control => provider)` signature is unchanged, so the
    bundled skill still registers through the standard filesystem provider.
  - `core/tools` adds only optional surface: `DefineToolOptions.projectContent?`
    and `PreToolDecision.ask.displayReason?`. The `defineTool` generic signature
    is unchanged, so all five tool definitions compile and register as before.
  - `Session.toolHistory()` is new and additive; `snapshotEvents()` / `eventAt()`
    keep working, so the version-adaptive `readSessionEvents` helper is
    unaffected.
  - `projectToolUpdates` — the rc.1/rc.2 tool-add/remove projection that can
    rewrite request history — filters only `role === 'developer'` messages. The
    injected gate is a `user/message` and is passed through verbatim, which the
    logged `request/header` list confirms (all five `logicprobe_*` tools present
    on every row).
- DSH 0.1.7-rc.1 introduces a **plugin-compatibility preflight** that this bundle
  must pass, and 0.6.9 records the evidence for it. `boot/app-boot` gains
  `plugin-compatibility.ts`, `profile-compatibility.ts` and
  `compatibility-preflight.ts`, and `apps/cli/src/plugin.ts` gains `dsh plugin
  allow-version | revoke-version | version-exemptions` backed by a profile-local
  `compatibility.json`. There are two enforcement points: `dsh plugin add`
  evaluates the named package before installing, and profile composition
  evaluates every selected bundle row before mounting it (an incompatible row is
  disabled with `disabling profile plugin …`; a refused install reports `crashes
  or data loss` / `nothing was installed`). Both call
  `evaluatePluginCompatibility`, which checks each `peerDependencies` entry named
  `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` with `semver.satisfies(runtime,
  range, { includePrerelease: true })` and otherwise requires an exact
  `package@version` + DSH-version exemption. This bundle declares
  `^0.1.0-rc.6 || ^0.2.0-rc.1` (and `^0.1.0-rc.8 || ^0.2.0-rc.1` for
  `dsh-skill-filesystem`); under `includePrerelease: true` the first branch still
  admits every 0.1.x, so no exemption is needed on that line, while the second
  branch is what pins the 0.2 boundary — this release's preflight refused the
  bundle on 0.2.0-rc.2 until that branch was added. The check reads
  `peerDependencies`, **not** `dsh.compatibility`. Verified
  empirically rather than by inspection alone: every row's install and boot was
  asserted free of the refusal wording, and the published
  `dsh-app-boot@0.1.7-rc.2` bundle was confirmed to ship the same
  `includePrerelease: true` call. The matrix for this round ran 2 plugins × 6
  runtimes (0.1.5-rc.3, 0.1.6-alpha.2 and 0.1.7-alpha.1 as regression controls,
  plus 0.1.7-alpha.2, 0.1.7-rc.1 and 0.1.7-rc.2) and passed 12/12; both bundles
  were also type-checked with `tsc --noEmit` against the 0.1.5-rc.3,
  0.1.7-alpha.2, 0.1.7-rc.1 and 0.1.7-rc.2 declarations (0.6.9 keeps 0.1.0-rc.7 …
  0.1.7-rc.2 working).
- **Known limitation, accepted: the preflight still cannot protect the 0.1.x
  line.** Because the first branch of each peer range (`^0.1.0-rc.6`, and
  `^0.1.0-rc.8` for `@deepseek-ai/dsh-skill-filesystem`) admits every 0.1.x under
  `includePrerelease: true`, `evaluatePluginCompatibility` returns no issue for
  any 0.1.x host — including 0.1.5-rc.2 and 0.1.5-rc.3, whose schemastery
  predates `.volatile()` (the degradation guard is what keeps those hosts loading;
  see the degradation note above), and including a future 0.1.x release that has
  not been verified here. 0.1.5-rc.2's install is the measurement for that: it was
  not refused, even though this bundle declares `schemastery: ^3.18.4` while that
  host ships 3.18.2. The preflight also never reads
  `dsh.compatibility.dshReleases`, so narrowing the declared range is not enough
  on its own; the `|| ^0.2.0-rc.1` branch does gate the 0.2 line. Narrowing the
  0.1.x branch to the verified releases would let a DSH patch release disable the
  plugin on every profile before this repo re-verifies, which is worse for users
  than the status quo. A future round that narrows it should also confirm that
  `dsh plugin allow-version <pkg>@<version> --dsh-version <exact> --accept-risk`
  is documented for the users it would newly block.
- 0.5.5 is deprecated on npm with a warning pointing to 0.5.6 (npmjs blocks
  `npm unpublish` for automation tokens under its 2FA write policy): its
  `dsh.compatibility.dsh` range (`^0.1.2-alpha.3`) admitted 0.1.2-alpha.4
  while that bundle predated the alpha.4 session API fix. 0.6.0 continues the
  same session-adapter lineage and is published as `latest`.
- `dsh.engines.dsh` is `>=0.1.0-rc.7`, the standing functional range that the
  degradation note above keeps true; the **Web switch** is what carries the higher
  floor, `>=0.1.7-alpha.1`, and that floor belongs to the feature rather than to
  `engines`.
- Windows-only evidence; other platforms were not exercised.
