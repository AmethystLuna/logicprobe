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
- Model extraction must require user confirmation before running the harness (the #1 failure mode of verification) — except when the runtime reports `logicprobe interaction=auto`; in auto mode require evidence-cited extraction plus round-trip validation and an `UNCONFIRMED` label.

## Before Submitting

- Run `markdownlint` on all changed files.
- Verify `plugin.json` passes `claude plugin validate`.
- Test the plugin locally by installing to `~/.claude/plugins/dev/`.
- Bump the version in all manifests listed in `.version-bump.json` (keep them in sync).
