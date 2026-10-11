# AGENTS.md

Agent and contributor guide for the Logic Probe plugin. This file is the single
source. `CLAUDE.md` only points here, because Claude Code looks for that name by
convention.

## Writing Rules

These apply to every file this repository ships, injects or publishes, and to the
text of a store entry. They come from the review that produced the current text.

- **Short sentences, one idea each.** The reader does not have the author's
  context. A sentence that needs a second clause to make sense should be two.
- **No brittle counts.** Never write how many tools, checks, skills or probes
  exist. A release changes the number and the sentence silently becomes wrong.
  Name the thing instead. Counts belong in the report contract, where a test
  holds them.
- **One job per file.** Injected text is a guide to calling the tools. A
  `SKILL.md` carries doctrine and routing. `references/*.md` carries per-domain
  detail. The README tells the human story. Manifests describe capability.
  `DSH-COMPATIBILITY.md` holds measured evidence. State a fact in one place and
  point at it from everywhere else.
- **No dangling pointers.** Every path, flag, tool and skill a file names must
  exist and be reachable from that file. Paths resolve from where the reader
  runs: a session's working directory is the user's project, not this plugin.
- **Spend the budget.** Injected text is paid once per session, mode context once
  per turn, tool descriptions once per request. Keep the top level lean and put
  detail behind a pointer.
- **Say what it does not prove.** Every scope claim needs its non-goal beside it,
  plus the route to whatever does cover that ground. No silent implication of
  coverage.
- **Injection carries the gate, not the enforcement scaffolding.** The payload is
  the verification gate: what the plugin checks, the routing to the skills, the
  tool list, how to read a report, and the nudge for the unsure case. The 1% Rule
  and the Red Flags table live in the `logicprobe` skill body, where a session that
  needs discipline can load them. Capable models follow enforcement lines
  literally, so those lines do not belong in every session's context. Do not put
  them back.
- **Descriptions stay factual.** Store and manifest descriptions state what the
  plugin does. Slogans live in the README and the injected text, never in an entry
  description.
- **Bilingual pairs move together.** A Chinese document and its English
  counterpart change in the same commit.

## Acknowledgments

This plugin's claim-verification methodology (claim enumeration, logic primitives,
adversarial probing, refactoring before/after comparison) and the trigger test
framework (`tests/skill-triggering/`) follow the conventions of
[Superpowers](https://github.com/obra/superpowers) by Jesse Vincent (MIT License),
as adapted in the [embedded-workbench](https://github.com/AmethystLuna/embedded-workbench)
plugin. This plugin was split out of embedded-workbench v0.6.0.

## DSH Plugin Conventions

- **Compatibility is measured, never assumed.** `dsh.compatibility.dshReleases`
  gains `compatible` for a release only after a round on it: install, mount, the
  offline checks, uninstall. Dependabot is restricted to devDependencies for that
  reason. A peer range is a claim, and automation must not widen it.
- **The dsh bundle depends on Node only**, so nothing Python ships in the
  package. The non-dsh side is the subject of Two-Sided Alignment below.
- **A client bundle does not load Harness Client packages.** Vendor the control,
  give its classes a plugin prefix, and use the host's design tokens only. A
  plain-JS bundle gets no type check, and a throw blanks the whole slot entry.
- **The injected gate** is appended once per session through the history guard in
  `src/index.ts`. The Claude-side hook resolves the engine path from its own
  location, so the injected text never asks a model to guess a relative path.

## Two-Sided Alignment

Every capability is answered on both sides: dsh and non-dsh, Node and Python. A
feature is not done on one side only.

- **A dsh capability needs a non-dsh answer in the same change.** Either a mirror
  subcommand, or a statement in that skill that hosts without the tools fall back
  to a harness template or to manual mode. Silence is the failure: a non-dsh
  reader then assumes coverage that does not exist.
- **Where a mirror exists, the reports are byte-identical.** `tests/python/run.mjs`
  is the authority on which surfaces are mirrored and what parity means there.
  Keep it green; it skips only when no interpreter is on PATH.
- **The mirror is code, not prose.** A change to the Node engine's semantics is a
  change to `tools/python/logicprobe-engine.py`. Never document a check on one
  side and implement it only on the other.
- **Read the surfaces from the code.** `logicprobe-engine.py --help` lists the
  subcommands, and the registrations under `src/` list the dsh tools. Neither
  list is repeated here, because a list in a document goes stale.
- **Two capabilities are dsh-only on purpose.** Data-model verification and the
  concurrency claim scan have no mirror subcommand: non-dsh hosts take the data
  harness or manual mode, and the concurrency skill routes claims to external
  tools. Keep those statements true wherever the skills describe them.
- **Nothing Python ships, and Python is not a fallback.** The package stays
  Node-only. The mirror and the harnesses under `tools/` are the native non-dsh
  path, so their dependencies stay at the standard library — an interpreter is
  the whole requirement, matching the repository's other tooling.

## PR Requirements

- All PRs must pass `markdownlint` with the project's `.markdownlint.json` config.
- The skill must follow the established frontmatter format: `name` (kebab-case),
  `description` ("Use when..." format).
- Skill content must remain **domain-neutral** — this plugin is not
  embedded-specific. Do not hardcode project-specific details (file paths, version
  numbers, product names).
- Chinese content should have English equivalents and vice versa (README,
  session-start content).
- The verification harness (`tools/python/verification-harness.py`) must remain
  generic — it is a template filled in per model, never hardcoded to one project.
- The standalone JSON engine (`tools/python/logicprobe-engine.py`) is the non-DSH
  mirror of the TypeScript engine and exporters: any change to `src/engine.ts` or
  `src/exporters.ts` semantics must be reflected there, and `tests/python/run.mjs`
  (byte-for-byte parity across fixtures, exporters, composition, and before/after
  regression) must stay green — skip only when Python is absent from PATH.
- Model extraction must require user confirmation before running the harness (the
  #1 failure mode of verification) — except when the runtime reports
  `logicprobe interaction=auto`; in auto mode require evidence-cited extraction
  plus round-trip validation and an `UNCONFIRMED` label.

## Before Submitting

- Run `markdownlint` on all changed files.
- Run `npm run test:engine` before pushing. It is the aggregate gate, so a new
  test file is not part of the suite until that script runs it.
- Verify `plugin.json` passes `claude plugin validate`.
- Test the plugin locally by installing to `~/.claude/plugins/dev/`.
- Bump the version with the release tool: `npm run bump -- <new-version>`
  (syncs every declared manifest — `package.json`, `package-lock.json` ×2, all
  plugin manifests, `.version-bump.json` — plus `DSH-COMPATIBILITY.md`;
  `npm run bump -- --check` and `npm run bump -- --audit` must pass).

## CI Workflows (GitHub Actions)

- `dsh-bundle` — on push/PR touching `src/`, `tests/`, `skills/`, `AGENTS.md`,
  `lib/`, `cordis.patch.yml`, `package.json`, `package-lock.json`, docs, or the
  workflow itself: `npm ci --legacy-peer-deps`, typecheck, build, engine
  regression fixtures, committed-`lib/` drift guard, and markdownlint.
- `Plugin Security Scan` — on every push/PR: `hashgraph-online/ai-plugin-scanner-action`
  on the repo root; fails on high-severity findings.

## Release Workflow (pre-release checklist)

The full checklist is in `RELEASE.md`; the short version:

- **Version policy**: patch for fixes/docs/deps/CI, minor for new features, major
  for breaking changes. Never bump "just because something changed".
- **Bump**: `npm run bump -- <new-version>`, then `npm run bump -- --check` and
  `npm run bump -- --audit` must pass.
- **Lint**: `npx markdownlint-cli --ignore "**/node_modules/**" .` passes.
- **Bundle**: `npm ci && npm run typecheck && npm run build && git diff --exit-code -- lib`.
- **Local mount**: `dsh plugin --profile scratch add "file:$PWD"` and
  `--dump-config` shows the row.
- **Ship**: push → CI green → `npm publish` → verify the published artifact on a
  scratch `DSH_HOME` → tag `vX.Y.Z` and push tags.
- **Tags move only on explicit instruction.** Moving a published tag is a force
  push; say so before doing it, and never move one to carry an unrelated change.

## Plugin Store Compliance Checklist

Concrete requirements that must stay true for this plugin's store entries (merged
from the store forks this plugin is listed in):

- [ ] `package.json` declares `dsh.bundle.patch` — a manifest with only
  `dsh.client` is not installable and gets rejected.
- [ ] Package name uses a namespace you control; never `@deepseek-ai/*` (official
  packages appear only as `peerDependencies`).
- [ ] Official `@deepseek-ai/*` packages are `peerDependencies` with explicit
  prerelease `||` branches; every runtime dependency is declared.
- [ ] Repo is public, carries the `dsh-plugin` topic, is at least 1 day old with
  ≥10 commits, and is actively maintained.
- [ ] Entry description is accurate and functional — no superlatives or
  marketing; any counts, API names, or commands it names actually exist.
- [ ] Category matches what the plugin does (`skill` for both plugins).
- [ ] Entry metadata matches the repo: exact GitHub URL/name, `version` matches
  the manifest at the pinned commit, `entryIds` match the bundle patch.
- [ ] Lifecycle scripts (`preinstall`/`install`/`postinstall`/`prepare`) are
  declared and disclosed; no surprising install-time behavior.
- [ ] Never disable, replace, or duplicate `@deepseek-ai/*` official components;
  never modify DSH core.
- [ ] No hardcoded secrets, credential exfiltration, destructive commands, miner
  patterns, or obfuscated source.
- [ ] `dsh.compatibility.dshReleases` declares per-release `compatible` or
  `unknown`; an approved entry keeps a precise `compatible` for at least one of
  the latest three DSH releases; version bumps reset old-version evidence.
- [ ] Storefront Chinese fields: `name` uses `中文名（English Name）`, description
  includes a Chinese purpose, `searchTerms` includes Chinese aliases.
- [ ] README covers overview, compatibility, install/uninstall, quick start,
  configuration, permissions & data, troubleshooting, development, and
  license/security.
- [ ] Entry updates touch only your own entry; generated READMEs are regenerated,
  never hand-edited.
