# Logic Probe

<p align="center"><strong>English</strong> · <a href="README.md">中文</a></p>

[![HOL Guard Scanner](https://img.shields.io/badge/HOL%20Guard-passing-00a67e)](https://github.com/hashgraph-online/hol-guard)

Design documents are not truth — code is. A claim-verification skill that checks every verifiable claim in design docs, architecture specs, and refactoring plans against the actual codebase — and escalates to executable-model verification for behavioral claims.

**Cross-platform** — works with Claude Code, Codex CLI, Cursor, Kimi CLI, OpenCode, and ZCode. Built on the [Agent Skills](https://agentskills.io) open standard.

## What It Does

| Phase | What |
|-------|------|
| Phase 1-2 | Enumerate every verifiable claim (API names, file paths, enum values, counts, mechanism feasibility) → verify each against the codebase with evidence |
| Phase 2a | **7 structural checks** on extracted state-machine models: reachability, deadlock, liveness, determinism, event/guard completeness, invariant validity |
| Phase 2b | **7 adversarial probes**: unexpected events, race interleaving, order permutation, pair symmetry (lock/unlock), boundary blast, resource injection, minimal counter-example |
| Refactoring | Before/after model comparison — behavioral preservation, invariant continuity, deadlock regression, complexity claims |
| Output | Structured findings with exact file:line evidence, severity classification, correction direction — never inline fixes |

The model is always shown as a transition table and **confirmed with the user before running** — extraction errors are the dominant failure mode.

## Installation

### Marketplace install (recommended)

Add the marketplace to `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "logicprobe": {
      "source": { "source": "github", "repo": "AmethystLuna/logicprobe" }
    }
  }
}
```

Then install from CLI:

```bash
claude plugin install logicprobe@logicprobe
```

### Manual install

```bash
git clone https://github.com/AmethystLuna/logicprobe.git ~/.claude/plugins/dev/logicprobe
```

Then enable in `~/.claude/settings.json`:

```json
{
  "enabledPlugins": {
    "logicprobe@dev": true
  }
}
```

## DeepSeek Harness (dsh)

Native dsh support ships as a cordis plugin bundle at the repository root (the root `package.json` declares `dsh.bundle`):

- The skill is discovered as-is by dsh's `skill-filesystem` provider (Agent Skills open standard) — zero code.
- The bundle injects the claim-verification gate (1% Rule / Red Flags / proactive suggestion) into the first model step of every agent session — the dsh-native counterpart of the Claude `SessionStart` hook. It also registers a model-visible catalog entry (`cordis_inspect`), a native `logicprobe_verify` tool (`ctx.tools`), and a policy-aware `logicprobe:mode` context (`ctx.systemPrompt`).
- Together with the embedded-workbench bundle's Plan Verification Gate, this closes the claim-verification loop in dsh.

Install: see [`.dsh/INSTALL.md`](.dsh/INSTALL.md) (four options, from plain skill copy to `dsh plugin add`).

> DSH install note: the package name is `dsh-logicprobe`. In the web profile's `package.json`, both the dependency key and the `dsh.profile.bundles` entry must use the same name; a mismatch causes the dsh loader to fail with `ERR_MODULE_NOT_FOUND`.

## Usage

The plugin auto-injects a capability notification into the first model step. The skill activates when its `Use when` description matches your task:

- **Design doc / plan review** — "Review this design document" → claim enumeration and codebase verification
- **Behavioral questions** — "could this state machine deadlock", "is this retry limit safe", "check this timing for bugs" → the skill is proactively suggested (not auto-loaded) as an optional verification pass
- **Refactoring plans** — the pipeline compares before/after models to flag undocumented behavioral changes

The skill auto-classifies depth (LIGHTWEIGHT / STANDARD / ESCALATED) from plan features in Phase 0, and appends a `## Plan Verification` summary block as the audit trail.

In DSH, prefer the native `logicprobe_verify` tool (see `skills/logicprobe/references/dsh-model-schema.md`). Python remains optional for non-DSH hosts: when available, the reusable harness at `references/verification-harness.py` runs the checks; when not (air-gapped machines), the guide at `references/logic-verification-guide.md` provides a manual verification mode.

## Codex CLI

This plugin also supports OpenAI Codex CLI. Skills follow the Agent Skills standard and work identically across both platforms.

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

Skills are invoked with `$logicprobe` or auto-selected by Codex based on task context.

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

Skills are auto-discovered from `.claude/skills/` and `.codex/skills/` paths. Add to your `opencode.json`:

```json
{
  "plugin": ["logicprobe@git+https://github.com/AmethystLuna/logicprobe.git"]
}
```

Or install via `skop` which consumes the Claude marketplace manifest. See `.opencode/INSTALL.md` for detailed instructions.

## ZCode (Z.AI)

ZCode 3.0+ follows the Agent Skills standard. No plugin marketplace — manually copy skills to `.zcode/skills/`:

```bash
git clone https://github.com/AmethystLuna/logicprobe.git
cp -r logicprobe/skills/* .zcode/skills/
```

Skills are invoked with `$logicprobe`. See `.zcode/INSTALL.md` for details.

## Requirements

- Claude Code v2.1+ / Codex CLI latest / Cursor 2.5+ / Kimi CLI latest / OpenCode latest / ZCode 3.0+
- DeepSeek Harness (dsh): dev preview — verified on mainline 2026-08-14 (gate bundle loaded and injected in-session)
- Python 3.6+ optional (only for the automated harness; manual fallback mode requires none)

## Configuration

In DeepSeek Harness, the bundle registers the `logicprobe_verify` tool (through `ctx.tools`) and a policy-aware `logicprobe:mode` context (through `ctx.systemPrompt`). The bundle accepts a small configuration object:

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Set to `false` to disable the session-start gate injection. |
| `gateContent` | string | built-in gate text | Override the text injected into the first model step. |
| `interaction` | `ask` \| `auto` \| `follow-approval` | `follow-approval` | Model-confirmation policy. `follow-approval` resolves to `auto` when the session approval policy is `never`. |

To change it, override the row by id in your profile's `cordis.patch.yml`:

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

- If you installed through the DSH plugin manager, remove the `logicprobe` plugin from the target profile using the same manager you used to install it.
- If you copied `skills/*` manually, delete the copied skill directories from `~/.agents/skills/` or the project `.dsh/skills/`.
- If you added the bundle as a `cordis.patch.yml` row, remove the row with `id: logicprobe` from the profile patch and restart DSH.

## Permissions & Data

- The plugin runtime reads only the `skills/` directory shipped inside the package, in order to register skills through DSH's standard filesystem skill provider.
- It injects the configured gate text into the first model step of a session.
- It does not read credentials, open network connections, or access user data outside the DSH session context.
- When the skill is actually used, the model may read project files as directed by the user, just like any other coding skill.

## Troubleshooting

- Skill not visible in DSH: confirm you are on a DSH version that supports `ctx.skills`/Agent Skills discovery, and restart the profile after install.
- Gate not injected: check that `enabled` is not `false` and that the row id `logicprobe` is present in the active profile patch.
- `logicprobe_verify` not visible: check `cordis_inspect_query` status for `toolRegistered: true`, and confirm the DSH profile resolved the `@deepseek-ai/dsh-tools` peer dependency.
- Plugin manager rejects installation: make sure `@deepseek-ai/*` packages are declared as `peerDependencies`, not regular `dependencies`.
- After manual copy, DSH still doesn't see the skill: use the native bundle install (`dsh plugin add "github:AmethystLuna/logicprobe"`) instead of copying.

## Development

```bash
npm install
npm run typecheck
npm run build
```

Trigger tests are under `tests/skill-triggering/`; run them with:

```bash
bash tests/skill-triggering/run-all.sh
```

## License & Security

Licensed under MIT. See [LICENSE](LICENSE).

To report a security vulnerability, do **not** open a public issue. Use the private Security Advisory path or the contact method in [SECURITY.md](SECURITY.md).

## Related Plugins

| Plugin | Description |
|--------|-------------|
| [embedded-workbench](https://github.com/AmethystLuna/embedded-workbench) | Embedded C/C++ toolbox whose Plan Verification Gate uses this skill. This plugin was split out of embedded-workbench. |

## Acknowledgments

The claim-verification methodology (logic primitives, adversarial probing, refactoring before/after comparison) and the trigger test framework (`tests/skill-triggering/`) follow the conventions of [Superpowers](https://github.com/obra/superpowers) by Jesse Vincent (MIT License), as adapted in the [embedded-workbench](https://github.com/AmethystLuna/embedded-workbench) plugin.
