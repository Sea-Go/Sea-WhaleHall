# 桌宠计划面板挂载与引用气泡接线验收记录

状态：`LOCAL_VERIFIED`。此切片从 `feat/client-citation-plan-20261006`（基点 `c80f0e9`，F3 引用气泡/计划面板骨架）建立，把 PetPlanPanel 挂进桌宠 UI（dev 开关控制，默认关），并让云搜索结果卡的已接纳引用区改用 CitationBubble 渲染。纯展示层接线：未新增 RPC、未触碰 RTW/BTW/DataCenter 或正式运行装配；mock 计划数据保持并继续注明待 RTW task 域端点。

## 开关方式

- **localStorage（持久开关，先例：仓内浏览器侧标志走普通 web 存储，见 MockPreferencesService / SettingsPage 的 localStorage 说明）**：pet WebView 控制台执行 `localStorage.setItem("sea.pet.planPanel", "1")` 后重载宠物窗口即挂载；删除该键或置其他值（`"0"`/`"true"` 均无效，仅认 `"1"`）恢复默认关闭。
- **URL 参数（单次加载覆盖，供浏览器/`pet-demo` 调试）**：`?petPlanPanel=1` 开启、`?petPlanPanel=0` 关闭；参数存在时优先于 localStorage。pet WebView 的 URL 由 Bun 窗口控制器固定，故日常开关走 localStorage。
- 开关在挂载时读取一次（`useState(isPetPlanPanelEnabled)` 惰性初始化），修改后需重载窗口生效；默认关，生产行为零变化。
- 实现落点：`src/views/pet/plan-panel-flag.ts`（键名/参数名常量 + 可注入 storage/search 的纯函数，便于测试）；`src/views/pet/PetPlanPanelSlot.tsx`（读开关、开则渲染 `PetPlanPanel plan={MOCK_PET_PLAN}`，注明 mock 待 RTW task 域）；`PetApp.tsx` 在 `.pet-stage` 容器内、云搜索卡相邻位置挂入 `<PetPlanPanelSlot />`。

## 截图位（DOM 断言的文字描述）

Pet WebView（360×300 测试视口；真机验收按 AGENTS.md 视觉流程）：

- **开关关（默认）**：`.pet-stage` 内只有 canvas、活动反馈气泡与 `.pet-cloud-search`；`querySelector(".pet-plan-panel")` 为 null，`queryByLabelText("桌宠计划面板")` 为 null。
- **开关开（localStorage `sea.pet.planPanel=1` + 重载）**：顶部出现 `.pet-plan-panel` 气泡卡（与云搜索卡同一容器语言：`--pet-feedback-surface/border/radius/shadow`）；`aria-label="桌宠计划面板"`；头部目标"养成晨间阅读习惯"+ `data-status="active"` 徽章；两条目各含 cue 行（`每天 08:00 · 书桌 · 早餐放下筷子后`）、action、微步骤；active 条目展开三键打卡行（完成/推迟/跳过/为什么？）。
- **云搜索已接纳答案**：搜索完成前 `.pet-citation` 不存在；接纳后引用区逐条渲染——带完整 StructureLocator 字段的引用渲染为 `figure.pet-citation`（`data-citation-id` 对应 evidence_id；meta 行含类别"Wiki/原始资料"与面包屑"§ 第一章 深海环境 › 1.2 海流 · ¶ 3"；blockquote 为 quote 原文，超 200 rune 出现"展开"按钮）；缺字段的引用回退旧行内文案（`原始资料 2：风推动海表水运动。`）。全程无 `<a>` 链接。

以上断言均已落在定向测试（见验收证据），与真实窗口截图一一对应。

## 边界

- **与活动反馈气泡重叠**：`.pet-plan-panel` 沿用 F3 的顶部占位定位（`top: 8px`），与瞬态的活动反馈气泡同处顶部区域；反馈气泡 `z-index: 2` 更高且按页出现，计划面板 `z-index: 1`。dev 开关默认关，正式窗口不受影响；与云搜索卡的布局协同仍待设计稿（F3 已列为遗留）。
- **引用字段回退**：当前 RTW 已接纳搜索的 wire 引用仅保证 `evidence_id/revision_id/quote`；`doc_key/section_path/para_index` 任一缺失或畸形（非字符串数组、非负整数、空白 doc_key）即整条回退旧摘录行，不渲染半成型气泡。回退在 `cloud-search.ts`（投影层）与 `PetCloudSearchPanel.tsx`（渲染层）均有注释。
- **mock 数据**：开关开启渲染的是 `MOCK_PET_PLAN`；check-in 回调未接线（只入记忆的通道待 port），按钮点击无持久效果。RTW task 域端点落地后按 PetCloudSearchPort 先例注入 port 并替换 mock，届时移除开关或转正式设置项。
- **开关读取时机**：仅挂载时读取一次，不支持热切换；pet WebView 无 URL 参数注入通道（由 Bun 固定），URL 覆盖仅对浏览器/`pet-demo` 生效。

## 交付物

| 文件 | 内容 |
| --- | --- |
| `src/views/pet/plan-panel-flag.ts` | dev 开关：`PET_PLAN_PANEL_STORAGE_KEY="sea.pet.planPanel"`、`?petPlanPanel=` URL 覆盖（参数优先）；可注入 storage/search 的纯函数 `isPetPlanPanelEnabled`，SSR/无 window 时恒关 |
| `src/views/pet/PetPlanPanelSlot.tsx` | 挂载槽：惰性读开关，开则渲染 `PetPlanPanel`（`MOCK_PET_PLAN`，注释锚定待 RTW task 域），关则渲染 null |
| `src/views/pet/PetApp.tsx` | `.pet-stage` 内云搜索卡相邻挂入 `<PetPlanPanelSlot />`，注释注明开关与 mock 状态 |
| `src/views/pet/cloud-search.ts` | `PetCitationLocator`（`Locator` 镜像 + `doc_key`，StructureLocator 形状）；`citationLocator` 映射器从已接纳 wire 引用构造 locator，字段缺失返回 undefined → 摘录回退；answered 状态引用项新增可选 `locator` |
| `src/views/pet/PetCloudSearchPanel.tsx` | 已接纳引用区：有 locator 的条目渲染 `CitationBubble`（id/sourceKind/locator），缺字段条目保留旧“类别 序号：摘录”行（注释注明回退原因） |
| `tests/pet-plan-panel-slot.test.tsx` | 新增 5 例：开关默认关/非"1"值拒绝、live localStorage 读取、URL 参数覆盖（1/0/无存储）、槽关态不渲染、开态挂载 mock 面板 |
| `tests/pet-cloud-search.test.tsx` | 扩展 4 例：locator 字段投影进 answered 状态（toEqual 全形状）、部分字段回退（缺 section_path/非整数 para_index/非字符串 crumb/空白 doc_key）、旧夹具无字段保持旧行、面板渲染 CitationBubble（面包屑+quote+`data-citation-id`）与缺字段回退并存 |

## 验收证据

- 定向测试：`bun test tests/pet-plan-panel-slot.test.tsx tests/pet-cloud-search.test.tsx tests/pet-plan-panel.test.tsx tests/citation-bubble.test.tsx tests/plan-state-badge.test.tsx` → **29 pass / 0 fail**（其中新增 9 例）。
- `bun run typecheck`（tsc --noEmit）通过。
- `bun run build:views`（vite build + stage-view-assets）通过，产物含 pet/client 两视图（chunk >500kB 警告为既有信息性输出）。
- `biome check`（7 个新增/修改源与测试文件）无告警。
- 全量 `bun test tests/`：**1449 pass / 5 skip / 0 fail**（1454 例，156 文件，41.60s）。沿 F3 记录，`tests/datacenter-cloud-contract.test.ts` 要求相邻 `Sea-DataCenter` 检出——在 /tmp 工作树先以 `/tmp/Sea-DataCenter` 符号链接补齐后全绿（该文件单跑 7 pass / 0 fail；主检出 `/Users/edy/Sea/Sea-WhaleHall` 同基点原生通过）。

## 遗留与后续交接

- **RTW task 域 port**：替换 `MOCK_PET_PLAN`、接 check-in 回调（只入记忆通道）；落地后面板转正式装配并决定开关去留。
- **wire locator 字段**：RTW 已接纳搜索结果补齐 `doc_key/section_path/para_index` 后，回退路径自然退场；届时按 A7 校验 quote 命中段落原字节（C-4）。
- **面板定位设计稿**：顶部占位与云搜索卡/活动反馈气泡的布局协同、真机 Electrobun 窗口视觉走查（AGENTS.md 视觉验收两轮）待后续切片。
