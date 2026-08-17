# Installing Logic Probe for DeepSeek Harness (dsh)

DeepSeek Harness (`dsh`) discovers skills via the Agent Skills open standard (agentskills.io) — the same `skill-name/SKILL.md` + frontmatter layout this plugin already uses. The logicprobe skill is discovered as-is; no content changes required.

## Install

### Option A — user-level, cross-harness (recommended)

Copy the skills into `~/.agents/skills/` — DSH discovery root rank 500, and a shared directory that other Agent-Skills-standard harnesses also read:

```bash
git clone https://github.com/AmethystLuna/logicprobe.git
mkdir -p ~/.agents/skills
cp -r logicprobe/skills/* ~/.agents/skills/
```

### Option B — project-level

Copy the skills into your project's `.dsh/skills/` (DSH discovery root rank 100 — highest priority, scoped to that project only):

```bash
mkdir -p .dsh/skills
cp -r logicprobe/skills/* .dsh/skills/
```

### Option C — zero-copy (advanced)

If your `dsh` configuration supports `customSkillDirs` (rank 300), point it at this repository's `skills/` directory instead of copying. See the dsh configuration docs for the exact key placement.

### Option D — native plugin (session-start gate injection)

Install the bundle from the repository root (the root `package.json` declares `dsh.bundle`):

```bash
npx -p @deepseek-ai/dsh dsh plugin --profile web add "github:AmethystLuna/logicprobe"
```

This installs under the scoped package name `@amethystluna/logicprobe`. If you manage the profile's `package.json` manually, use `@amethystluna/logicprobe` for both the dependency key and the `dsh.profile.bundles` entry.

Restart the target profile. This mounts a native cordis plugin that folds the gate text (claim-verification doctrine / 1% Rule / Red Flags / proactive suggestion) into the first model step — the dsh-native counterpart of the Claude Code `SessionStart` hook.

To change the gate text or disable injection, override the row by id in your profile's `cordis.patch.yml` (the row's `config` is replaced wholesale, not deep-merged):

```yaml
- insert:
    - id: logicprobe
      name: '@amethystluna/logicprobe'
      config:
        enabled: true
        gateContent: |
          <EXTREMELY_IMPORTANT>
          Your own gate text...
          </EXTREMELY_IMPORTANT>
```

## Verify

- `dsh --profile <scratch> --dump-config` shows the `logicprobe` row with `enabled: true` (create a scratch profile with `dsh plugin --profile <scratch> add ...` first).
- Start a session and check the gate text appears in the model context of the first step.
- `cordis_inspect_list` shows the `logicprobe` provider; `cordis_inspect_query` with method `status` returns `enabled: true`.
- Ask in a `dsh` session: "你有设计文档 / 计划 claim 核查相关的 skill 吗?"

## Notes

- Skill frontmatter already matches the DSH expectations: `name` is kebab-case and matches the directory name; `description` is present. The policy keys `disable-model-invocation` / `user-invocable` are omitted, which defaults to model- AND user-invocable — the intended behavior.
- DSH is in v0.1 developer preview; breaking changes are expected. Pin your `dsh` version.
- DSH has no plugin marketplace for this repo — manual install only.
- The first-model-step gate injection is provided natively by the root bundle (Option D). This plugin is the verification half of the embedded-workbench ecosystem: the embedded-workbench bundle's Plan Verification Gate routes plan approval through this skill.
- No custom agents — this plugin is skill-only; nothing else to port.
- **Gate injection semantics**: the gate is appended to the first model step that runs via `agent/pre-step`, once per session, guarded by the session's durable history. This is resilient to blank-session preset switches that clear the agent inbox before the first step; anchored/bootstrap presets may strip first-step Gate messages and the plugin re-injects after promotion. The gate text is the dsh-native adaptation of `hooks/session-start-content.md` — behavior rules synced, presentation adapted to the dsh skill catalog (the trigger list lives in the skill description); review it per deployment and override via `gateContent`.

## Tool Mapping

When the skill references Claude Code tools:

| Skill text | DeepSeek Harness equivalent |
|---|---|
| `Skill("logicprobe")` | Skills are model-invocable by default; the model loads them through the skills catalog (`ctx.skills`) |
| `Read` / `Write` / `Edit` / `Bash` | Native dsh tools (`ctx.tools` registry) |
| `ExitPlanMode` / plan-mode gates | dsh-native: `@deepseek-ai/dsh-plan-mode` (`exit_plan_mode` tool); the embedded-workbench bundle's gate text routes plan verification to this skill |

## Getting Help

- Issues: [https://github.com/AmethystLuna/logicprobe/issues](https://github.com/AmethystLuna/logicprobe/issues)
- Docs: [https://github.com/AmethystLuna/logicprobe](https://github.com/AmethystLuna/logicprobe)
