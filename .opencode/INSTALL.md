# Installing Logic Probe for OpenCode

## Installation

Add to the `plugin` array in your `opencode.json` (global or project-level):

```json
{
  "plugin": ["logicprobe@git+https://github.com/AmethystLuna/logicprobe.git"]
}
```

Or pin a specific version:

```json
{
  "plugin": ["logicprobe@git+https://github.com/AmethystLuna/logicprobe.git#v0.1.0"]
}
```

Restart OpenCode.

Verify: ask "What verification skills do you have available?"

## Manual Install

```bash
git clone https://github.com/AmethystLuna/logicprobe.git ~/.config/opencode/plugins/logicprobe
```

Skills are auto-discovered from the standard `.claude/skills/` and `.codex/skills/` paths within the plugin directory.

## Tool Mapping

When skills reference Claude Code tools:

- `Skill("name")` → OpenCode's native `skill` tool
- `Agent()` / `Task` → `@mention` syntax
- `Write`/`Edit`/`Read`/`Bash` → OpenCode native tools

## Getting Help

- Issues: <https://github.com/AmethystLuna/logicprobe/issues>
- Docs: <https://github.com/AmethystLuna/logicprobe>
