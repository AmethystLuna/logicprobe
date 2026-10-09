# 逻辑探针 (Logic Probe)

<p align="center"><a href="README.en-US.md">English</a> · <strong>中文</strong></p>

没验证过的设计，翻车只是时间问题；再复杂的代码，建模再跑就清楚了。

logicprobe 核验声称与实物是否一致。事实类对着源码查。行为类跑模型：状态机、协议、组合、数据模型、迁移。图按依赖图读，单层或多层。改动前后用基线对比。验不了的维度明说，并指出该用哪个工具。

**跨平台**：支持 Claude Code、Codex CLI、Cursor、Kimi CLI、OpenCode、ZCode。技能基于 [Agent Skills](https://agentskills.io) 开放标准。

## 功能

| 阶段 | 内容 |
|------|------|
| Phase 1-2 | 枚举每个可验证声称：API 名、文件路径、枚举值、数量、机制可行性。逐条对照代码库给出证据。 |
| Phase 2a | 对提取的状态机模型执行 **8 项结构检查（S1-S8）**：S1 可达性、S2 死锁、S3 活性、S4 确定性、S5 事件完备性、S6 守卫完备性、S7 不变量有效性、S8 单调变量。 |
| Phase 2b | **14 项对抗探针（A1-A14）**：意外事件、竞态交错、顺序置换、配对对称（lock/unlock，含 onEntry/onExit 隐式配对）、边界轰炸、资源注入、最小反例、幂等重放、必达、顺序、原子性、预算（A12 最坏路径代价，含正成本环检测）、概率可达（A13）、期限（A14）。 |
| 重构模式 | 对比前后模型：行为保持、不变量连续性、死锁回归、复杂度声称。 |
| 数据模型模式 | 验证 DataModelV1 数据模型（DS/DA/DD）：迁移覆盖、copy 一致性、before/after 破坏性变更回归。 |
| UML 建模与审查 | 用 UML 画出代码流程，再审查这份建模本身：结构缺陷、文档缺口、图与模型的往返保真度。 |
| 并发风险挖掘 | 扫描文档与计划中的并发安全声称（thread-safe、lock-free、race condition、中断安全等），标记出来交给专用验证。 |
| 输出 | 结构化发现：精确 file:line 证据、严重性分级、修正方向。核查过程中绝不直接改代码。报告附带 `coverageNotes`，把时序、抢占、混合控制、概率等词汇路由到外部工具（UPPAAL、TSan、CBMC、TLA+、SpaceEx、PRISM 等），见 `skills/logicprobe/references/gap-routing-guide.md`。模型可携带自然语言 `narrative`（状态、事件、场景注释），报告原样回显。 |

模型永远先以转换表形式展示，**经用户确认后才运行**。模型提取错误是验证的头号失败模式。

## 安装

### Claude Code 安装（推荐）

在 **Claude Code** 的 `~/.claude/settings.json` 中添加 marketplace：

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

### Claude Code 手动安装

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

原生 dsh 支持以 cordis 插件 bundle 的形式提供，位于**仓库根**，由根 `package.json` 的 `dsh.bundle` 声明。

这个 bundle 做三件事：

1. **注册技能。** 技能遵循 Agent Skills 开放标准，由 dsh 的 `skill-filesystem` provider 原样发现，不需要额外代码。
2. **注入门禁文本。** 每个会话的第一个模型步骤会收到 claim 验证门禁（1% Rule / Red Flags / 主动建议）。这是 Claude `SessionStart` hook 在 dsh 上的对应物。
3. **注册原生工具与上下文。** 工具挂在 `ctx.tools` 上，另有一条策略感知上下文 `logicprobe:mode`（`ctx.systemPrompt`），以及模型可见目录条目（`cordis_inspect`）。

工具清单：

| 工具 | 作用 |
|------|------|
| `logicprobe_verify` | 状态机验证：S1-S8 结构检查 + A1-A14 对抗探针。传 `beforeModel` 与 `stateMapping` 可加做 D1-D4 前后回归。 |
| `logicprobe_datamodel_verify` | 数据模型验证：DataModelV1、迁移覆盖、copy 一致性、DD1-DD4 数据回归。 |
| `logicprobe_concurrency_scan` | 扫描并发风险声称（thread-safe、lock-free、race condition、mutex 等），标注需要专用验证。 |
| `logicprobe_compose_verify` | 两台及以上状态机组合验证（握手 rendezvous 语义）：C1 组合死锁、C2 握手永不触发。 |
| `logicprobe_export` | 导出外部工具原生输入：UPPAAL（`.xta` + queries）、TLA+（TLC 模块）、PRISM（DTMC `.pm` + `.pctl`）、SPIN（Promela + ltl）。 |
| `logicprobe_uml` | 用 UML 建模代码流程，并审查这份建模。见下方「UML 建模与审查」。 |
| `logicprobe_structure_verify` | 把组件/包/类/部署图当**依赖图**审查（UML020-UML026）：孤立节点、悬空端点、依赖环、违反允许依赖矩阵的边、跨层反向依赖、矩阵要求却缺失的边；每条被判定的边都会报出命中的规则 id。它审的是**图**，代码侧要用 include/依赖扫描对账。 |
| `logicprobe_report_diff` | 对比两份同族报告（baseline vs current），给出新增/消除/变化的发现与**增量**判定：按 `检查 id + code + 机器可读定位（evidence/path）` 匹配，改措辞只会算作 `changed`；新增 error 判 fail，而 `currentVerdict` 仍保留本次运行的绝对结论。"违规不增"的验收判据，算出来而不是看出来的。 |

迁移代价用 `cost`（缺省 1），配 `budget` 不变量即由 A12 检查最坏路径代价，正成本环会被判为无界。迁移权重用 `weight`（缺省 1），配 `probability` 不变量即由 A13 计算概率可达。状态上的 `onEntry`/`onExit` 动作由 A4 自动纳入配对检查，`maxTicks` 加 `tickEvents` 由 A14 检查期限。

### 怎么读报告（`ok` 不是结论）

所有报告都同时给「工具跑成功」与「审查通过」两件事：

| 字段 | 含义 |
|------|------|
| `schema` | 版本化报告契约（`logicprobe/verify/v1`、`logicprobe/uml/review/v1`…），消费方按它分支而不是猜字段。 |
| `ok` | 引擎产出了报告。对 `verify` 只在**模型校验失败**时为 `false`；它**不是**结论。 |
| `ran` | 工具确实执行了。仅在工具层拒绝请求（带 `errorCode`/`error`）时为 `false`。 |
| `verdict` | `pass` / `pass_with_findings` / `fail`。任何 `severity: "error"` 的发现、或校验失败，都会是 `fail`。 |
| `verdictReason` | 一行说明，例如 `1 error finding(s) (first: S2_NO_TRANSITIONS)`。 |
| `hashSpec` | `modelHash` 依据的已发布规范（见 [`hash-spec.md`](skills/logicprobe/references/hash-spec.md)）。 |
| `hashes` | 本次报告涉及的全部哈希集中一处（模型哈希、图/矩阵哈希、前后模型哈希）。 |
| `metadataKeys` | 输入里带 `_` 前缀的注记键路径（仅当存在时出现）。 |
| `narrativeCoverage` | `{states: "5/5", events: "3/9", scenarios: "0/12"}`：narrative **允许部分覆盖**，这里报告还差多少。 |
| `nextSteps` | 由发现推导的下一步，永不为空，同一输入两次运行逐字一致。 |

只看 `ok` 会把「有死锁」的模型读成通过——判据是 `verdict`。非 DSH 的 Python CLI 退出码跟随 verdict：`pass`/`pass_with_findings` → `0`，`fail` 或拒绝 → `2`。

### 模型自带的归档记录（`_` 前缀键）

任何以 `_` 开头的键（任意层级，如 `_source`、`_verified`、`_extraction_caveats`、`states[0]._note`）都是**注记元数据**：schema 跳过、`modelHash` 排除、报告以 `metadataKeys` 回显。这样来源与验证快照可以跟模型放在同一个文件里，不必再维护一个会漂移的 sidecar，而模型的哈希身份不变。其余键仍然闭合——拼错的 `sttes` 依旧报错。用 `verify model.json --hash-check <hex>` 可回答某个历史哈希是否属于任何已发布规范。

安装（原生 bundle，推荐）：

```bash
# 从 npm 安装（包名 dsh-logicprobe）
dsh plugin --profile web add dsh-logicprobe
# 或从 GitHub 源码安装
dsh plugin --profile web add "github:AmethystLuna/logicprobe"
# 未全局安装 dsh 时可用 npx
npx -p @deepseek-ai/dsh dsh plugin --profile web add dsh-logicprobe
```

装完重启 profile。运行 `dsh --profile web --dump-config` 应看到 `id: logicprobe` 且 `enabled: true`。更多方式（纯技能拷贝、项目级等）见 [`.dsh/INSTALL.md`](.dsh/INSTALL.md)。

pnpm 11 有一个发布年龄闸门。它挡住发布不满一天的新版本（`minimumReleaseAge`，默认 1440 分钟），而且默认是非严格模式，所以裸名安装会**静默装到上一个版本**，profile 看起来像这次发版没发生。发版后约 24 小时内要装最新版，请带上版本号：

```bash
dsh plugin --profile web add dsh-logicprobe@<version>
```

pnpm 会把该版本写进 profile 的 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 条目。那是它官方的豁免方式。

> 注意包名。npm 包名是 `dsh-logicprobe`，没有 scope。在 web profile 的 `package.json` 中，依赖键与 `dsh.profile.bundles` 必须都写 `dsh-logicprobe`。写错时 dsh 加载器找不到 `node_modules/dsh-logicprobe`，启动会失败。

## UML 建模与审查

`logicprobe_uml` 把一份 LogicModelV1 画成 UML，也可以把手绘的 UML 读回模型，还可以审查建模本身。它有 3 个动作：

- **render**：模型 → 图。Mermaid 支持状态图、活动流程图、时序图；PlantUML 支持状态图与时序图。notation 表达不了的构造会变成 warning，不会被悄悄丢掉。PlantUML 活动图直接拒绝，因为它的语法无法忠实承载带合流或环的图。
- **parse**：图 → 模型。支持 Mermaid 与 PlantUML 的状态图、活动图，因此手绘的图也能送进 `logicprobe_verify` 验证。两类输入会被拒绝，因为它们无法变成状态机：时序图（迹无法重建机），以及**其它 Mermaid 图族**（`classDiagram`、`erDiagram`、`gantt`、`mindmap`…），返回 `errorCode: "UML_NOT_A_STATE_DIAGRAM"` 并点名该图族。
- **review**：审查建模。它报告两类问题。结构缺陷包括不可达状态、死端、歧义分支、无出口自环、重复迁移。文档缺口包括缺 narrative、变量无界、状态无可读标注、图与 narrative 标签漂移。它还会做保真度检查：把图重新解析回模型，任何结构性差异都报出来。

**结构图是最危险的一类，因为它「能解析」。** PlantUML 的组件图 / 包图 / 类图 / 部署图不声明图类型，解析器会逐行碰上它的关键字。箭头看起来就是迁移，于是 `parse` 会返回一个副产品模型——但现在同时给出 error 级发现 `UML_NOT_A_STATE_DIAGRAM`、`discardedConstructs`（每条无法表达的声明及其行号与原文）、`discardedEdges`（被误读成迁移的箭头数），以及 `verdict: "fail"`。意思是：**这份文件没有被建模，这张图没有被审查。** 不要把那个副产品喂给 `logicprobe_verify` 当作架构审查结论。针对真正依赖图的结构检查（允许依赖矩阵、环、孤立节点）尚未实现，编号 `UML020`+ 已为其保留。

保真度是这套功能的核心。生成的图带有 `logicprobe:` 注释指令（init、终态、别名、变量类型），Mermaid 与 PlantUML 会忽略它们，而解析器会读取它们。因此「图 ↔ 模型」的比较是精确的。

审查只覆盖建模，不覆盖行为。每条发现都会指明应该跑哪一项引擎检查。判据是 `verdict`（`fail` 表示有 error 级发现，图**未**通过审查），不是 `ok`。完整清单（`UML001`-`UML019` 加 `UML_NOT_A_STATE_DIAGRAM`）、指令格式、示例与各视图局限见 [`skills/logicprobe/references/uml-modeling-guide.md`](skills/logicprobe/references/uml-modeling-guide.md)。

## 架构与依赖审查

组件图不是状态机，它是一张**有向依赖图**。`logicprobe_structure_verify` 把同一份 PlantUML 组件/包/类/部署图（或 Mermaid 类图）解析成真正的节点与边——不再丢弃——然后逐项检查：

| 检查 | 严重度 | 含义 |
|---|---|---|
| `UML020_ISOLATED_NODE` | warning | 已声明且非容器的节点一条边都没有：死条目，或漏画的依赖 |
| `UML021_DANGLING_REFERENCE` | error | 箭头端点从未被声明——依赖指向了根本不存在的组件 |
| `UML022_CYCLE` | error | 有向环，给出**最短环**路径；环意味着没有构建顺序、没有分层 |
| `UML023_DISALLOWED_EDGE` | error | 违反允许依赖矩阵的边（`default: deny` 时未被任何规则允许的边也算） |
| `UML024_LAYER_VIOLATION` | error | 从下层指向已声明上层的反向依赖（向下允许、向上禁止） |
| `UML025_MISSING_EXPECTED_EDGE` | warning | `require: true` 要求存在的边图里没有；矩阵与图不一致 |

**多粒度**:同一套图可以按层级给出来 —— `diagrams: [{name, diagram, parent}]` —— 每一层先各自跑上面的结构检查(发现按 `file` 标注来源),再逐对做**细化校验**:子图不得在父层节点之间凭空造出依赖,也不得丢掉父图的边而不把它展开成路径(展开成路径的会列进 `expandedEdges` 供人确认);父图关系成环报 `UML030`,父图未知名报 `UML028`。每对还给出节点/边/继承/新增/展开/丢失/造出的计数(`pairs[]`),并给每层记 sha256(`hashes.diagrams`),这样"哪一层动了"可以由 `--baseline` 直接算出来。命令:`structure diagram.puml` 审单图,`granularity manifest.json` 审多层。

依赖矩阵就是单一事实源，JSON 形式：

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

`source`/`allow`/`deny`/`members` 支持 glob（`*`、`?`）；**`deny` 全局优先**，结果不依赖规则书写顺序；矩阵写错（键名拼错、规则 id 重复、`require` 没有 `allow`）是硬错误 `MATRIX_INVALID`，不会静默放宽检查。每条边都会在 `edgeVerdicts` 里回显 `{from, to, matchedRules, allowed, basis}`。

**不做的事说得清楚**:写点分析("只有 ISR 写这个标志""一个寄存器只有一个写者")**不在本插件射程**——它需要读源码与语句级规则,不是模型或图;这类声称由 `logicprobe_concurrency_scan` 标为未验证并路由到源码侧检查(自己的 include/arch 检查器、静态分析器或 CBMC)。

**它审的是图，不是代码。** 函数指针、DI、注册表、插件加载这些运行期依赖不会出现在边上；干净的 `pass` 只说明"画出来的图自洽且满足矩阵"。真正碰代码的那一步是**对账**：与源码侧的 include/依赖扫描（例如你们自己的 include/依赖检查脚本）用同一套规则 id 跑一遍，差异按四类定性——图漏了代码里有的边（图过期，`require` 时由 `UML025` 报出）、图画了代码里没有的边（图是愿景，或扫描范围更窄）、代码违反了图里没画出的规则（**图掩盖的架构缺陷**，这条才是要动手的）、两边一致判违规（真违规）。完整矩阵 schema、worked example 与对账表见 [`skills/logicprobe-structure/references/structure-review-guide.md`](skills/logicprobe-structure/references/structure-review-guide.md)。

## 使用

插件在会话首个模型步骤自动注入能力通知。技能按**领域**拆分,一共四个;`logicprobe` 是总入口,只要有一点「想验证代码/某个说法是否成立」的念头就加载它,它自己的路由表再把相邻领域交出去:

| 技能 | 领域 | 典型触发 |
|---|---|---|
| `logicprobe` | 声称核查 + 行为验证(状态机/协议、时序与量化保证、组合、重构回归) | "Review this design document"、"could this state machine deadlock"、"is this retry limit safe"、"这个预算够不够" |
| `logicprobe-uml` | 图的建模与审查 | "把这个状态机画出来"、"这份 UML 图对吗"、"component 图能不能当状态机审" |
| `logicprobe-structure` | 架构 / 依赖结构审查 | "审查一下这个架构"、"模块依赖有没有问题"、"分层对不对" |
| `logicprobe-concurrency` | 并发声称:挖矿 + 路由(不证明) | "thread-safe 吗"、"这个 ISR 会 race 吗" |
| `logicprobe-datamodel` | 数据模型 / 迁移与不变量 | "is this migration non-breaking"、"这份 copy 覆盖全字段了吗" |

行为类问题仍按"主动建议、不自动升级"处理:先建议一次可选验证,由你决定是否跑。技能在 Phase 0 依据计划特征自动分级(LIGHTWEIGHT / STANDARD / ESCALATED),并在计划文件追加 `## Plan Verification` 摘要块作为审计痕迹。

在 dsh 之外（Claude Code、Cursor、Codex、终端、CI），装的是**仓库**（marketplace / git），随仓库带 `tools/python/logicprobe-engine.py`：只需 Python 3.8+ 标准库。dsh 安装包（npm / bundle）不含它。已有 LogicModelV1 JSON 时直接运行：

- `verify` 跑 S1-S8 / A1-A14 / D1-D4
- `compose` 跑 C1 / C2 组合
- `export` 生成 UPPAAL、TLA+、PRISM、SPIN 输入
- `uml-render`、`uml-parse`、`uml-review` 覆盖 UML 前端

它与 dsh 工具逐字节一致，对照见 `tests/python/run.mjs`。模型只有抽取出的状态表时，填充模板 `tools/python/verification-harness.py`。数据模型验证使用 `tools/python/data-model-harness.py`。Python 不可用（例如离线开发机）时，对应 guide 提供手动验证模式。

示例模型见 [`examples/`](examples/README.md)：订单状态机 before/after、电商数据模型、User 字段迁移。

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

ZCode 3.0+ 遵循 Agent Skills 标准。它没有插件市场，手动把技能复制过去：

```bash
git clone https://github.com/AmethystLuna/logicprobe.git
cp -r logicprobe/skills/* .zcode/skills/
```

技能通过 `$logicprobe` 调用。详见 `.zcode/INSTALL.md`。

## 环境要求

- 宿主：Claude Code v2.1+ / Codex CLI 最新 / Cursor 2.5+ / Kimi CLI 最新 / OpenCode 最新 / ZCode 3.0+
- DeepSeek Harness (dsh)：dev preview，声明支持 `>= 0.1.0-rc.7`。最新一轮在 0.2.1-alpha.1 上实测了安装、挂载、启动与卸载；更早一轮实测覆盖 0.1.5-rc.2 到 0.2.0-rc.2。逐版本证据见 [DSH-COMPATIBILITY.md](DSH-COMPATIBILITY.md)。
- Web 端的「Gate 注入」开关需要 **dsh ≥ 0.1.7-alpha.1**，因为设置服务必须能投影即时字段。更早的 dsh 上插件照常加载、照常注入，只是开关不出现，也不报错。
- Python 3.8+（标准库），在 dsh 之外运行验证所需；手动兜底模式不需要任何依赖。

## 配置

在 DeepSeek Harness 中，bundle 支持以下配置：

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 设为 `false` 可关闭首步 Gate 注入。 |
| `gateContent` | string | 内置 gate 文本 | 覆盖注入到首轮模型上下文中的文本。 |
| `interaction` | `ask` \| `auto` \| `follow-approval` | `follow-approval` | 模型确认策略。`follow-approval` 在会话 approval policy 为 `never` 时解析为 `auto`。 |

在 dsh Web GUI 里可以直接改这个开关：侧边栏 **插件** → 本插件卡片 → 「Gate 注入」。它实时生效，不必重启 profile。它只管注入的那段文本：关掉后 skills 与验证工具照常注册。同一张卡片上还有一个更粗粒度的行开关，关掉它会整行卸载插件，技能、工具和这个开关一起消失。要持久化覆盖，仍按下面的 profile patch 写。

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

- 通过 DSH 插件管理器安装的，用同一管理器从目标 profile 中移除 `logicprobe`。
- 手动复制过 `skills/*` 的，删除 `~/.agents/skills/` 或项目 `.dsh/skills/` 下的对应目录。
- 通过 `cordis.patch.yml` 添加的，删除 profile patch 中 `id: logicprobe` 的行，并重启 DSH。

## 权限与数据

- 插件运行时只读取包内自带的 `skills/` 目录，用于通过 DSH 标准 filesystem skill provider 注册技能。
- 它会在会话首轮向模型上下文注入配置好的 gate 文本。
- 它不读取凭据，不发起网络连接，也不访问 DSH 会话上下文之外的用户数据。
- 实际使用技能时，模型会像使用其他编码技能一样，按用户指示读取项目文件。

## 故障排查

- 技能在 DSH 中不可见：确认 DSH 版本支持 `ctx.skills` 与 Agent Skills 发现，并在安装后重启 profile。
- Gate 未注入：检查 `enabled` 是否为 `false`，以及 profile patch 中是否存在 `id: logicprobe` 的行。
- 插件管理器拒绝安装：确认 `@deepseek-ai/*` 包声明在 `peerDependencies` 中，而不是 `dependencies`。
- 手动复制后 DSH 仍看不到技能：改用原生 bundle 安装（`dsh plugin add "github:AmethystLuna/logicprobe"`）。

## 开发

```bash
npm install
npm run typecheck
npm run build
```

测试链：

| 命令 | 内容 |
|---|---|
| `npm run test:engine` | 状态机与数据模型引擎回归（`tests/engine`、`tests/data-engine`、`tests/concurrency`、`tests/uml`、`tests/apply-smoke`、`tests/dsh-client-half`、`tests/exporters`、`tests/external`），再加 Python 逐字节一致性对照。对照脚本是 `tests/python/run.mjs`，它把同一批 fixture 在 TS 引擎与 `tools/python/logicprobe-engine.py` 之间比对报告、组合与导出产物。无 Python 时自动 SKIP。 |
| `npm run test:full` | `tests/full-suite.mjs` 端到端合并套件 |
| `npm run test:python` | 仅 Python parity（构建 + `tests/python/run.mjs`） |
| `bash tests/skill-triggering/run-all.sh` | 触发测试，位于 `tests/skill-triggering/` |

## 许可证与安全

本项目使用 MIT 许可证，见 [LICENSE](LICENSE)。

如发现安全漏洞，请**不要**公开创建 issue，应使用 GitHub Security Advisory 或 [SECURITY.md](SECURITY.md) 中的联系方式私下报告。

## 关联插件

| 插件 | 说明 |
|------|------|
| [embedded-workbench](https://github.com/AmethystLuna/embedded-workbench) | 嵌入式 C/C++ 工具箱，其 Plan Verification Gate 依赖本技能。本插件由 embedded-workbench 拆分而来。 |

## 致谢

声称核查方法论（逻辑原语、对抗探测、重构前后对比）与触发测试框架（`tests/skill-triggering/`）遵循 [Superpowers](https://github.com/obra/superpowers)（Jesse Vincent，MIT License）的约定，经 [embedded-workbench](https://github.com/AmethystLuna/embedded-workbench) 插件改编而来。
