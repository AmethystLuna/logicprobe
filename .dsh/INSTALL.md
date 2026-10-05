# Installing Logic Probe for DeepSeek Harness (dsh)

DeepSeek Harness (`dsh`) discovers skills through the Agent Skills open standard (agentskills.io). The layout is the same `skill-name/SKILL.md` plus frontmatter that this plugin already uses.

The recommended install is the native plugin bundle. It registers the bundled skills and folds the session-start gate into the first model step in one step. The skill-copy options below remain for hosts that do not use the dsh plugin manager.

## Install

### Option A — native plugin bundle (recommended)

Install the bundle from the repository root. The root `package.json` declares `dsh.bundle`:

```bash
# from npm (published as dsh-logicprobe)
dsh plugin --profile web add dsh-logicprobe
# or from GitHub (source of truth)
dsh plugin --profile web add "github:AmethystLuna/logicprobe"
# when dsh is not installed globally
npx -p @deepseek-ai/dsh dsh plugin --profile web add dsh-logicprobe
```

This installs under the package name `dsh-logicprobe`. If you manage the profile's `package.json` by hand, use that same name for both the dependency key and the `dsh.profile.bundles` entry.

Restart the target profile. The bundle mounts a native cordis plugin, and that plugin does two things.

1. It registers the bundled skills through dsh's `ctx.skills` filesystem provider. The skills then appear in the session skill catalog, with no manual copy step.
2. It folds the gate text into the first model step. The gate carries the claim-verification doctrine: the 1% Rule, the Red Flags table, and the proactive-suggestion rule. This is the dsh counterpart of the Claude Code `SessionStart` hook.

The bundle also registers six native tools through `ctx.tools`: `logicprobe_verify`, `logicprobe_datamodel_verify`, `logicprobe_concurrency_scan`, `logicprobe_compose_verify`, `logicprobe_export` and `logicprobe_uml`. It adds one dynamic context, `logicprobe:mode`, through `ctx.systemPrompt`. That context resolves `interaction` per session: `follow-approval` becomes `auto` when the last `approval/policy` event is `never`.

To change the gate text, change the interaction mode, or disable injection, override the row by id in your profile's `cordis.patch.yml`. The row's `config` is replaced wholesale, not deep-merged:

```yaml
- insert:
    - id: logicprobe
      name: 'dsh-logicprobe'
      config:
        enabled: true
        gateContent: |
          <EXTREMELY_IMPORTANT>
          Your own gate text...
          </EXTREMELY_IMPORTANT>
```

### Option B — user-level, cross-harness

Copy the skills into `~/.agents/skills/`. That is DSH discovery root rank 500, and other harnesses that follow the Agent Skills standard read it too:

```bash
git clone https://github.com/AmethystLuna/logicprobe.git
mkdir -p ~/.agents/skills
cp -r logicprobe/skills/* ~/.agents/skills/
```

### Option C — project-level

Copy the skills into your project's `.dsh/skills/`. That is discovery root rank 100, the highest priority, scoped to that project alone:

```bash
mkdir -p .dsh/skills
cp -r logicprobe/skills/* .dsh/skills/
```

### Option D — zero-copy (advanced)

If your `dsh` configuration supports `customSkillDirs` (rank 300), point it at this repository's `skills/` directory instead of copying. See the dsh configuration docs for the exact key placement.

## Verify

- `dsh --profile <scratch> --dump-config` shows the `logicprobe` row with `enabled: true`. Create a scratch profile first with `dsh plugin --profile <scratch> add ...`.
- Start a session. The gate text must appear in the model context of the first step.
- `cordis_inspect_list` shows the `logicprobe` provider. `cordis_inspect_query` with method `status` returns `enabled: true`, `interaction: follow-approval`, `engineSchemaVersion: 1` and `dataEngineSchemaVersion: 1`. Every tool flag must be `true`: `toolRegistered`, `dataToolRegistered`, `concurrencyToolRegistered`, `composeToolRegistered`, `exportToolRegistered` and `umlToolRegistered`.
- The `logicprobe_verify` tool accepts Model schema v1 and returns the S1-S8 plus A1-A14 report. See `skills/logicprobe/references/dsh-model-schema.md`. Passing `beforeModel` and an optional `stateMapping` adds the D1-D4 before/after regression checks.
- The `logicprobe_uml` tool models a code flow as UML and reviews the modelling. See `skills/logicprobe/references/uml-modeling-guide.md`. `action=render` draws Mermaid state, activity and sequence views, or PlantUML state and sequence views. `action=parse` reads a diagram back into a LogicModelV1. `action=review` reports structural findings and the diagram-versus-model round-trip fidelity.
- The `logicprobe_datamodel_verify` tool accepts DataModelV1 and returns the DS/DA/DD checks. See `skills/logicprobe-datamodel/references/data-model-schema.md`. Passing `beforeModel`, `fieldMapping`, `copyPairs` and `migrationMappings` adds migration coverage, copy consistency, rollback symmetry and the DD1-DD4 before/after data regression.
- The `logicprobe_concurrency_scan` tool scans document or plan text for concurrency risk claims. It flags absolute guarantees for dedicated verification.
- Ask in a `dsh` session: "你有设计文档 / 计划 claim 核查相关的 skill 吗?"

## Notes

- Skill frontmatter already matches the DSH expectations. `name` is kebab-case and matches the directory name, and `description` is present. The policy keys `disable-model-invocation` and `user-invocable` are omitted, which defaults to model- and user-invocable. That is the intended behavior.
- DSH is in v0.1 developer preview, so breaking changes are expected. Pin your `dsh` version.
- This repo has no plugin marketplace. Install the native bundle from npm (`dsh-logicprobe`) or from GitHub. The skill-copy options above are fallbacks.
- The first-model-step gate injection comes from the root bundle (Option A). This plugin is the verification half of the embedded-workbench ecosystem: the embedded-workbench bundle's Plan Verification Gate routes plan approval through this skill.
- No custom agents. This plugin is skill-only, so there is nothing else to port.
- **Permission presets**: under `workspace-write`, evidence stays inside the workspace and model confirmation defaults to ask. Under `danger-full-access` with `approval=never`, the bundle resolves interaction to auto. It then never calls `ask_user_question` for model confirmation, and it never requests sandbox escalation.
- **Gate injection semantics**: the gate is appended to the first model step that runs, through `agent/pre-step`. It is appended once per session, guarded by the session's durable history. That makes it resilient to blank-session preset switches, which clear the agent inbox before the first step. Anchored and bootstrap presets may strip first-step gate messages; the plugin re-injects after promotion. The gate text is the dsh-native adaptation of `hooks/session-start-content.md`. The behavior rules are synced, and the presentation is adapted to the dsh skill catalog, where the trigger list lives in the skill description. Review it for your deployment and override it with `gateContent` if needed.

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
