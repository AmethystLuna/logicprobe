# LogicProbe 覆盖缺口分析（Coverage Gap Analysis）

> 本文盘点 logicprobe 目前 **不覆盖** 的状态机类别与声称域，按「缺失的语义维度」分类，
> 每个维度给出：现状证据、缺口机理、代表性场景、外部专用工具、以及对本插件的扩展切口。

- 核查基线：仓库 `main@7ce1fdf` / package v0.5.6（与 dsh 安装的 `dsh-logicprobe` 同源）
- 依据文件：`src/engine.ts`、`src/data-engine.ts`、`src/concurrency.ts`、`skills/logicprobe/`、`skills/logicprobe-datamodel/`

---

## 0. 内核语义基线（为什么缺口必然存在）

现有引擎是一个 **离散事件、单机、扁平、无时间、无动作副作用的定性可达性模型检查器**：

- 运行时状态 = `(state, vars)`，`vars` 仅 integer / boolean（`engine.ts` 的 `RuntimeState`）；
- 事件按序步进，状态空间 BFS 穷举（上限 `maxStates` 10000）；
- 检查全是 **定性** 性质：S1-S8（可达/死锁/活性/确定性/完备性/不变量/单调）+ A1-A11（意外事件、交错、置换、配对对称、边界、资源、最短反例、幂等、必达、顺序、原子性）+ D1-D4（前后回归）；
- 守卫是变量上的静态布尔表达式（`<`/`>`/`==`/`!=` 与 all/any/not），没有时钟、没有表达式算术；
- 官方文档自行划定的边界（`references/logic-verification-guide.md` Known Limitations / Model Fidelity Warning）：
  - *「The Python model does not simulate real-time constraints」* — 时间维缺席；
  - *「The model is single-threaded; true preemptive multitasking bugs are out of scope」* — 抢占并发维缺席；
  - *「Entry/exit actions are not modeled as events」* — 动作语义缺席，只能手工抽伪事件；
  - *「Nested/hierarchical states (Harel statecharts) are not supported — flatten them manually」* — 结构维缺席；
  - *「Two interacting state machines are verified independently … composition bugs are invisible」* — 组合维缺席；
  - *「models state transitions, not execution semantics」* — 代价/执行语义缺席。
  - `dsh-model-schema.md` Limits：*「The engine is a finite-state model checker. It cannot prove properties of the real implementation」*。
- 并发只做 **文本挖掘**：README 明写 logicprobe 不证明并发安全，仅标记声称、转交专用验证。

因此「补一个新检查项」救不了这些缺口——缺的是 **语义维度**。据此把缺口分三类：

| 类别 | 含义 | 补法 |
|---|---|---|
| **A 明示边界** | 文档白纸黑字列为 Known Limitation / Non-Goal | 不实现，提供「转交外部工具」指引 |
| **B 可近似但低保真** | 可手工退化成现有 schema（展平/伪事件/tick+计数器），但易错且失保真 | 提供结构化辅助，降低人工出错 |
| **C 结构性缺失** | schema 里连近似字段都没有 | 需要新字段或新机器种类 |

---

## 1. 缺口总览（覆盖矩阵）

| # | 缺失语义维度 | 类别 | 现有最接近机制 | 无法验证的声称类型 | 代表场景 | 外部工具域 |
|---|---|---|---|---|---|---|
| D1 | 时间（timed） | C（部分可 B） | 计数器变量 + tick 事件 + 守卫 | 「500ms 内必达 SAFE」「不 miss deadline」 | 看门狗、超时预算、周期任务 | UPPAAL / IMITATOR |
| D2 | 执行代价 / WCET（性能敏感） | C | 无（转移不带权） | 「最坏路径 ≤ 预算」「分发延迟 O(1)」 | 表驱动分发器、临界区长度 | aiT / RapiTime / 静态时序分析 |
| D3 | 抢占 / 真并发 | A（明示不覆盖） | `concurrentPairs` 事件交错 + 并发扫描 | 「ISR 与任务间无竞争」「无优先级反转」 | ISR 推进 + 主循环消费 | TLA+ / CBMC / RTOS 专用分析 |
| D4 | 连续-离散混合（hybrid） | A | 无 | 「切换后稳定」「无抖动」 | 控制律切换、FOC 模式切换 | SpaceEx / Flow* / Stateflow |
| D5 | 层次 / 正交结构（statechart） | B（手展平，保真风险） | 扁平 states 列表 | 父态守卫、history、正交互斥 | 嵌套运行态、电源管理 ∥ 通信 | SCXML / Stateflow（原生支持） |
| D6 | 多机组合 / 跨子系统协议 | A（文档承认不可见） | 单机验证 + 手工契约文档 | 「A 发事件时 B 必能处理」 | 主备切换、上下电跨模块时序 | CSP（FDR）/ mCRL2 / TLA+ |
| D7 | 动作语义（entry/exit/do + 副作用） | B（手工伪事件） | 无；A4 只能碰显式事件 | 「进入 FAULT 必关 PWM」「退出必 unlock」 | 安全态进入动作、资源清理 | 状态机代码生成 + 静态分析 |
| D8 | 概率 / 随机（stochastic） | A（无概率语义） | 无 | 「MTBF ≥ X」「故障率 ≤ p」 | 可靠性预算、降级策略评估 | PRISM / Storm / 故障树 |
| D9 | 资源容量 / 饥饿 / 公平 | C | `resourcePairs` 只做定性配对 | 「队列不溢出」「无饥饿」 | 信号量计数、有界队列 | 模型检查带容量（UPPAAL 等） |
| D10 | 数据域性能 / 容量 | A（datamodel 引擎 Non-Goal） | 无 | 「迁移在窗口内完成」「表不膨胀」 | 大数据量迁移、索引代价 | Flyway 压测 / 数据库专项 |

> 一个真实对象通常同时落在多个维度。以「控制系统性能敏感状态机」为例：
> 模态切换正确性 → D1+D4；分发/临界区代价 → D2；ISR 共享状态 → D3；嵌套模式 → D5。

---

## 2. 各维度详情

### D1 时间维 —— 实时 / 定时状态机（timed automata）

- 现状：时间只能建模成「整数计数器 + tick 事件 + 守卫」，属离散近似；A5 指南里对 millis 回绕的建议是人工核对。
- 缺口：没有时钟变量、没有「状态内时间不变量（clock ≤ deadline）」、没有真正的期限/超时进度语义。
- 无法验证：「500ms 内从 ERROR 到 SAFE」「每次轮询周期 ≤ 1ms」「绝不在 ACTIVE 停留超过 T」。
- 工具：UPPAAL（时钟 + 可达/不可达 + 代价最优）、IMITATOR（参数化期限）。
- 扩展切口：新增 `clock` 变量种类 + 期限类不变量（或独立的 `TimedLogicModelV1`）；风险是状态空间爆炸，需沿用 maxStates 截断并明示。

### D2 执行代价维 —— 性能敏感 / 最坏情形（cost / WCET）【控制系统最贴切】

- 现状：`TransitionSpec` 只有 from/event/to/guard/updates，`StateSpec` 只有 id/terminal——**任何地方都不带权**；检查只数步数与可达性。
- 缺口：路径无代价概念 → 无法表达「最坏路径总代价 ≤ 预算」「单次分发 ≤ 50 周期」。
- 场景：switch/表驱动分发器的最坏分发延迟；迁移内临界区/关中断长度；进入某状态触发的重配置开销累计。
- 工具：aiT / RapiTime（真实 WCET，需二进制级分析）；本插件做不了精确 WCET，但可做「带静态代价注释的预算检查」。
- 扩展切口（低成本、纯引擎内增强）：给 state/transition 加可选 `cost`（标量周期/纳秒），新增检查「任意可达路径代价 ≤ budget」并给出最短超预算反例路径——即把 A 系列「数步数」升级为「算带权和」。

### D3 抢占并发维 —— ISR / RTOS 驱动状态机

- 现状：单线程事件模型；`concurrentPairs` 只能测「两个事件按两种顺序到达的结果差」，测不了「动作中途被抢占」；`concurrency_scan` 只做文本挖掘，README 明写 *「logicprobe does not prove concurrency safety」*。
- 缺口：状态字段跨 ISR/任务的数据竞争、优先级反转、嵌套中断下的状态撕裂、原子性被抢占破坏。
- 工具：TLA+（细粒度交错）、CBMC/静态数据竞争分析、RTOS 专项（优先级/锁序）。
- 结论：维持 **A 类边界**，把文档与扫描器升级为「检测到抢占声称 → 建议专用工具」的路由器。

### D4 连续-离散混合维 —— 模态切换控制（hybrid automata）

- 现状：无连续量概念。
- 缺口：切换后的稳定性、状态跳变、防抖/颤振、驻留时间——纯离散模型无法建模被控对象。
- 工具：SpaceEx / Flow*（hybrid 可达性）、Simulink/Stateflow 验证。
- 结论：A 类边界；logicprobe 应把这类声称识别出来并转交，而非假装能查。

### D5 结构维 —— 层次 / 正交状态机（statechart）

- 现状：只支持扁平 FSM；指南要求手工展平。
- 缺口：手工展平是「模型提取错误」重灾区——父态守卫、history、正交区互斥在展平中丢失/改写，而提取错误正是官方承认的头号失败模式。
- 扩展切口：不是实现 Harel 语义，而是提供 **自动展平器 + round-trip 对照**：展平结果再渲染回表格给用户确认，把 B 类缺口的保真风险从「人肉」降到「机器+人确认」。

### D6 组合维 —— 多机 / 跨子系统协议

- 现状：单机独立验证；指南明确 *「composition bugs … invisible」*。
- 缺口：A 发事件给 B 时 B 不在可处理状态；主备切换握手；上下电跨模块时序。
- 扩展切口：双机组合检查（两台 LogicModelV1 + 握手事件对 + 组合可达性/死锁），或先做轻量「契约表」验证（每个跨机事件在对方所有可达态的接收性）。
- 工具参考：CSP(FDR)/mCRL2/TLA+。

### D7 动作语义维 —— entry/exit/do-action 与副作用

- 现状：不建模动作；A4 配对对称只看到显式事件，可能漏掉只存在于 entry/exit 的 lock/unlock 不平衡（指南承认，要求手工抽 `ENTER_x/EXIT_x` 伪事件）。
- 扩展切口：状态上结构化声明 `onEntry`/`onExit` 事件序列 → 引擎自动展开为伪事件并纳入 A4/A6 检查——把 B 类手工步骤变成声明式、可回归。

### D8 概率维（简）
- 无概率语义；可靠性类声称（MTBF、故障率）A 类边界，转 PRISM/Storm/故障树。

### D9 资源容量维（简）
- `resourcePairs` 只查定性配对；无容量/计数耗尽/饥饿概念。加容量需语义扩展（C 类），或维持边界转交带容量模型检查器。

### D10 数据域性能/容量（datamodel 引擎侧，简）
- datamodel 技能 Non-Goals 明写非 SQL 迁移执行器、非运行时数据质量平台；设计期静态校验。迁移耗时/数据量/索引代价不在范围内，属 A 类。

---

## 3. 扩展候选与优先级

| 候选 | 面向维度 | 类型 | 改动面 | 回归面 | 风险 | 优先级 |
|---|---|---|---|---|---|---|
| state/transition 可选 `cost` + 预算检查（最坏带权路径 ≤ budget，附最短超预算反例） | D2 | 引擎增强（C 转支持） | schema 字段 + 新检查 + 报告 | tests/engine | 低；语义清晰、纯增量 | P0 |
| `onEntry`/`onExit` 声明 → 自动伪事件展开，纳入 A4/A6 | D7 | 引擎增强 | schema 字段 + 展开器 | tests/engine | 中；需与「同一状态可重入」语义对齐 | P0 |
| `clock` 变量 + 期限不变量（TimedLogicModelV1） | D1 | 新机器种类 | 新 schema/校验/探索器 | 新增 test 套件 | 高；状态空间爆炸 | P1 |
| 双机组合可达性 / 跨机契约表 | D6 | 新检查或新工具 | 引擎或独立入口 | 新增 | 高；语义设计需谨慎 | P1 |
| 自动展平 + round-trip 确认（工作流辅助，不做 Harel 语义） | D5 | 工作流工具 | 独立脚本/提示流程 | 无引擎改动 | 低 | P1 |
| 声称分级 → 外部工具路由（检测到 D3/D4/D8 声称时建议 UPPAAL/SpaceEx/PRISM 等并给理由） | A 类全域 | 文档+扫描增强 | concurrency 扫描升级 | 现有扫描测试 | 低 | P2 |
| 真并发证明 / hybrid 稳定性 / 精确 WCET / 概率 | D3/D4/D2/D8 | 明确不实现 | 无 | 无 | - | 保持 Non-Goal，文档化 |

### 横切建议
- 把「缺口类别」写进每个报告的尾部：S/A 全过但对象含 D2 类性能声称时，报告追加 *「本验证未覆盖执行代价维度」*——防止模型检查通过 = 误以为全部正确。
- 扫描器从「挖掘风险词」升级为「缺口-工具路由」：命中抢占/混合/概率声称 → 输出建议的外部工具与理由，形成闭环。

---

## 4. 后续可执行方向（我们还能做什么）

| 方向 | 动作 | 产出 | 验收 |
|---|---|---|---|
| A. 沉淀 | 本文件入库（必要时分 en-US 版）；与上游/issue 对齐 | GAP-ANALYSIS.md | 评审通过 |
| B. P0：cost 预算检查 | schema 加 cost、新增预算不变量与最短超预算反例、tests/engine 补测 | 引擎增强 | `npm run test:engine` 绿 |
| C. P0：entry/exit 声明 | 展开器 + A4/A6 覆盖 + 回归测试 | 引擎增强 | 同上 + 1 个示例 |
| D. 实证 | 选一个真实「性能敏感/ISR 驱动」状态机建模，跑现有检查，标注命中的缺口维，写进 examples | examples 用例 | 文档化每个维度的失败模式 |
| E. 路由表 | 将 D3/D4/D8 等 A 类维度的外部工具建议写进技能参考 | skills 参考补充 | 触发用例通过 |

---

## 5. 附录

### A. 现有检查索引（供缺口映射）
- 状态机：S1 可达 / S2 死锁 / S3 活性 / S4 确定性 / S5 事件完备 / S6 守卫完备 / S7 不变量 / S8 单调；A1 意外事件 / A2 竞态交错 / A3 顺序置换 / A4 配对对称 / A5 边界 / A6 资源注入 / A7 最短反例 / A8 幂等重放 / A9 必达 / A10 顺序 / A11 原子性；D1-D4 前后回归。
- 数据模型：DS1-DS4 / DA1-DA12 / DD1-DD4（镜像 S/A/D）。

### B. 外部工具速查
- 时间：UPPAAL、IMITATOR；
- 混合：SpaceEx、Flow*、Simulink/Stateflow；
- 并发/交错：TLA+、CBMC、mCRL2、CSP(FDR)；
- 代价/性能：aiT、RapiTime（二进制级 WCET）；
- 概率：PRISM、Storm；
- 运行时验证（配套而非替代）：RTLola、Copilot。

### C. 证据引用清单
- `src/engine.ts`：`LogicModelV1`、`RuntimeState{state, vars}`、S/A/D 检查实现；
- `src/data-engine.ts`：`DataModelV1`、DS/DA/DD 实现；
- `src/concurrency.ts` + `skills/logicprobe/references/concurrency-risk-guide.md`：并发只做挖掘；
- `skills/logicprobe/references/logic-verification-guide.md`：Known Limitations / Model Fidelity Warning；
- `skills/logicprobe/references/dsh-model-schema.md`：Limits 段、Guards/Updates 语义；
- `skills/logicprobe-datamodel/SKILL.md`：Non-Goals；
- `README.md` / `README.en-US.md`：功能表与「不证明并发安全」声明。
