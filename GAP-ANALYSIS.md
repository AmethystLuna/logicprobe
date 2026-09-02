# LogicProbe 覆盖缺口分析（Coverage Gap Analysis）

> 本文盘点 logicprobe 目前 **不覆盖** 的状态机类别与声称域，按「缺失的语义维度」分类，
> 每个维度给出：现状证据、缺口机理、代表性场景、外部专用工具、以及对本插件的扩展切口。

- 核查基线：仓库 `main@7ce1fdf` 起，v0.5.6 → 本地提交 `52151ee`（P0-a/P0-b/P2 主体）、`7a9af54`（coverageNotes 扩到混合/概率）
- 依据文件：`src/engine.ts`、`src/data-engine.ts`、`src/concurrency.ts`、`skills/logicprobe/`、`skills/logicprobe-datamodel/`
- 落地状态：P0-a（cost/budget + A12）、P0-b（onEntry/onExit + A4 动作感知）、P2 部分（报告 `coverageNotes`、并发扫描 `suggestions`、`gap-routing-guide.md`）已在本地实现并全绿，**未发布**。

---

## 0. 内核语义基线（为什么缺口必然存在）

现有引擎是一个 **离散事件、单机、扁平、无时间、无动作副作用的定性可达性模型检查器**：

- 运行时状态 = `(state, vars)`，`vars` 仅 integer / boolean（`engine.ts` 的 `RuntimeState`）；
- 事件按序步进，状态空间 BFS 穷举（上限 `maxStates` 10000）；
- 检查全是 **定性** 性质：S1-S8（可达/死锁/活性/确定性/完备性/不变量/单调）+ A1-A12（意外事件、交错、置换、配对对称、边界、资源、最短反例、幂等、必达、顺序、原子性、预算/最坏路径代价）+ D1-D4（前后回归）；
- 守卫是变量上的静态布尔表达式（`<`/`>`/`==`/`!=` 与 all/any/not），没有时钟、没有表达式算术；
- 官方文档自行划定的边界（`references/logic-verification-guide.md` Known Limitations / Model Fidelity Warning）：
  - *「The Python model does not simulate real-time constraints」* — 时间维缺席；
  - *「The model is single-threaded; true preemptive multitasking bugs are out of scope」* — 抢占并发维缺席；
  - *「models state transitions, not execution semantics」* — 代价/执行语义缺席；
  - *「Nested/hierarchical states (Harel statecharts) are not supported — flatten them manually」* — 结构维缺席；
  - *「Two interacting state machines are verified independently … composition bugs are invisible」* — 组合维缺席。
  - `dsh-model-schema.md` Limits：*「The engine is a finite-state model checker. It cannot prove properties of the real implementation」*。
- 并发只做 **文本挖掘**：README 明写 logicprobe 不证明并发安全，仅标记声称、转交专用验证（绝对声称现在带 `suggestions` 工具建议）。

因此「补一个新检查项」救不了这些缺口——缺的是 **语义维度**。据此把缺口分三类：

| 类别 | 含义 | 补法 |
|---|---|---|
| **A 明示边界** | 文档白纸黑字列为 Known Limitation / Non-Goal | 不实现，提供「转交外部工具」指引（`gap-routing-guide.md`、`coverageNotes`、扫描器 `suggestions`） |
| **B 可近似但低保真** | 可手工退化成现有 schema（展平/伪事件/tick+计数器），但易错且失保真 | 提供结构化辅助，降低人工出错 |
| **C 结构性缺失** | schema 里连近似字段都没有 | 需要新字段或新机器种类 |

---

## 1. 缺口总览（覆盖矩阵）

| # | 缺失语义维度 | 类别 | 现状 / 现有机制 | 仍无法验证的声称类型 | 代表场景 | 外部工具域 |
|---|---|---|---|---|---|---|
| D1 | 时间（timed） | C（可部分 B） | 计数器+tick 近似；报告 `coverageNotes` 提示并路由 UPPAAL | 「500ms 内必达 SAFE」「不 miss deadline」 | 看门狗、超时预算、周期任务 | UPPAAL / IMITATOR |
| D2 | 执行代价 / WCET（性能敏感） | C → **部分关闭（P0-a）** | `cost`（缺省 1）+ `budget` 不变量 + A12（最短超预算反例、正成本环=无界）；无 budget 时 A12_COST_WITHOUT_BUDGET 提示 | 真实 WCET / 执行时间测量（cost 只是模型标注） | 表驱动分发器、临界区长度 | aiT / RapiTime（二进制级） |
| D3 | 抢占 / 真并发 | A（明示不覆盖） | `concurrentPairs` 交错 + 扫描 `suggestions`(TSan/CBMC/TLA+/RTOS) + coverageNotes | 「ISR 与任务间无竞争」「无优先级反转」 | ISR 推进 + 主循环消费 | TLA+ / CBMC / TSan / RTOS 专项 |
| D4 | 连续-离散混合（hybrid） | A | coverageNotes 提示并路由 SpaceEx/Flow*/Stateflow | 「切换后稳定」「无抖动」 | 控制律切换、FOC 模式切换 | SpaceEx / Flow* / Stateflow |
| D5 | 层次 / 正交结构（statechart） | B（手展平，保真风险） | 扁平 states；文档指引手工展平 | 父态守卫、history、正交互斥 | 嵌套运行态、电源管理 ∥ 通信 | SCXML / Stateflow（原生支持） |
| D6 | 多机组合 / 跨子系统协议 | A（文档承认不可见） | 单机验证 + 手工契约文档 | 「A 发事件时 B 必能处理」 | 主备切换、上下电跨模块时序 | CSP（FDR）/ mCRL2 / TLA+ |
| D7 | 动作语义（entry/exit/do + 副作用） | B → **部分关闭（P0-b）** | 状态 `onEntry`/`onExit` 声明，A4 自动按隐式 acquire/release 配对（不再需要手工伪事件） | do-while 动作、动作内复杂副作用语义 | 安全态进入动作、资源清理 | 状态机代码生成 + 静态分析 |
| D8 | 概率 / 随机（stochastic） | A | coverageNotes 提示并路由 PRISM/Storm/故障树 | 「MTBF ≥ X」「故障率 ≤ p」 | 可靠性预算、降级策略评估 | PRISM / Storm / 故障树 |
| D9 | 资源容量 / 饥饿 / 公平 | C | `resourcePairs` 只做定性配对 | 「队列不溢出」「无饥饿」 | 信号量计数、有界队列 | 模型检查带容量（UPPAAL 等） |
| D10 | 数据域性能 / 容量 | A（datamodel 引擎 Non-Goal） | 无 | 「迁移在窗口内完成」「表不膨胀」 | 大数据量迁移、索引代价 | Flyway 压测 / 数据库专项 |

> 一个真实对象通常同时落在多个维度。以「控制系统性能敏感状态机」为例：
> 模态切换正确性 → D1+D4；分发/临界区代价 → D2（A12 已可查模型内标注预算）；ISR 共享状态 → D3；嵌套模式 → D5。

---

## 2. 各维度详情

### D1 时间维 —— 实时 / 定时状态机（timed automata）

- 现状：时间只能建模成「整数计数器 + tick 事件 + 守卫」；报告对 timeout/watchdog/timer/deadline 等词汇给出 `coverageNotes` 并路由 UPPAAL。
- 缺口：没有时钟变量、没有「状态内时间不变量（clock ≤ deadline）」、没有真正的期限/超时进度语义。
- 扩展切口：新增 `clock` 变量种类 + 期限类不变量（或独立的 `TimedLogicModelV1`）；状态空间爆炸需沿用 maxStates 截断并明示。

### D2 执行代价维 —— 性能敏感 / 最坏情形（cost / WCET）【控制系统最贴切】

- 现状（P0-a 已落地，`52151ee`）：`TransitionSpec.cost`（缺省 1）+ `kind:"budget"` 不变量 + A12：报告最短超预算反例路径；可达正成本环判定为无界；声明 cost 而无 budget 时给 `A12_COST_WITHOUT_BUDGET` 提示。
- 仍缺：`cost` 是模型标注的静态标签，不是实测执行时间；真实 WCET 需二进制级工具。路径语义要求预算机无「可重复的正成本环」——这类环要先用计数器/守卫界住。
- 场景：switch/表驱动分发器的最坏分发延迟；迁移内临界区/关中断长度；进入某状态触发的重配置开销累计。

### D3 抢占并发维 —— ISR / RTOS 驱动状态机

- 现状：单线程事件模型；`concurrentPairs` 只测「两个事件按两种顺序到达的结果差」；`logicprobe_concurrency_scan` 对绝对声称（thread-safe、interrupt-safe…）输出 error + `suggestions`（TSan/CBMC/TLA+/RTOS）；README 明写不证明并发安全。
- 缺口：状态字段跨 ISR/任务的数据竞争、优先级反转、嵌套中断下的状态撕裂。
- 结论：维持 A 类边界，路由闭环已完成（报告 coverageNotes + 扫描器 suggestions + 路由表）。

### D4 连续-离散混合维 —— 模态切换控制（hybrid automata）

- 现状：无连续量概念；coverageNotes 对 pid/plant/feedback/stability/motor 等词汇提示并路由 SpaceEx/Flow*/Stateflow。
- 结论：A 类边界；logicprobe 只负责识别并转交，不代验稳定性/防抖等性质。

### D5 结构维 —— 层次 / 正交状态机（statechart）

- 现状：只支持扁平 FSM；文档指引手工展平。
- 扩展切口（未实现）：提供 **自动展平器 + round-trip 对照**，把 B 类缺口的保真风险从「人肉」降到「机器+人确认」。

### D6 组合维 —— 多机 / 跨子系统协议

- 现状：单机独立验证；指南明确 *「composition bugs … invisible」*。
- 扩展切口（未实现）：双机组合可达性 / 跨机契约表。

### D7 动作语义维 —— entry/exit/do-action 与副作用

- 现状（P0-b 已落地，`52151ee`）：状态 `onEntry`/`onExit` 声明动作列表，A4 按进入/离开自动触发 acquire/release 语义配对（含单列表内重复获取警告、终态持锁、无 release 事件等代码），不再需要手工 `ENTER_x/EXIT_x` 伪事件。
- 仍缺：动作语义只服务配对类检查（A4）；do-while、动作内复杂副作用仍需外部建模。

### D8 概率维（简）

- 无概率语义；coverageNotes 对 mtbf/failure rate/markov 等词汇提示并路由 PRISM/Storm/故障树。A 类边界。

### D9 资源容量维（简）

- `resourcePairs` 只查定性配对；无容量/计数耗尽/饥饿概念。维持边界或转交带容量模型检查器。

### D10 数据域性能/容量（datamodel 引擎侧，简）

- datamodel 技能 Non-Goals 明写非 SQL 迁移执行器、非运行时数据质量平台；迁移耗时/数据量/索引代价不在范围内，属 A 类。

---

## 3. 扩展候选与优先级（含落地状态）

| 候选 | 面向维度 | 类型 | 状态 |
|---|---|---|---|
| state/transition 可选 `cost` + 预算检查（A12，最短超预算反例 + 正成本环检测） | D2 | 引擎增强 | ✅ 已实现（52151ee），全绿 |
| `onEntry`/`onExit` 声明 → A4 自动配对 | D7 | 引擎增强 | ✅ 已实现（52151ee），全绿 |
| 报告尾部 `coverageNotes`（时序/抢占词汇 → 工具路由） | D1/D3 | 报告增强 | ✅ 已实现（52151ee） |
| `coverageNotes` 扩到 hybrid/概率词汇（SpaceEx/PRISM 路由） | D4/D8 | 报告增强 | ✅ 已实现（7a9af54），全绿 |
| 并发扫描绝对声称带 `suggestions` 工具建议 | D3 | 扫描增强 | ✅ 已实现（52151ee），全绿 |
| 外部工具路由表（`gap-routing-guide.md` + SKILL/schema/README 同步） | A 类全域 | 文档 | ✅ 已实现（本轮文档提交） |
| `clock` 变量 + 期限不变量（TimedLogicModelV1） | D1 | 新机器种类 | ⏳ 未实现（风险：状态空间爆炸） |
| 双机组合可达性 / 跨机契约表 | D6 | 新检查/新工具 | ⏳ 未实现 |
| statechart 自动展平 + round-trip 确认 | D5 | 工作流工具 | ⏳ 未实现 |
| 文档散文级「域声称扫描」`runDomainScan` | D1/D4/D8 | 旁路新出口 | ⏳ 未实现（可选，与 coverageNotes 互补） |
| 真并发证明 / hybrid 稳定性 / 精确 WCET / 概率验证 | D3/D4/D2/D8 | 明确不实现 | ⛔ 保持 Non-Goal，路由闭环代替 |

### 横切建议（已部分落地）

- ✅ 报告的 `coverageNotes` 即为「未覆盖维度提示」：S/A 全过但对象含时序/抢占/混合/概率词汇时，报告附注并给外部工具。
- ✅ 扫描器从「挖掘风险词」升级为「缺口-工具路由」：并发绝对声称带 `suggestions`；跨维度路由见 `gap-routing-guide.md`。
- ✅ A12 的 `A12_COST_WITHOUT_BUDGET` 提示代价维「声明了 cost 却没声明预算」。

---

## 4. 后续可执行方向（我们还能做什么）

| 方向 | 动作 | 状态 |
|---|---|---|
| A. 沉淀 | GAP-ANALYSIS.md + en-US 版；与上游/issue 对齐 | 本文件已入库（未发布）；en-US 未写 |
| B. P0-a cost 预算检查 | schema/引擎/报告/测试 | ✅ 完成 |
| C. P0-b entry/exit 声明 | 展开 + A4/A6 覆盖 + 回归 | ✅ 完成（A6 注入仍以事件/状态名为准） |
| D. 实证 | 真实控制系统/性能敏感状态机入 examples | ⏳ 未做 |
| E. 路由表/技能参考 | gap-routing-guide + 文档同步 | ✅ 完成 |
| F. 发布前 | markdownlint、README 双语核对、`npm run test:*` 全绿、重新安装 profile bundle | ⏳ 未发布（用户要求暂缓） |

---

## 5. 附录

### A. 现有检查索引（供缺口映射）

- 状态机：S1 可达 / S2 死锁 / S3 活性 / S4 确定性 / S5 事件完备 / S6 守卫完备 / S7 不变量 / S8 单调；A1 意外事件 / A2 竞态交错 / A3 顺序置换 / A4 配对对称（含 onEntry/onExit 动作）/ A5 边界 / A6 资源注入 / A7 最短反例 / A8 幂等重放 / A9 必达 / A10 顺序 / A11 原子性 / A12 预算（最坏路径代价）；
  D1-D4 前后回归。
- 数据模型：DS1-DS4 / DA1-DA12 / DD1-DD4（镜像 S/A/D）。

### B. 外部工具速查

- 时间：UPPAAL、IMITATOR；
- 混合：SpaceEx、Flow*、Simulink/Stateflow；
- 并发/交错：TLA+、CBMC、mCRL2、CSP(FDR)、TSan/Helgrind；
- 代价/性能：aiT、RapiTime（二进制级 WCET）；
- 概率：PRISM、Storm；
- 运行时验证（配套而非替代）：RTLola、Copilot。

### C. 证据引用清单

- `src/engine.ts`：`LogicModelV1`、`RuntimeState{state, vars}`、S/A/D 检查实现、A12/coverageNotes；
- `src/data-engine.ts`：`DataModelV1`、DS/DA/DD 实现；
- `src/concurrency.ts` + `skills/logicprobe/references/concurrency-risk-guide.md`：并发挖掘 + 绝对声称 suggestions；
- `skills/logicprobe/references/logic-verification-guide.md`：Known Limitations / Model Fidelity Warning；
- `skills/logicprobe/references/dsh-model-schema.md`：Limits 段、Guards/Updates/cost/onEntry/onExit 语义；
- `skills/logicprobe/references/gap-routing-guide.md`：外部工具路由表；
- `skills/logicprobe-datamodel/SKILL.md`：Non-Goals；
- `README.md` / `README.en-US.md`：功能表与「不证明并发安全」声明。
