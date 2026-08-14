# logicprobe-dsh

DeepSeek Harness (`dsh`) support for the Logic Probe plugin. Two layers, independent:

1. **Skill** (works today, zero code): the logicprobe skill uses the Agent Skills open standard (`skill-name/SKILL.md` + kebab-case frontmatter) and is discovered as-is by `dsh`'s `skill-filesystem` provider. Install by copying `skills/*` to `~/.agents/skills/` (user-level) or `<project>/.dsh/skills/` (project-level). See [../../.dsh/INSTALL.md](../../.dsh/INSTALL.md).
2. **Native bundle** (this package): a cordis plugin that injects the claim-verification gate text (1% Rule / Red Flags / proactive suggestion) into the first model step of every agent session — the dsh-native counterpart of the Claude Code plugin's `SessionStart` hook.

## How the injection works

The plugin listens on the `agent/pre-step` waterfall (the same mechanism the official `@deepseek-ai/dsh-agent-instructions` loader uses) and folds the gate text into the first step's `enter` decision, so it enters durable context **before the first request**. The default text is the dsh-shaped twin of `hooks/session-start-content.md` in the plugin root — same content, with Claude tool names mapped to the dsh catalog (`skill` tool, `exit_plan_mode`) — and is kept in sync with it; deployments override it via the `gateContent` config key.

## Install

```bash
npx -p @deepseek-ai/dsh dsh plugin --profile web add "github:AmethystLuna/logicprobe"
```

Restart the target profile. No further config is required — the bundle patch mounts the plugin row with defaults.

To change the gate text or disable injection, override the row by id in your profile's `cordis.patch.yml` (the row's `config` is replaced wholesale, not deep-merged):

```yaml
- insert:
    - id: logicprobe
      name: 'logicprobe-dsh'
      config:
        enabled: true
        gateContent: |
          <EXTREMELY_IMPORTANT>
          Your own gate text...
          </EXTREMELY_IMPORTANT>
```

## Verify

- `dsh --profile <scratch> --dump-config` shows the `logicprobe` row (create a scratch profile with `dsh plugin --profile <scratch> add ...` first).
- `dsh --profile headless "列出你加载的验证类 skill"` — confirms the skill layer.
- Start a session and check the gate text appears in the model context of the first step.

## What the bundle covers

| Piece | Status |
|---|---|
| 1 skill (discovery) | works as-is, no code |
| Session-start gate injection (claim-verification doctrine / 1% Rule / Red Flags / proactive suggestion) | native `agent/pre-step` fold, dsh-shaped twin of the Claude hook content |
| Plan Verification Gate integration | the embedded-workbench bundle's gate text routes plan approval to this skill; dsh's native plan mode (`exit_plan_mode`) is the approval gate — no separate native listener |

## Known limitations

- **First-step only**: the gate folds into `step === 1` with a non-empty message batch; a no-step first entry is left untouched.
- **Gate text twin**: the default text tracks `hooks/session-start-content.md` with dsh tool names substituted (`skill` tool, `exit_plan_mode`); review it per deployment and override via `gateContent`.
- **Version pinning**: dsh is in developer preview with no compatibility promise — pin the CLI (`npx -p @deepseek-ai/dsh@0.1.0-rc.6`) and expect breaking changes. Dependency ranges were verified against npm on 2026-08-14 (`@deepseek-ai/cordis` 4.0.1, `@deepseek-ai/dsh-agent` 0.1.0-rc.6, `@deepseek-ai/dsh-llm`/`dsh-session` 0.0.1-rc.1, `@deepseek-ai/schemastery` 3.18.1).

## Getting Help

- Issues: [https://github.com/AmethystLuna/logicprobe/issues](https://github.com/AmethystLuna/logicprobe/issues)
- Docs: [https://github.com/AmethystLuna/logicprobe](https://github.com/AmethystLuna/logicprobe)
