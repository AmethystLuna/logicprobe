# 逻辑探针 (Logic Probe)

<p align="center"><a href="README.en-US.md">English</a> · <strong>中文</strong></p>

文档不是事实——代码才是。一个声称核查技能：逐条核验设计文档、架构规格、重构计划中每一个可验证的声称与代码库实际是否一致；遇到行为类声称时升级为可执行模型验证。

**跨平台** — 支持 Claude Code、Codex CLI、Cursor、Kimi CLI、OpenCode、ZCode。基于 [Agent Skills](https://agentskills.io) 开放标准构建。

## 功能

| 阶段 | 内容 |
|------|------|
| Phase 1-2 | 枚举每个可验证声称（API 名、文件路径、枚举值、数量、机制可行性）→ 逐条对照代码库给出证据 |
| Phase 2a | 对提取的状态机模型执行 **7 项结构检查**：可达性、死锁、活性、确定性、事件/守卫完备性、不变量有效性 |
| Phase 2b | **7 种对抗探针**：意外事件、竞态交错、顺序置换、配对对称（lock/unlock）、边界轰炸、资源注入、最小反例 |
| 重构模式 | 前后模型对比——行为保持、不变量连续性、死锁回归、复杂度声称 |
| 输出 | 结构化发现：精确 file:line 证据、严重性分级、修正方向——绝不在核查中直接改代码 |

模型永远先以转换表形式展示并**经用户确认后才运行**——模型提取错误是验证的头号失败模式。

## 安装

### Marketplace 安装（推荐）

在 `~/.claude/settings.json` 中添加 marketplace：

```json
{
  "extraKnownMarketplaces": {
    "logicprobe": {
      "source": { "source": "github", "repo": "AmethystLuna/logicprobe" }
    }
  }
}
```

然后通过 CLI 安装：

```bash
claude plugin install logicprobe@logicprobe
```

### 手动安装

```bash
git clone https://github.com/AmethystLuna/logicprobe.git ~/.claude/plugins/dev/logicprobe
```

然后在 `~/.claude/settings.json` 中启用：

```json
{
  "enabledPlugins": {
    "logicprobe@dev": true
  }
}
```

## DeepSeek Harness (dsh)

原生 dsh 支持以 cordis 插件 bundle 的形式提供，位于**仓库根**（根 `package.json` 声明了 `dsh.bundle`）：

- 技能遵循 Agent Skills 开放标准，被 dsh 的 `skill-filesystem` provider 原样发现——零代码。
- bundle 将 claim 验证门禁（1% Rule / Red Flags / 主动建议）注入每个 agent 会话的第一个模型步骤——是 Claude `SessionStart` hook 在 dsh 的原生对应物，并注册模型可见目录条目（`cordis_inspect`）、原生工具 `logicprobe_verify`（`ctx.tools`）以及策略感知上下文 `logicprobe:mode`（`ctx.systemPrompt`）。
- 与 embedded-workbench bundle 的 Plan Verification Gate 配合，在 dsh 中闭环了 claim 验证链路。

安装：参见 [`.dsh/INSTALL.md`](.dsh/INSTALL.md)（四种方式，从纯技能拷贝到 `dsh plugin add`）。

> DSH 安装注意：包名已使用 scoped 形式 `dsh-logicprobe`。在 web profile 的 `package.json` 中，依赖键与 `dsh.profile.bundles` 必须写 `dsh-logicprobe`；否则 dsh 加载器会因找不到 `node_modules/dsh-logicprobe` 而启动失败。

## 使用

插件在会话首个模型步骤自动注入能力通知。技能在任务匹配其 `Use when` 描述时激活：

- **设计文档 / 计划审查** — "Review this design document" → 声称枚举与代码库核查
- **行为类问题** — "could this state machine deadlock"、"is this retry limit safe"、"check this timing for bugs" → 主动建议（不自动加载）作为可选验证
- **重构计划** — 管线对比前后模型，标记计划未声明的行为变化

技能在 Phase 0 依据计划特征自动分级（LIGHTWEIGHT / STANDARD / ESCALATED），并在计划文件追加 `## Plan Verification` 摘要块作为审计痕迹。

Python 可选：可用时使用 `references/verification-harness.py` 自动执行检查；不可用（如离线开发机）时，`references/logic-verification-guide.md` 提供手动验证模式。

## Codex CLI

本插件同样支持 OpenAI Codex CLI。技能遵循 Agent Skills 标准，两个平台行为一致。

### Codex 安装

```bash
# 添加 marketplace
codex plugin marketplace add AmethystLuna/logicprobe

# 安装
codex plugin install logicprobe
```

或手动：

```bash
git clone https://github.com/AmethystLuna/logicprobe.git ~/.codex/plugins/logicprobe
```

技能通过 `$logicprobe` 调用，或由 Codex 根据任务上下文自动选择。

## Cursor

Cursor 2.5+ 内置插件支持。

### Cursor 安装

```bash
# 克隆到 Cursor 插件目录
git clone https://github.com/AmethystLuna/logicprobe.git ~/.cursor/plugins/logicprobe
```

或通过 Cursor 插件市场 UI 安装：`/add-plugin AmethystLuna/logicprobe`

## Kimi CLI

Kimi CLI 自动从 `.claude/skills/` 路径发现技能。`.kimi-plugin/plugin.json` 清单向 Kimi 插件管理器注册本插件。

### Kimi 安装

```bash
# 通过 Kimi 插件管理器
/plugins install https://github.com/AmethystLuna/logicprobe.git

# 或手动克隆
git clone https://github.com/AmethystLuna/logicprobe.git ~/.kimi/plugins/logicprobe
```

技能通过 `/skill:logicprobe` 调用。

## OpenCode

技能自动从 `.claude/skills/` 和 `.codex/skills/` 路径发现。在 `opencode.json` 中添加：

```json
{
  "plugin": ["logicprobe@git+https://github.com/AmethystLuna/logicprobe.git"]
}
```

或通过 `skop` 安装（消费 Claude marketplace 清单）。详见 `.opencode/INSTALL.md`。

## ZCode (Z.AI)

ZCode 3.0+ 遵循 Agent Skills 标准。无插件市场——手动复制技能到 `.zcode/skills/`：

```bash
git clone https://github.com/AmethystLuna/logicprobe.git
cp -r logicprobe/skills/* .zcode/skills/
```

技能通过 `$logicprobe` 调用。详见 `.zcode/INSTALL.md`。

## 环境要求

- Claude Code v2.1+ / Codex CLI 最新 / Cursor 2.5+ / Kimi CLI 最新 / OpenCode 最新 / ZCode 3.0+
- DeepSeek Harness (dsh): dev preview — 已实测 mainline 2026-08-14（gate bundle 加载并注入会话成功）
- Python 3.6+ 可选（仅自动验证工具需要；手动兜底模式无需任何依赖）

## 配置

在 DeepSeek Harness 中，bundle 支持以下配置：

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 设为 `false` 可关闭首步 Gate 注入。 |
| `gateContent` | string | 内置 gate 文本 | 覆盖注入到首轮模型上下文中的文本。 |
| `interaction` | `ask` \| `auto` \| `follow-approval` | `follow-approval` | 模型确认策略；`follow-approval` 在会话 approval policy 为 `never` 时解析为 `auto`。 |

在 profile 的 `cordis.patch.yml` 中按 row id 覆盖：

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

## 卸载

- 如果通过 DSH 插件管理器安装，请使用同一管理器从目标 profile 中移除 `logicprobe`。
- 如果手动复制过 `skills/*`，请删除复制到 `~/.agents/skills/` 或项目 `.dsh/skills/` 下的对应目录。
- 如果通过 `cordis.patch.yml` 添加，请删除 profile patch 中 `id: logicprobe` 对应的行，并重启 DSH。

## 权限与数据

- 插件运行时只读取包内自带的 `skills/` 目录，用于通过 DSH 标准 filesystem skill provider 注册技能。
- 它会在会话首轮向模型上下文注入配置好的 gate 文本。
- 它不读取凭据、不发起网络连接，也不会访问 DSH 会话上下文之外的用户数据。
- 实际使用技能时，模型会像使用其他编码技能一样，按用户指示读取项目文件。

## 故障排查

- 技能在 DSH 中不可见：确认 DSH 版本支持 `ctx.skills` / Agent Skills 发现，并在安装后重启 profile。
- Gate 未注入：检查 `enabled` 是否为 `false`，以及 profile patch 中是否存在 `id: logicprobe` 的行。
- 插件管理器拒绝安装：确认 `@deepseek-ai/*` 包声明在 `peerDependencies` 中，而不是 `dependencies`。
- 手动复制后 DSH 仍看不到技能：改用原生 bundle 安装（`dsh plugin add "github:AmethystLuna/logicprobe"`）。

## 开发

```bash
npm install
npm run typecheck
npm run build
```

触发测试位于 `tests/skill-triggering/`：

```bash
bash tests/skill-triggering/run-all.sh
```

## 许可证与安全

本项目使用 MIT 许可证，见 [LICENSE](LICENSE)。

如发现安全漏洞，请**不要**公开创建 issue，应使用 GitHub Security Advisory 或 [SECURITY.md](SECURITY.md) 中的联系方式私下报告。

## 关联插件

| 插件 | 说明 |
|------|------|
| [embedded-workbench](https://github.com/AmethystLuna/embedded-workbench) | 嵌入式 C/C++ 工具箱，其 Plan Verification Gate 依赖本技能。本插件已从 embedded-workbench 拆分而来。 |

## 致谢

声称核查方法论（逻辑原语、对抗探测、重构前后对比）与触发测试框架（`tests/skill-triggering/`）遵循 [Superpowers](https://github.com/obra/superpowers)（Jesse Vincent，MIT License）的约定，经 [embedded-workbench](https://github.com/AmethystLuna/embedded-workbench) 插件改编而来。
