# CLAUDE.md

Contributor guidelines for the Logic Probe plugin.

## Acknowledgments

This plugin's claim-verification methodology (claim enumeration, logic primitives, adversarial probing, refactoring before/after comparison) and the trigger test framework (`tests/skill-triggering/`) follow the conventions of [Superpowers](https://github.com/obra/superpowers) by Jesse Vincent (MIT License), as adapted in the [embedded-workbench](https://github.com/AmethystLuna/embedded-workbench) plugin. This plugin was split out of embedded-workbench v0.6.0.

## PR Requirements

- All PRs must pass `markdownlint` with the project's `.markdownlint.json` config.
- The skill must follow the established frontmatter format: `name` (kebab-case), `description` ("Use when..." format).
- Skill content must remain **domain-neutral** — this plugin is not embedded-specific. Do not hardcode project-specific details (file paths, version numbers, product names).
- Chinese content should have English equivalents and vice versa (README, session-start content).
- The verification harness (`references/verification-harness.py`) must remain generic — it is a template filled in per model, never hardcoded to one project.
- The standalone JSON engine (`references/logicprobe-engine.py`) is the non-DSH mirror of the TypeScript engine and exporters: any change to `src/engine.ts` or `src/exporters.ts` semantics must be reflected there, and `tests/python/run.mjs` (byte-for-byte parity across fixtures, exporters, composition, and before/after regression) must stay green — skip only when Python is absent from PATH.
- Model extraction must require user confirmation before running the harness (the #1 failure mode of verification) — except when the runtime reports `logicprobe interaction=auto`; in auto mode require evidence-cited extraction plus round-trip validation and an `UNCONFIRMED` label.

## Before Submitting

- Run `markdownlint` on all changed files.
- Verify `plugin.json` passes `claude plugin validate`.
- Test the plugin locally by installing to `~/.claude/plugins/dev/`.
- Bump the version with the release tool: `npm run bump -- <new-version>`
  (syncs every declared manifest — `package.json`, `package-lock.json` ×2,
  all plugin manifests, `.version-bump.json` — plus `DSH-COMPATIBILITY.md`;
  `npm run bump -- --check` and `npm run bump -- --audit` must pass).

## CI Workflows (GitHub Actions)

- `dsh-bundle` — on push/PR touching `src/`, `tests/`, `skills/`, `CLAUDE.md`,
  `lib/`, `cordis.patch.yml`, `package.json`, `package-lock.json`, docs, or the
  workflow itself: `npm ci --legacy-peer-deps`, typecheck, build, engine
  regression fixtures, committed-`lib/` drift guard, and markdownlint.
- `Plugin Security Scan` — on every push/PR: `hashgraph-online/ai-plugin-scanner-action`
  on the repo root; fails on high-severity findings.

## Release Workflow (pre-release checklist)

The full checklist is in `RELEASE.md`; the short version:

- **Version policy**: patch for fixes/docs/deps/CI, minor for new features,
  major for breaking changes. Never bump "just because something changed".
- **Bump**: `npm run bump -- <new-version>`, then `npm run bump -- --check`
  and `npm run bump -- --audit` must pass.
- **Lint**: `npx markdownlint-cli --ignore "**/node_modules/**" .` passes.
- **Bundle**: `npm ci && npm run typecheck && npm run build && git diff --exit-code -- lib`.
- **Local mount**: `dsh plugin --profile scratch add "file:$PWD"` and
  `--dump-config` shows the row.
- **Ship**: push → CI green → optional `npm publish` → real-profile trial →
  tag `vX.Y.Z` and push tags.

## Plugin Store Compliance Checklist

Concrete requirements that must stay true for this plugin's store entries
(merged from the store forks this plugin is listed in):

- [ ] `package.json` declares `dsh.bundle.patch` — a manifest with only
  `dsh.client` is not installable and gets rejected.
- [ ] Package name uses a namespace you control; never `@deepseek-ai/*`
  (official packages appear only as `peerDependencies`).
- [ ] Official `@deepseek-ai/*` packages are `peerDependencies` with explicit
  prerelease `||` branches; every runtime dependency is declared.
- [ ] Repo is public, carries the `dsh-plugin` topic, is at least 1 day old
  with ≥10 commits, and is actively maintained.
- [ ] Entry description is accurate and functional — no superlatives or
  marketing; any counts, API names, or commands it names actually exist.
- [ ] Category matches what the plugin does (`skill` for both plugins).
- [ ] Entry metadata matches the repo: exact GitHub URL/name, `version` matches
  the manifest at the pinned commit, `entryIds` match the bundle patch.
- [ ] Lifecycle scripts (`preinstall`/`install`/`postinstall`/`prepare`) are
  declared and disclosed; no surprising install-time behavior.
- [ ] Never disable, replace, or duplicate `@deepseek-ai/*` official
  components; never modify DSH core.
- [ ] No hardcoded secrets, credential exfiltration, destructive commands,
  miner patterns, or obfuscated source.
- [ ] `dsh.compatibility.dshReleases` declares per-release `compatible` or
  `unknown`; an approved entry keeps a precise `compatible` for at least one of
  the latest three DSH releases; version bumps reset old-version evidence.
- [ ] Storefront Chinese fields: `name` uses `中文名（English Name）`,
  description includes a Chinese purpose, `searchTerms` includes Chinese
  aliases.
- [ ] README covers overview, compatibility, install/uninstall, quick start,
  configuration, permissions & data, troubleshooting, development, and
  license/security.
- [ ] Entry updates touch only your own entry; generated READMEs are
  regenerated, never hand-edited.
