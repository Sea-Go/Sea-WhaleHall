# 动态计划编排 · 修正版落地方案（对齐现有 PlanningRuntime 架构）

状态：**实施前审阅稿**。本文是对一份外部 AI 三层重构蓝图（日历 Ontology 层 / 强弱节点评判 / 仿 Claude Code 动态 DAG 调度器 / 粗细粒度分流）的逐条核实与修正。核实结论：该蓝图约一半事实声明与代码不符，其新增层与本仓四条架构边界冲突；本文保留其问题意识，把可落地的部分重新对齐到现有模块内，不新建平行体系。

> 前置警告（P0）：当前工作区的 planning 域存在大量未提交 WIP（`src/agent/planning/*`、`src/bun/index.ts`、`src/bun/planning-runtime.ts`、`src/agent/mastra-host/protocol.ts`、全部相关测试均有改动）。本文任何工作流都必须在 WIP 处置（提交或明确归属）之后、从干净基线开始实施。改码前停 dev watch；启动前清点旧实例（项目既有约定）。

---

## 0. 与原方案的关系：保留什么、纠正什么

| 原方案主张 | 核实结果 | 本文处置 |
| --- | --- | --- |
| 单个 `planningAnalysis` 过载、4.2MB 思考失控、invalid-output 循环 | ✅ 属实（[runtime.ts:531](../src/agent/mastra-host/runtime.ts) 注释记录实测；`PLANNING_OUTPUT_INVALID` → `PlanningModelInvocationError("invalid-output")` 链路真实） | 保留问题，方案改为 W2（策略对象化），不引入失败路径模型仲裁 |
| 日历是"散装 CRUD、无领域不变量、无硬软区分" | ❌ 不符：7 条自动变更不变量、kind/state/userLocked 契约、版本化 ChangeSet + undo 全部已存在 | 放弃 ontology 层与 `CalendarBlockObject`，改为 W4 处置死代码 |
| "无滚动视界、伪排期、缺准点闭环" | ❌ 大半不符：7 天确定性排程 + 今天冻结 + 排不下检查点 + 60s 维护循环按本地日期幂等的每日结算已存在；**唯一缺口是结算钟点不可配置** | 收敛为 W1（钟点锚定） |
| "强弱分级由模型主观乱评、无客观机制" | ⚠️ 半假：任务级 `relevance: strong/weak` 契约 + 用户 override + 降级确认门 + 调度排序已构成完整治理链；缺的只是**确定性第三信号源** | 收敛为 W3 |
| tools.ts 8 个工具从未挂载 | ✅ 属实，且更深：`toolProposals` 全仓无写入点，审批挂起垂直切片整体休眠 | W4 |
| 特权/非特权模型隔离、多子代理并行 DAG、意图分流 | 与现有单调用 + 快照注入 + 服务端网关工具环的架构不符；失败路径再调模型 = 增加失败面 | 不做，理由见 §1、§4.1 |

原方案的四个工程步骤（ontology 类 / criticality-engine / wave-runner / DAG 编排）**全部不实施**。替代工作流：W1–W4，各自独立可交付、可回滚。

---

## 1. 架构铁律（本方案不可违反的四条边界）

1. **编排与持久状态归 Bun**。`analyzeDynamicPlanning` 注释明确 "Durable plan state, scheduling, proposals, retries and idempotency remain Bun-owned"（[mastra-host/runtime.ts:501](../src/agent/mastra-host/runtime.ts)）；`MastraPlanningModel` 注释同样声明确定性排程留在 PlanningRuntime（[bun/mastra-planning-model.ts:38](../src/bun/mastra-planning-model.ts)）。任何重试、超时、仲裁逻辑不得移入 mastra-host。
2. **日历域契约 = `CalendarEvent`**。`kind: plan|manual-block|external|break`、`state: proposed|committed`、`userLocked`、`version`（[planning-analysis.ts:123-142](../src/agent/mastra-host/planning-analysis.ts) 输入契约即此）；写路径必须走 `CalendarChangeSet` 版本化提交（带 `canUndo` 的 adjustment 记录）。不引入 rigidity 二元模型——硬/软已由 `kind + scheduleOrigin + userLocked` 表达。
3. **时区正确性**。排期代码只用 `temporal-polyfill` / 现有 `time.ts` 纯函数（`localDateAt`、`compareInstants` 等）；禁止 `Date.parse` + `toISOString` 直排。CALENDAR_STANDARD 的命名时区测试要求适用于所有新代码。
4. **排期落位由确定性调度器完成**。`buildDeterministicSevenDaySchedule`（[scheduler.ts:46](../src/agent/planning/scheduler.ts)）是唯一落位算法；模型产出结构化提案（含 exact schedule 供核对），运行时以确定性重排为准。模型输入走快照注入（`dynamicPlanningInputSchema`），不走本地工具挂载。

---

## 2. 现状事实底座（本文全部设计的依据锚点）

| 机制 | 位置 | 语义 |
| --- | --- | --- |
| 维护循环 | [bun/index.ts:3714-3725](../src/bun/index.ts) | `setInterval(60_000)` 跑 `runPlanningMaintenance`，`planningMaintenanceRunning` 防重入；循环内容：flushOutbox → recoverPendingAdjustments → runDailySummaries → timeline 输入消费 |
| 每日结算 | [bun/planning-runtime.ts:298](../src/bun/planning-runtime.ts) | 遍历 active/paused 计划，按 `plan.timeZone` 取本地日期，`dailySummaryDates` 去重后调 `runDailySummary` |
| 结算幂等 | [planning/runtime.ts:877](../src/agent/planning/runtime.ts) | operation replay（`daily:{planId}:{localDate}`）+ staged operation + 日期标记 → `analyzePlan(daily-summary, auto)` |
| 确定性排程 | [scheduler.ts:46](../src/agent/planning/scheduler.ts) | 7 天窗口（精确 7 天校验）、`mutableStartDate`（自动调整 = 明天起可动，今天整体冻结）、拓扑排序、可用窗口、忙时计算；weak 任务排序靠后（:297-299） |
| 自动变更不变量 | [time.ts:167](../src/agent/planning/time.ts) | 7 条：not-plan-event / different-plan / not-model-generated / user-locked / today-frozen / already-started / completed-task |
| 变更集与回滚 | [planning/runtime.ts:2021](../src/agent/planning/runtime.ts) | `buildCalendarChangeSet` 版本化 create/update/delete；自动调整入口 `prepareAndApplyAdjustment`（:1343）；排不下走 `persistUnscheduledAutomaticCheckpoint`（:1355）；adjustment 带 canUndo |
| 强弱治理链 | 契约 [planning-analysis.ts:184](../src/agent/mastra-host/planning-analysis.ts)（漏标默认 strong，:362-369）→ 用户覆盖 `relevanceOverride`（[runtime.ts:480-524](../src/agent/planning/runtime.ts)）→ 降级确认门 `revisionDemotesStrongTasks`（:1837，未确认抛 `relevance-demotion-unacknowledged` :343）→ 调度排序（scheduler.ts:297） |
| 失败分类 | [bun/mastra-planning-model.ts:107,123](../src/bun/mastra-planning-model.ts) | `invalid-output` / `request-timeout` / `cancelled` / `model-unavailable`，retryable 标记 → `persistAnalysisFailure` 落 `analysisDiagnostic`（[planning/runtime.ts:1023, 2313-2334](../src/agent/planning/runtime.ts)），`trigger: "resume"` 手动续跑 |
| 降级梯 | [mastra-host/runtime.ts:529-599](../src/agent/mastra-host/runtime.ts) | 首轮带工具 16k token/≤240s → 超时后 `toolChoice: "none"` 裸跑 8k/≤150s；中继护栏 `MAX_MODEL_RELAY_CHUNK_BYTES`（[model-relay.ts:208](../src/agent/mastra-host/model-relay.ts)）兜住真失控 |
| 死路垂直 | [tools.ts:54](../src/agent/mastra-host/tools.ts)（全仓唯一引用）、[agents.ts:76](../src/agent/mastra-host/agents.ts)（`executeTool` 声明未用）、[runtime.ts:1261/1771](../src/agent/mastra-host/runtime.ts)（`toolProposals` 只读，无写入点）、protocol.ts:241-242/294-295/442-443、host-adapters.ts、bun/agent-run-coordinator.ts、client AppShell.tsx + ConversationController.ts、tests/mastra-host.test.ts | 8 工具 + 审批挂起整体不可达：对话 Agent 刻意 text-only（conformance gate 未过，agents.ts:133-136），计划模型刻意快照注入，网关检索工具走服务端工具环不落本地审批 |

---

## 3. W1：每日结算钟点锚定（准点 daily-summary）

### 3.1 现状与真实缺口

维护循环每 60s 检查一次，`runDailySummaries` 以"本地日期"为幂等键 → 实际触发时点是**本地日期翻转后的第一个 tick（≈00:00–00:01）**，即对刚结束的那一天做事后结算。结算语义本身完整（幂等、staged、auto-apply），缺的只有一件事：**结算钟点不可配置**。原方案设想的"晚间 21:30 结算当日、随即预排隔天"中，"预排隔天"已由现有 7 天窗口 + `mutableStartDate=明天` 的自动调整天然覆盖，无需新机制。

### 3.2 设计

- Bun 侧新增配置 `planningSettlementLocalTime: "HH:mm" | null`（`null` = 现行行为，默认保持现行）。挂载点：planningRuntime 构造 options（bun/index.ts planning 生命周期段，`planningMaintenanceTimer` 声明在 :930）。
- `runDailySummaries`（bun/planning-runtime.ts:298）增加锚点判断：`time.ts` 新增纯函数 `localTimeAt(nowMs, timeZone): "HH:mm"`（现有 `localDateAt` 在 :49，可对照实现）；仅当 `localTimeAt(now, plan.timeZone) >= settlementTime` 才结算当前日期。多时区计划各自按本时区锚点判断。
- **不改** planning/runtime.ts 的幂等结构（`dailySummaryDates` / operation replay 原样保留）。应用关闭错过锚点的回退 = 现行"日期翻转首 tick"行为自然兜底（锚点时刻未运行则午夜后照常结算同一天）。
- v1 锚点可先做常量/env 注入；暴露到设置页（src/shared + settings feature）作为可选后续。

### 3.3 语义决策点（需要产品拍板，实施前必须回答）

锚点提前结算意味着**当日尾部（锚点→24:00）的完成度不进当日 summary 分析**。数据不丢：观测链（`consumeTimelineInput`，维护循环内）仍会在后续观测触发的自动调整中消费这些观测，今天冻结保护不变；差异只在"当日语义分析的分析时点"。若产品不能接受，替代方案是锚点后允许二次结算（把幂等键改为 `daily:{planId}:{localDate}:{phase}`）——复杂度上升，不默认推荐。

### 3.4 变更文件与测试

- 改：`src/bun/planning-runtime.ts:298`、`src/bun/index.ts`（配置注入）、`src/agent/planning/time.ts`（新增 `localTimeAt`）。
- 测试：新增 `tests/planning-settlement-anchor.test.ts`：锚点前不结算 / 锚点后当日结算恰一次 / 午夜翻转回退（未达锚点日） / 两个不同时区计划各自锚点 / 既有幂等不被破坏。时区用命名 IANA 区（CALENDAR_STANDARD 要求）。

---

## 4. W2：分析降级梯策略化（"特权仲裁"的对齐版）

### 4.1 设计纠偏

原方案要求失败后由"特权模型"仲裁三选一（换策略重试 / 挂起人工 / 终止）。**否决理由**：失败路径里再引入一次模型调用本身就是新增失败面；现有确定性降级梯（去工具裸跑）已覆盖"UPDATE_STRATEGY_AND_RETRY"的主场景（注释 :529-534 记录该梯是为 4.2MB 失控与上游劣化设计）；挂起人工已有现成通道（`analysisDiagnostic.retryable` + `trigger: "resume"`，用户在 UI 重试），终止 = `model-unavailable` 诊断。保留原方案的问题意识——**策略可配置、可观测、可测试**——落点改为策略对象提取。

### 4.2 设计

- Phase 1（本迭代）：新建 `src/agent/mastra-host/planning-analysis-policy.ts`，导出：

  ```ts
  export interface PlanningAnalysisAttemptPolicy {
    withTools: boolean;
    maxOutputTokens: number;      // 16_000 / 8_000
    timeoutCapMs: number;         // 240_000 / 150_000
  }
  export interface PlanningAnalysisPolicy {
    primary: PlanningAnalysisAttemptPolicy;
    degraded: PlanningAnalysisAttemptPolicy;
    maxSteps: number;             // 4
    structuredErrorStrategy: "warn";
  }
  export const DEFAULT_PLANNING_ANALYSIS_POLICY: PlanningAnalysisPolicy = /* 现行常量 */;
  ```

  [runtime.ts:529-599](../src/agent/mastra-host/runtime.ts) 改为读 policy。**行为零变化**，纯提取；mastra-host 保持无状态（policy 是常量注入，不是运行时可变状态）。
- Phase 2（可选，另开 PR）：Bun 通过 `planning.analyze` 协议参数下发 policy 覆盖（protocol.ts 当前在 WIP 中，注意合并顺序），实现"策略归 Bun 所有"。Phase 1 不动协议。
- **不新增**自动重试环：重试决策归 Bun（诊断 + resume），与铁律 1 一致。

### 4.3 变更文件与测试

- 改：runtime.ts :529-599 引用 policy；新增 planning-analysis-policy.ts。
- 测试：新增 `tests/planning-analysis-policy.test.ts`：用 fake relay 断言 16k/240s → 8k/150s 序列与现状等价；`timeoutCapMs` 与全局 `dynamicPlanningAnalysisTimeoutMs` 的 `min` 语义保持；超时后 `PLANNING_OUTPUT_INVALID` / `MODEL_RELAY_UNAVAILABLE` 错误分类不变。

---

## 5. W3：客观 relevance 评分（第三信号源）

### 5.1 设计纠偏

原方案的 M1–M4 评分对象是"子任务 DAG 节点"，但现系统没有子任务 DAG——评分对象应为 `PlanTask`。且评分**不得**绕过既有治理链：用户 `relevanceOverride` 优先级最高，模型自评是第二源，降级必须过确认门。本工作流只增加第三源（确定性规则），并分两阶段控制语义风险。

### 5.2 设计

- Phase 1（零语义风险，本迭代）：新建 `src/agent/planning/relevance-signal.ts`，纯函数：

  ```ts
  export interface RelevanceSignalContext {
    dependedOnCount: number;            // 被多少个 pending 任务依赖
    memoryHints: PlanMemoryHints | null; // weakSkipRate / estimateCalibrationRatio / calibrationSamples
    deadlineMsRemaining: number | null;
    sessionMinutes: number | null;
  }
  export function deriveRelevanceSignal(
    task: Pick<PlanTask, "estimatedMinutes" | "dependencyTaskIds" | "relevance">,
    context: RelevanceSignalContext,
  ): { suggested: "strong" | "weak"; reasons: string[] };
  ```

  规则全部确定性、表驱动，示例：被 ≥2 个 pending 任务依赖 → strong；`weakSkipRate > 0.5` 且校准样本充足 → 倾向 weak（附 reason）；`estimatedMinutes > sessionMinutes×2` → 只产 reason 提示拆分，不改 relevance。
- 消费方式：作为 `relevanceHint` 注入 `planningAnalysis` 的输入投影（`planning/model.ts` 的 AnalysisRequest 增可空字段 + [planning-analysis.ts](../src/agent/mastra-host/planning-analysis.ts) 输入 schema 同步增可空字段——两处 schema 必须同步改，且旧 Bun 侧不发送时模型输入不受影响，向后兼容）。提示词相应加一句"hint 仅供参考，最终仍需自评并给 relevanceReason"。
- Phase 2（需产品拍板，不默认启用）：把 signal 作为 `relevanceOf` 第三源参与调度排序。实施前必须回答：override / 模型 / signal 三者的优先级，以及降级确认门（`revisionDemotesStrongTasks`）是否把 signal 造成的降级同样视为需确认降级。

### 5.3 变更文件与测试

- 改：`src/agent/planning/model.ts`（输入类型）、`src/agent/planning/runtime.ts`（投影组装处）、`src/agent/mastra-host/planning-analysis.ts`（输入 schema）；新增 relevance-signal.ts。
- 测试：新增 `tests/relevance-signal.test.ts`（表驱动规则 + 边界：无 memoryHints / 无依赖 / deadline null）；`tests/mastra-planning-model.test.ts` 补投影断言（无 hint 字段时输入合法）。

---

## 6. W4：孤儿工具与死路审批垂直切片的处置

### 6.1 事实与范围

死路垂直切片共 7 个源文件 + 1 个测试文件（清单见 §2 末行）。不可达原因：`createWhaleHallAgentTools` 从未被调用 → 模型永远无法产生这些工具调用 → `executeTool` / approve / decline / `toolProposals` 全链休眠。

### 6.2 两个选项

- **选项 A（本迭代推荐）：冻结 + 摘除纯死代码**
  - 摘除：`agents.ts:76` 的 `executeTool` 选项及其 :372 调用点传参（mastra-host/runtime.ts:372）；`tools.ts` 整文件（确认无未来消费方后）。
  - 保留并标注：protocol.ts 的 `agent.approveTool` / `agent.declineTool` 消息与客户端审批 UI（AppShell / ConversationController）——对话 Agent 通过 conformance gate 后可能复用；在 protocol.ts 相关消息处加注释"当前无挂载审批工具，路径休眠"。
  - 测试影响：`tests/mastra-host.test.ts` 中 tool-approval 用例改写为"协议消息仍被正确拒绝/休眠"断言。
- **选项 B：全垂直摘除**（client + protocol + bun + agent + tests）——独立 PR，不与本轮任何工作流混合；仅在产品确认对话 Agent 短期内不需要本地审批工具时执行。

### 6.3 验证

选项 A 涉及 client（AppShell 仅注释/不动逻辑则不触发）；若动了 views 需 `bun run build:views` + 1440x900 / 1180x720 双视口检查。选项 A 不改日历，不触发 CALENDAR_STANDARD 的双轮视觉修正要求。

---

## 7. 实施顺序、验证门与回滚

**顺序**（按风险从低到高，每步独立可交付）：

1. W2 Phase 1（纯提取，零行为差异）→ 2. W1（小面行为变更，默认 null 不启用）→ 3. W3 Phase 1（只读信号，向后兼容）→ 4. W4 选项 A → 5.（可选）W1 锚点暴露设置页 / W2 Phase 2 / W3 Phase 2 / W4 选项 B。

**每个工作流的验证门**：`bun run typecheck` → 相关测试文件先行 → `bun run test` → `bun run check`。涉及 views 时加 `bun run build:views` + 双视口检查。

**回滚设计**：W1 锚点 `null` 即回现行；W2 是提取重构（revert 即回原样）；W3 hint 字段可空、消费端向后兼容；W4-A 摘除面小，单独 commit 便于 revert。

---

## 8. 明确不做（negative scope）

1. 不新建 `src/agent/ontology/` 层，不引入 `CalendarBlockObject` / `FIXED_HARD|ELASTIC_SOFT` 模型（与 `CalendarEvent` 契约冲突、绕过 Rust 持久化与版本化提交）。
2. 不把 DAG / 重试 / 仲裁编排塞进 mastra-host（铁律 1）。
3. 新排期代码不使用 `Date.parse` / `toISOString` 直排（铁律 3）。
4. 不做"特权意图分流"意图分类器：本地确定性事件已有 manual-block UI 路径（CalendarEvent kind），无证据表明需要模型分流。
5. 失败路径不新增模型仲裁调用（§4.1）。
6. 不在本轮做 planning 数据上云：`data-center-sync.ts` 现无 planning 域（:549 附近为 consent 域枚举 `activity/browser/presence`，原方案引用有误），上云属二期且需 consent 域扩展。

## 9. 二期候选（不在本方案内）

- planning 快照 / 调整记录按 consent 域模式上云（activity/browser/presence 先例，需 DC 侧配套）。
- 对话 Agent 通过工具 conformance gate 后的本地工具挂载（届时重新评估 W4 冻结面）。
- 关联文档：`docs/MODEL_CALL_BOUNDARY.md`、`docs/frontend/CALENDAR_STANDARD.md`、`AGENTS.md`。
