# 客户端引用气泡与计划面板验收记录

状态：`LOCAL_VERIFIED`。此切片从 `feat/client-citation-plan-20261006` 工作树（基点 `304df21`，main）建立，交付桌宠引用气泡、计划状态徽章、check-in 三键行与计划组合面板的纯展示骨架。全部组件 props 驱动、无后端接线；未触碰 RTW/BTW/DataCenter 或正式运行装配。依据：Sea-Docs《客户端计划制定与执行引导方案》§1/§3（状态机与三态交互）、《LLM-Wiki平台落地工程方案》§1（Locator/EvidencePack 契约快照）。

## 交付物

| 文件 | 内容 |
| --- | --- |
| `src/shared/locator-types.ts` | Locator/EvidencePack/LaneScores 镜像类型，字段级对齐契约快照（保留 proto snake_case，JSDoc 标注 proto 字段号），文件头注明镜像来源；`LOCATOR_QUOTE_MAX_RUNES=200` 固化 quote 上限 |
| `src/views/pet/CitationBubble.tsx` | 引用气泡：`section_path` 面包屑（`§ … › …`）+ 段落锚（`¶ n`）+ quote 高亮（超 200 rune 截断加省略号，展开/收起）；导出 `citationBreadcrumb`/`truncateQuoteForDisplay` 纯函数 |
| `src/views/pet/plan-lifecycle.ts` | 六态 `PlanLifecycleStatus`（draft/confirmed/active/review/adjusting/archived）、`PLAN_LIFECYCLE_META` 语义常量（label/description/`--pet-plan-status-*` 色变量）、cue/check-in 视图类型；注释逐条对应状态机文档 |
| `src/views/pet/PlanStateBadge.tsx` | 六态徽章：语义色 CSS 变量 + `data-status` 标记，title 承载状态机含义 |
| `src/views/pet/PlanCheckinRow.tsx` | check-in 三键（完成/推迟/跳过）+ 可折叠"为什么"输入，明示"只入记忆、不写计划"；任一键按下即随笔记一起提交 |
| `src/views/pet/PetPlanPanel.tsx` | 组合面板骨架：目标 + 状态徽章 + 条目列表（cue 时间/地点/触发 + action + 两分钟微步骤）+ active 条目的 check-in 行；`MOCK_PET_PLAN` 注明"待 RTW task 域端点"，生产传 `null` 显示空态 |
| `src/views/pet/styles.css` | 新增 `--pet-plan-status-*` 六色语义变量与各组件样式，全部复用既有 `--pet-feedback-*` 气泡语言（surface/圆角/muted/accent），无新依赖 |

## 契约与红线对齐

- Locator 镜像保留 proto 字段名与顺序（`revision_id/section_path/para_index/quote`），quote ≤200 字契约进入组件行为：超限展示截断并允许展开，不静默吞原文。
- `LaneScores` 在快照中仅被不透明引用，按工程方案 §4 三路检索（dense/sparse/multi）落字段并注明推断来源，平台显式定义后需回改。
- 计划红线（方案 §1，C14/D11）：组件层不实现任何状态迁移；`draft → confirmed` 的提交权在人。check-in 备注只入记忆，UI 文案与回调签名（`onCheckin`）均不提供写计划通道。
- 徽章六态色为语义命名常量（`--pet-plan-status-draft` 等），注释锚定 `plan-lifecycle.ts` 与状态机文档，两处列表要求同步维护。
- 面板沿用 PetCloudSearchPanel 的交互隔离（stopPropagation）与"无链接纯文本引用"先例。

## 验收证据

- 定向测试：`bun test tests/citation-bubble.test.tsx tests/plan-state-badge.test.tsx tests/pet-plan-panel.test.tsx` → 12 pass / 0 fail。覆盖：面包屑拼接（含空 section_path 回退 ¶ 锚）、quote 200-rune 截断/展开/收起（含星面 emoji 不被切半的 rune 安全性）、六态徽章渲染（label + `data-status` + 语义类名 + title）、面板空态、cue/action/微步骤渲染、条目级状态覆盖（active 继承 + confirmed 覆盖）、三键仅出现在 active 条目、check-in 回调携带 outcome+note 且提交后收起、点击不穿透到宠物卡片。
- `bun run typecheck`（tsc --noEmit）通过。
- `bun run build:views`（vite build + stage-view-assets）通过；产物含 pet/client 两视图。
- `biome check`（9 个新增/修改源文件）无告警。
- 全量 `bun test`：1445 例中 1438 pass / 5 skip / 2 fail / 1 error。两项失败均为环境性、与本切片无关：`tests/datacenter-cloud-contract.test.ts` 要求相邻 `Sea-DataCenter` 检出（/tmp 工作树无；在 /tmp 建相邻符号链接后该文件 7 pass / 0 fail，主检出原生通过）；`native/observer/Tests/observer-helper.test.ts` 的 `xcrun swiftc` 原生编译在 60s beforeEach 钩子超时，同一基点 pristine 主检出复现相同失败。未跑 `bun run check` 中的 Rust 段（与本切片无交集且耗时长）。

## 遗留与后续交接

- **RTW task 域端点**：Plan/CheckinEvent 权威数据与状态迁移在 RTW `service/task`（方案 §4）；Bun 侧需按 PetCloudSearchPort 先例建 port 注入，替换 `MOCK_PET_PLAN`，正式装配前面板不挂入 PetApp。
- **EvidencePack 通道**：CitationBubble 已可直接消费 Locator；EvidencePack/Candidate/LaneScores 镜像类型待 B5 证据包经 C-6 客户端 HTTP 到达后接入渲染，届时按 A7 校验 quote 命中段落原字节（C-4）。
- **LaneScores**：契约快照显式定义后按新快照回改镜像。
- **提醒三态与 streak**（方案 §3-2/3-4）：主动提议接受/拒绝/忽略与 never-miss-twice 宽限不在本切片，属 PC3 里程碑。
- 面板定位（顶部）为占位；与云搜索面板的布局协同待设计稿。
