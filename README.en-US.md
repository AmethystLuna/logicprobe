# Logic Probe

<p align="center"><strong>English</strong> · <a href="README.md">中文</a></p>

[![HOL Guard Scanner](https://img.shields.io/badge/HOL%20Guard-passing-00a67e)](https://github.com/hashgraph-online/hol-guard)

For an unverified design, failure is only a matter of time. However complex the code, model it and run it — then it becomes clear.

logicprobe checks a claim against the thing it describes. Facts go against the source. Behaviour goes through a model: state machines, protocols, composition, data models, migrations. Diagrams are read as dependency graphs, at one level or several. Two reports can be compared to see whether a change made things worse. Dimensions it cannot verify are named, and routed.

**Cross-platform**: works with Claude Code, Codex CLI, Cursor, Kimi CLI, OpenCode, and ZCode. Built on the [Agent Skills](https://agentskills.io) open standard.

## What It Does

| Phase | What |
|-------|------|
| Phase 1-2 | Enumerate every verifiable claim: API names, file paths, enum values, counts, mechanism feasibility. Verify each one against the codebase with evidence. |
| Phase 2a | **8 structural checks (S1-S8)** on the extracted state machine: S1 reachability, S2 deadlock, S3 liveness, S4 determinism, S5 event completeness, S6 guard completeness, S7 invariant validity, S8 monotonic variables. |
| Phase 2b | **14 adversarial probes (A1-A14)**: unexpected events, race interleaving, order permutation, pair symmetry (lock/unlock, incl. implicit onEntry/onExit pairing), boundary blast, resource injection, minimal counter-example, idempotent replay, leads-to, sequence, atomicity, budget (A12 worst-case path cost, incl. positive-cost-cycle detection), probability reachability (A13), deadline (A14). |
| Refactoring | Before/after model comparison: behavioral preservation, invariant continuity, deadlock regression, complexity claims. |
| Data models | DataModelV1 verification (DS/DA/DD): migration coverage, copy consistency, before/after breaking-change regression. |
| UML modelling and review | Draw a code flow as UML, then review the modelling itself: structural defects, documentation gaps, diagram-versus-model fidelity. |
| Concurrency risk mining | Scan documents and plans for concurrency safety claims (thread-safe, lock-free, race condition, interrupt safety) and flag them for dedicated verification. |
| Output | Structured findings with exact file:line evidence, severity, and correction direction. Never an inline fix. The report carries `coverageNotes`, which routes timing, preemption, hybrid-control and probability vocabulary to external tools (UPPAAL, TSan, CBMC, TLA+, SpaceEx, PRISM). See `skills/logicprobe/references/gap-routing-guide.md`. A model may also carry a natural-language `narrative` (state, event and scenario annotations), which the report echoes verbatim. |

The model is always shown as a transition table first, and **confirmed with the user before it runs**. Extraction errors are the dominant failure mode.

## Installation

### Claude Code install (recommended)

Add the marketplace to **Claude Code**'s `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "logicprobe": {
      "source": { "source": "github", "repo": "AmethystLuna/logicprobe" }
    }
  }
}
```

Then install from the CLI:

```bash
claude plugin install logicprobe@logicprobe
```

### Claude Code manual install

```bash
git clone https://github.com/AmethystLuna/logicprobe.git ~/.claude/plugins/dev/logicprobe
```

Then enable it in `~/.claude/settings.json`:

```json
{
  "enabledPlugins": {
    "logicprobe@dev": true
  }
}
```

## DeepSeek Harness (dsh)

Native dsh support ships as a cordis plugin bundle at the repository root, declared by `dsh.bundle` in the root `package.json`.

The bundle does three things:

1. **Registers the skills.** They follow the Agent Skills open standard and are discovered as-is by dsh's `skill-filesystem` provider. No extra code.
2. **Injects the gate text.** The first model step of every session receives the claim-verification gate (1% Rule / Red Flags / proactive suggestion). This is the dsh counterpart of the Claude `SessionStart` hook.
3. **Registers the native tools and a context.** The tools live on `ctx.tools`. A policy-aware `logicprobe:mode` context lives on `ctx.systemPrompt`. A model-visible catalog entry is available through `cordis_inspect`.

The tools:

| Tool | What it does |
|------|------|
| `logicprobe_verify` | State-machine verification: S1-S8 structural checks plus A1-A14 adversarial probes. Pass `beforeModel` and `stateMapping` to add the D1-D4 before/after regression. |
| `logicprobe_datamodel_verify` | Data-model verification: DataModelV1, migration coverage, copy consistency, DD1-DD4 data regression. |
| `logicprobe_concurrency_scan` | Mines concurrency risk claims (thread-safe, lock-free, race condition, mutex) and flags them for dedicated verification. |
| `logicprobe_compose_verify` | Composition verification of two or more machines (rendezvous handshake semantics): C1 composition deadlock, C2 rendezvous never fires. |
| `logicprobe_export` | Exports external-tool input: UPPAAL (`.xta` + queries), TLA+ (TLC module), PRISM (DTMC `.pm` + `.pctl`), SPIN (Promela + ltl). |
| `logicprobe_uml` | Models a code flow as UML and reviews the modelling. See "UML modelling and review" below. |
| `logicprobe_structure_verify` | Audits a component/package/class/deployment diagram as a **dependency graph** (UML020-UML026): isolated nodes, dangling endpoints, dependency cycles, edges that violate an allowed-dependency matrix, upward cross-layer edges, and required edges the diagram is missing — every judged edge names the rule ids it matched. It audits the diagram; reconcile it with a source-side include scan. |
| `logicprobe_report_diff` | Compares two reports of the same family (baseline vs current) and reports the added, removed and changed findings with a **delta** verdict. Findings are matched by `check id + code + machine-readable locator (evidence/path)`, so a reworded message only counts as `changed`; a newly added error fails it, while `currentVerdict` keeps the run's absolute result visible. The "violations must not increase" criterion, computed instead of eyeballed. |

Transition `cost` (default 1) plus a `budget` invariant makes A12 check the worst-case path cost. A reachable cycle with positive cost counts as unbounded. Transition `weight` (default 1) plus a `probability` invariant makes A13 compute probability reachability. State `onEntry`/`onExit` actions enter A4 pair symmetry automatically, and `maxTicks` plus `tickEvents` drive the A14 deadline check.

### How to read a report (`ok` is not a verdict)

Every report separates "the tool ran" from "the review passed":

| Field | Meaning |
|-------|---------|
| `schema` | The versioned report contract (`logicprobe/verify/v1`, `logicprobe/uml/review/v1`, …) — branch on it instead of sniffing fields. |
| `ok` | The engine produced a report. For `verify` it is `false` only when model *validation* failed. It is **not** a verdict. |
| `ran` | The tool executed. `false` only for a tool-level refusal (which carries `errorCode`/`error`). |
| `verdict` | `pass` / `pass_with_findings` / `fail`. Any `severity: "error"` finding — or a validation failure — makes it `fail`. |
| `verdictReason` | One line, e.g. `1 error finding(s) (first: S2_NO_TRANSITIONS)`. |
| `hashSpec` | The published specification `modelHash` follows — see [`hash-spec.md`](skills/logicprobe/references/hash-spec.md). |
| `hashes` | Every hash the report carries, in one place (model, diagram/matrix, before/after). |
| `metadataKeys` | Paths of the `_`-prefixed annotation keys the input carried. |
| `narrativeCoverage` | `{states: "5/5", events: "3/9", scenarios: "0/12"}` — a narrative may cover part of the model, and this is how much is still undocumented. The gap is also a `NARRATIVE_PARTIAL` (info) finding, so a gate need not parse `nextSteps` text. |
| `nextSteps` | What to do next, derived from the findings; never empty, and identical for two runs over the same input. |

Reading `ok` turns a model with a deadlock into a pass; the verdict is the judgement. The non-DSH Python CLI follows the verdict with its exit code: `pass`/`pass_with_findings` → `0`, `fail` or a refusal → `2`.

### The model carries its own archive record (`_`-prefixed keys)

Any key starting with `_` — at any level: `_source`, `_verified`, `_extraction_caveats`, `states[0]._note` — is **annotation metadata**: the schema skips it, `modelHash` excludes it, and the report echoes it as `metadataKeys`. Provenance and verification snapshots can therefore live inside the model file instead of a sidecar that drifts away from it, without changing the model's hash identity. Every other key stays closed: a mistyped `sttes` is still an error. `verify model.json --hash-check <hex>` answers whether a recorded hash belongs to any published specification.

Install (native bundle, recommended):

```bash
# from npm (package name: dsh-logicprobe)
dsh plugin --profile web add dsh-logicprobe
# or from GitHub source
dsh plugin --profile web add "github:AmethystLuna/logicprobe"
# when dsh is not installed globally
npx -p @deepseek-ai/dsh dsh plugin --profile web add dsh-logicprobe
```

Restart the profile afterwards. `dsh --profile web --dump-config` must show the `id: logicprobe` row with `enabled: true`. More options (plain skill copy, project-level install) are in [`.dsh/INSTALL.md`](.dsh/INSTALL.md).

pnpm 11 has a release-age gate. It holds back versions published less than a day ago (`minimumReleaseAge`, default 1440 minutes), and its default is non-strict, so a bare-name install **silently resolves to the previous version**. The profile then looks like the release never happened. To get the newest version within about 24 hours of a release, pin it:

```bash
dsh plugin --profile web add dsh-logicprobe@<version>
```

pnpm records that version in a `minimumReleaseAgeExclude` entry in the profile's `pnpm-workspace.yaml`. That entry is pnpm's documented escape hatch.

> Package name note: the npm package is `dsh-logicprobe`, with no scope. In the web profile's `package.json`, both the dependency key and the `dsh.profile.bundles` entry must use that name. On a mismatch the dsh loader cannot find `node_modules/dsh-logicprobe` and the boot fails.

## UML Modelling and Review

`logicprobe_uml` draws a LogicModelV1 as UML. It also reads a hand-drawn UML diagram back into a model, reviews the modelling itself, and prints the label and comment conventions the parser accepts. It has four actions:

- **render**: model to diagram. Mermaid covers state, activity flowchart and sequence views. PlantUML covers state and sequence. Any construct the notation cannot express becomes a warning instead of a silent drop. PlantUML activity is refused, because that syntax cannot carry a graph with merges or cycles faithfully.
- **parse**: diagram to model. It reads Mermaid and PlantUML state or activity diagrams, so a hand-drawn diagram can go straight into `logicprobe_verify`. Two inputs are refused because they cannot become a machine: a sequence diagram (a trace cannot reconstruct a machine), and any other Mermaid family (`classDiagram`, `erDiagram`, `gantt`, `mindmap`, …), which comes back as `errorCode: "UML_NOT_A_STATE_DIAGRAM"` naming the family.
- **review**: audits the modelling. It reports structural defects and documentation gaps. The structural defects are unreachable states, dead ends, ambiguous branches, self-loops with no exit, and duplicate transitions. The documentation gaps are a missing narrative, unbounded variables, states a reader cannot map back to code, and label drift between diagram and narrative. It also runs the fidelity check: it parses the diagram back into a model and reports every structural difference.
- **explain-labels**: prints the label spellings and ignored-line rules the parser applies (`directiveLines`, `acceptedLabelForms`, `renderedForm`, `ignoredLines`, `rules`), with no diagram needed. Reach for it when a hand-drawn diagram and a rendered one disagree; the CLI mirror is `uml-review --explain-labels`.

**A structure diagram is the dangerous case, because it parses.** A PlantUML component, package, class or deployment diagram declares no diagram kind, so the parser meets its keywords line by line. The arrows look like transitions, so `parse` returns a by-product model — now together with an error finding `UML_NOT_A_STATE_DIAGRAM`, `discardedConstructs` (every declaration it could not represent, with line and text), `discardedEdges` (the arrows misread as transitions) and `verdict: "fail"`. Read that as: **this file has no model and this diagram was not reviewed.** Do not feed the by-product to `logicprobe_verify` and call the result an architecture review. Structural checks over a real dependency graph (allowed-edge matrices, cycles, isolated nodes) do not exist yet; the codes `UML020`+ are reserved for them.

Fidelity is the core of the feature. Generated diagrams carry `logicprobe:` comment directives for the initial state, the terminal states, aliases and variable kinds. Mermaid and PlantUML ignore those lines; the parser reads them. That is what makes the diagram-versus-model comparison exact.

The review covers the modelling, never the behaviour. Every finding names the engine check that settles the behavioural half. The verdict — not `ok` — says whether the review passed: `fail` means error findings exist and the diagram did **not** pass. The full list (`UML001`-`UML019` plus `UML_NOT_A_STATE_DIAGRAM`), the directive format, a worked example and the limits of each view are in [`skills/logicprobe/references/uml-modeling-guide.md`](skills/logicprobe/references/uml-modeling-guide.md).

## Architecture and Dependency Review

A component diagram is not a state machine; it is a directed **dependency graph**. `logicprobe_structure_verify` parses the same PlantUML component/package/class/deployment text (or a Mermaid class diagram) into real nodes and edges — nothing is discarded — and checks it:

| Check | Severity | Meaning |
|---|---|---|
| `UML020_ISOLATED_NODE` | warning | A declared, non-container node with no edge: a dead entry, or a dependency the diagram forgot |
| `UML021_DANGLING_REFERENCE` | error | An arrow endpoint never declared — a dependency on a component that does not exist |
| `UML022_CYCLE` | error | A directed cycle, reported as the **shortest** cycle path; a cycle means no build order and no layering |
| `UML023_DISALLOWED_EDGE` | error | An edge that violates the allowed-dependency matrix (with `default: deny`, any edge no rule permits) |
| `UML024_LAYER_VIOLATION` | error | An upward edge between declared layers (downward is allowed, upward is not) |
| `UML025_MISSING_EXPECTED_EDGE` | warning | A `require: true` edge the diagram does not draw: the matrix and the diagram disagree |

**Multi-level**: the same set can be supplied by level — `diagrams: [{name, diagram, parent}]`. Each level runs the structural checks above (findings tagged with the `file` they came from), then every declared pair is checked for **refinement**: a child must not invent a dependency between nodes its parent also has, and must not drop a parent edge without expanding it into a path (expansions are listed in `expandedEdges` for a reviewer to confirm). A cyclic parent relation is `UML030`, an unknown parent `UML028`, an empty set `UML031`. Each pair reports its node/edge/inherited/new/expanded/missing/invented counts (`pairs[]`), and every level is hashed (`hashes.diagrams`), so a baseline diff can tell which level moved. Commands: `structure diagram.puml` for one diagram, `granularity manifest.json` for several levels.

The dependency matrix is the single source of truth:

```json
{
  "rules": [
    { "id": "R1-app-may-use-hal", "source": "app.*", "allow": ["hal.*"], "deny": ["hal.internal"] },
    { "id": "R4-persistence-required", "source": "PAY", "allow": ["DB"], "require": true }
  ],
  "layers": [{ "name": "app", "members": ["SVC", "PAY"] }, { "name": "hal", "members": ["DRV", "DB"] }],
  "default": "deny"
}
```

`source`, `allow`, `deny` and `members` accept globs (`*`, `?`); **`deny` wins globally**, so the result never depends on rule order; an invalid matrix (typo'd key, duplicate rule id, `require` without `allow`) is a hard `MATRIX_INVALID` error rather than a silently weaker check. Every edge is echoed in `edgeVerdicts` as `{from, to, matchedRules, allowed, basis}`.

**What it does not do, stated plainly**: write-site analysis ("only the ISR writes this flag", "one writer per register") is **out of scope** — it needs the source and statement-level rules, not a model or a diagram. `logicprobe_concurrency_scan` marks such a claim unverified and routes it to a source-side check (your own include/arch checker, a static analyzer, or CBMC).

**It audits the diagram, not the code.** Function pointers, DI, registries and plugin loading never appear as edges; a clean `pass` only means the drawn graph is self-consistent and satisfies the matrix. The step that touches the source is the **reconciliation**: run a source-side include/dependency scan (your own include or dependency checker, for instance) with the same rule ids and classify every difference — the diagram is stale (`UML025` when the rule is `require: true`), the diagram is aspirational or the scan scope is narrower, the code violates a rule the diagram never showed (**the architecture defect the diagram hid** — the one worth acting on), or both agree it is a violation. The full matrix schema, a worked example and the reconciliation table are in [`skills/logicprobe-structure/references/structure-review-guide.md`](skills/logicprobe-structure/references/structure-review-guide.md).

## Usage

The plugin injects a capability notification into the first model step. There is **one skill per domain** — four in total. `logicprobe` is the entry point: load it whenever you have any thought of checking whether something about the code is true, and its routing table hands a neighbouring domain on.

| Skill | Domain | Typical trigger |
|---|---|---|
| `logicprobe` | Claim verification plus behavioural verification (state machines and protocols, timing and quantitative guarantees, composition, refactoring regression) | "Review this design document", "could this state machine deadlock", "is this retry limit safe", "is this budget enough" |
| `logicprobe-uml` | Diagram modelling and diagram review | "draw this state machine", "is this UML diagram right", "can this component diagram be reviewed as a state machine" |
| `logicprobe-structure` | Architecture and dependency-structure review | "review this architecture", "are the module dependencies sound", "is the layering right" |
| `logicprobe-concurrency` | Concurrency claims: mined and routed, never proven | "is this thread-safe", "can this ISR race" |
| `logicprobe-datamodel` | Data models, migrations and data invariants | "is this migration non-breaking", "does this copy cover every field" |

Behavioural questions still follow the suggest-don't-escalate rule: offer an optional verification pass and let the user decide. The skill classifies depth (LIGHTWEIGHT / STANDARD / ESCALATED) from plan features in Phase 0, and appends a `## Plan Verification` summary block as the audit trail.

Outside dsh (Claude Code, Cursor, Codex, a terminal, CI) the install is the **repository** (marketplace or git), which carries `tools/python/logicprobe-engine.py`. Python 3.8+ standard library only. The dsh bundle (npm or profile install) does not include it. With a LogicModelV1 JSON at hand, run it directly:

- `verify` runs S1-S8 / A1-A14 / D1-D4
- `compose` runs the C1 / C2 composition
- `export` emits UPPAAL, TLA+, PRISM and SPIN input
- `uml-render`, `uml-parse` and `uml-review` cover the UML front end (`uml-review --explain-labels` prints the label and comment conventions the parser accepts)

Its output is byte-identical to the dsh tools, cross-checked by `tests/python/run.mjs`. When the model exists only as extracted tables, fill in `tools/python/verification-harness.py`. Data-model checks use `tools/python/data-model-harness.py`. When Python is unavailable, for example on an air-gapped machine, the matching guide describes a manual verification mode.

Sample models live under [`examples/`](examples/README.md): an order state machine before/after, an e-commerce data model, and a User field migration.

## Codex CLI

This plugin also supports OpenAI Codex CLI. Skills follow the Agent Skills standard and work identically on both platforms.

### Codex install

```bash
# Add as a marketplace
codex plugin marketplace add AmethystLuna/logicprobe

# Install
codex plugin install logicprobe
```

Or manually:

```bash
git clone https://github.com/AmethystLuna/logicprobe.git ~/.codex/plugins/logicprobe
```

Skills are invoked with `$logicprobe`, or selected automatically by Codex from the task context.

## Cursor

Cursor 2.5+ has built-in plugin support.

### Cursor install

```bash
# Clone to Cursor plugins directory
git clone https://github.com/AmethystLuna/logicprobe.git ~/.cursor/plugins/logicprobe
```

Or install from the Cursor plugin marketplace UI: `/add-plugin AmethystLuna/logicprobe`

## Kimi CLI

Kimi CLI discovers skills from `.claude/skills/` paths automatically. The `.kimi-plugin/plugin.json` manifest registers the plugin for Kimi's plugin manager.

### Kimi install

```bash
# Via Kimi plugin manager
/plugins install https://github.com/AmethystLuna/logicprobe.git

# Or clone manually
git clone https://github.com/AmethystLuna/logicprobe.git ~/.kimi/plugins/logicprobe
```

Skills are invoked with `/skill:logicprobe`.

## OpenCode

Skills are auto-discovered from `.claude/skills/` and `.codex/skills/` paths. Add this to your `opencode.json`:

```json
{
  "plugin": ["logicprobe@git+https://github.com/AmethystLuna/logicprobe.git"]
}
```

Or install through `skop`, which consumes the Claude marketplace manifest. See `.opencode/INSTALL.md`.

## ZCode (Z.AI)

ZCode 3.0+ follows the Agent Skills standard. It has no plugin marketplace, so copy the skills yourself:

```bash
git clone https://github.com/AmethystLuna/logicprobe.git
cp -r logicprobe/skills/* .zcode/skills/
```

Skills are invoked with `$logicprobe`. See `.zcode/INSTALL.md`.

## Requirements

- Host: Claude Code v2.1+ / Codex CLI latest / Cursor 2.5+ / Kimi CLI latest / OpenCode latest / ZCode 3.0+
- DeepSeek Harness (dsh): dev preview, declared support for `>= 0.1.0-rc.7`. The latest round measured install, mount, boot and uninstall on 0.2.1-alpha.1. The earlier round measured 0.1.5-rc.2 through 0.2.0-rc.2. Per-release evidence is in [DSH-COMPATIBILITY.md](DSH-COMPATIBILITY.md).
- The Web Plugins-page "Gate injection" switch requires **dsh ≥ 0.1.7-alpha.1**, because its settings service must be able to project live fields. On older dsh the plugin still loads and still injects. The switch is simply absent, with no error.
- Python 3.8+ (standard library), needed to run the checks outside dsh. The manual mode needs no dependencies.

## Configuration

In DeepSeek Harness the bundle accepts a small configuration object:

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Set to `false` to disable the session-start gate injection. |
| `gateContent` | string | built-in gate text | Override the text injected into the first model step. |
| `interaction` | `ask` \| `auto` \| `follow-approval` | `follow-approval` | Model-confirmation policy. `follow-approval` resolves to `auto` when the session approval policy is `never`. |

The switch is editable live in the dsh Web GUI: sidebar **Plugins** → this plugin's card → "Gate injection". It takes effect without a profile restart, and it controls only the injected text. Turning it off leaves the skills and the verification tools registered. The same card also carries a coarser row switch: turning that one off unmounts the whole row, so the skills, the tools and this switch all disappear. Persistent overrides still go through the profile patch below.

To override the row by id, edit your profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: logicprobe
      name: 'dsh-logicprobe'
      config:
        enabled: true
        interaction: follow-approval
        gateContent: |
          ...
```

## Uninstall

- If you installed through the DSH plugin manager, remove the `logicprobe` plugin from the target profile with the same manager.
- If you copied `skills/*` manually, delete the copied skill directories from `~/.agents/skills/` or the project's `.dsh/skills/`.
- If you added the bundle as a `cordis.patch.yml` row, remove the row with `id: logicprobe` from the profile patch and restart DSH.

## Permissions & Data

- The plugin runtime reads only the `skills/` directory shipped inside the package, in order to register skills through DSH's standard filesystem skill provider.
- It injects the configured gate text into the first model step of a session.
- It does not read credentials, open network connections, or touch user data outside the DSH session context.
- When the skill is actually used, the model may read project files as directed by the user, just like any other coding skill.

## Troubleshooting

- Skill not visible in DSH: confirm the DSH version supports `ctx.skills` and Agent Skills discovery, then restart the profile.
- Gate not injected: check that `enabled` is not `false`, and that the row id `logicprobe` is present in the active profile patch.
- `logicprobe_verify` not visible: check `cordis_inspect_query` status for `toolRegistered: true`, and confirm the profile resolved the `@deepseek-ai/dsh-tools` peer dependency.
- Plugin manager rejects the installation: make sure the `@deepseek-ai/*` packages are declared as `peerDependencies`, not as regular `dependencies`.
- After a manual copy DSH still does not see the skill: install the native bundle instead (`dsh plugin add "github:AmethystLuna/logicprobe"`).

## Development

```bash
npm install
npm run typecheck
npm run build
```

Test chain:

| Command | What it covers |
|---|---|
| `npm run test:engine` | State-machine and data-model engine regression (`tests/engine`, `tests/data-engine`, `tests/concurrency`, `tests/uml`, `tests/apply-smoke`, `tests/dsh-client-half`, `tests/exporters`, `tests/external`), plus byte-for-byte Python parity. The parity script `tests/python/run.mjs` compares the same fixtures between the TS engine and `tools/python/logicprobe-engine.py` across reports, composition and exporter output. It SKIPs when Python is absent. |
| `npm run test:full` | `tests/full-suite.mjs` combined end-to-end suite |
| `npm run test:python` | Python parity only (build + `tests/python/run.mjs`) |
| `bash tests/skill-triggering/run-all.sh` | Trigger tests under `tests/skill-triggering/` |

## License & Security

Licensed under MIT. See [LICENSE](LICENSE).

To report a security vulnerability, do **not** open a public issue. Use the private Security Advisory path or the contact method in [SECURITY.md](SECURITY.md).

## Related Plugins

| Plugin | Description |
|--------|-------------|
| [embedded-workbench](https://github.com/AmethystLuna/embedded-workbench) | Embedded C/C++ toolbox whose Plan Verification Gate uses this skill. This plugin was split out of embedded-workbench. |

## Acknowledgments

The claim-verification methodology (logic primitives, adversarial probing, refactoring before/after comparison) and the trigger test framework (`tests/skill-triggering/`) follow the conventions of [Superpowers](https://github.com/obra/superpowers) by Jesse Vincent (MIT License), as adapted in the [embedded-workbench](https://github.com/AmethystLuna/embedded-workbench) plugin.
