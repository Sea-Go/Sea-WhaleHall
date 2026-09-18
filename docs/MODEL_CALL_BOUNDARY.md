# 客户端模型调用边界

## 规则

WhaleHall 桌面端的所有模型调用必须经过 `src/agent/mastra-host` 的 Mastra Agent
或 Workflow。Renderer 不得导入 Mastra、AI SDK 或直接发起模型请求；Bun 不得创建
通用 HTTP/LLM 客户端，也不得连接用户电脑上的模型服务。

当前只有四个代码所有的 relay 用途：

| 用途 | Mastra 入口 | 职责与远端边界 |
| --- | --- | --- |
| `agent` | text-only conversation、后台 activity Agent | 请求逻辑模型 `agent`；Sidecar 构造 OpenAI-compatible 请求，Bun 使用当前账号的短期 bearer 经固定 DataCenter 网关发送。当前 conversation 不注册产品 Tool。 |
| `activity` | 后台 activity Agent 的审计分类 | 与 `agent` 模型角色配套，用于区分后台调用；不会改变其逻辑模型。 |
| `planning` | task-planning Agent/Workflow、`planning.analyze` → live-only planning-analysis Agent | 请求逻辑模型 `planning`。只返回 Dynamic Planning 的严格语义结果；持久化、幂等、七日排程、ETA、proposal/confirm、重试和取消仍由 Bun `PlanningRuntime` 所有。 |
| `reflection` | `reflection.analyze` → no-persistence activity-reflection Workflow | 请求逻辑模型 `reflection`。Bun 生成完整的 sealed-window prompt；Sidecar 只做一次严格结构化调用。 |

四个用途都请求固定 `POST /v1/chat/completions`。Bun 的
`RemoteAuthSessionManager` 注入认证信息，并由代码设置
`X-WhaleHall-Model-Purpose` 和 `X-WhaleHall-Model-Agent`。purpose 是审计与授权边界；
Agent ID 标识具体调用者，由 DataCenter 映射到 `high`、`medium`、`low` 推理层级和当前
生效模型。Sidecar Agent Host 从固定代码映射为当前模型调用绑定 Agent ID，并通过 private
stdio v3 的必填 `model/relay.open.agentId` 携带；Bun 校验 Agent catalog、purpose 与 owning
run 后才生成两个远端 HTTP 头。activity run 还强制
`supervisor → 任一固定 specialist → voice → done` 的瞬态顺序，只有 relay open 成功后才推进；
具体 specialist 由 Sidecar 对 guarded route 的固定映射选择，首次接受后的失败重试必须保持同一 Agent。请求 body、Renderer 与调用方
HTTP headers 不能提供或覆盖用途、Agent、token、key 或用户身份。DataCenter 校验 bearer、Agent 是否属于固定 catalog
以及 Agent 与 purpose 是否匹配，但不会把该头视为设备证明或官方客户端证明。v2 peer 会
fail closed。Dynamic Planning 使用稳定的
`planning-analysis:${operationId}` 作为 originating request identity，使现有 relay
幂等键在恢复和重试时保持不变。Agent ID 不改变升级前的 key 派生；DataCenter 在同一
key 的 durable authority 上绑定非空 Agent，跨 Agent 复用会 fail closed，旧的空 Agent
记录则可按升级兼容规则继续恢复或 replay。

固定 Agent catalog：

| Agent ID | 用途 | 默认推理层级 |
| --- | --- | --- |
| `whalehall-conversation` | `agent` | `medium` |
| `whalehall-planning` | `planning` | `high` |
| `whalehall-planning-analysis` | `planning` | `high` |
| `whalehall-activity-reflection` | `reflection` | `high` |
| `whalehall-activity-support-supervisor` | `activity` | `medium` |
| `whalehall-activity-momentum-coach` | `activity` | `low` |
| `whalehall-activity-blocker-coach` | `activity` | `low` |
| `whalehall-activity-focus-coach` | `activity` | `low` |
| `whalehall-activity-recovery-companion` | `activity` | `low` |
| `whalehall-activity-check-in-companion` | `activity` | `low` |
| `whalehall-activity-support-voice` | `activity` | `low` |

`activity-reflection` 与 `planning-analysis` 都是 live-only 入口，不注册到 durable
Mastra Agent 集合。它们不创建产品 Tool、Memory 或 snapshot。前者的完整窗口 prompt，
后者的计划语义快照，以及二者的模型输出，只存在于一次 Bun/Sidecar 调用内。

生产 conversation 固定为纯文本调用，显式禁用 active Tools 与多步 Tool loop。模型若
返回标准 Tool 事件或文本形式的 `<tool...>` 标记，Sidecar 必须在展示和持久化前终止本轮，
不得解析、隐藏后继续或执行。只有固定 provider/version/model 通过流式与多轮 Tool
conformance gate 后，才可在单独改动中重新启用本地 Tool allowlist。

## 零本机模型约束

- 生产桌面源码不得 import、构造或探测 Ollama client/model lock，也不得依赖
  `11434`、`8765` 或任何 loopback 模型监听器。
- Timeline v2 固定使用 `HeuristicTimelineEpisodeClassifier` 与
  `DeterministicTimelineHypothesisGenerator`；刷新状态不会执行模型或网络探测。
- Reflection journal 固定使用保守的 `DeterministicReflectionInference`。它生成稳定的
  content-free embedding、明确 abstain，并保持 feedback 静默；没有本地 Qwen fallback
  或 ModernBERT HTTP 路径。
- 旧持久化记录中的历史 `modelVersion`/diagnostic 字符串可以继续解析，但不能重新接入
  生产 import graph。

## 代码审查约束

- 新的聊天、Agent 或生成模型调用必须先增加或复用 Mastra Agent/Workflow，再通过
  私有 Content-Length stdio 与既有 reverse relay；不得自造通用模型客户端。
- 不得恢复 `/v1/activity/analyze` 或 `/v1/activity/completions` 客户端路径。
- 完整 `raw_event` 与目标快照仅可进入一次性的本地 Sidecar prompt；不得进入 Renderer、
  配置、日志、durable snapshot、普通 Agent run 或 Tool。Bearer 与上游凭据始终留在 Bun/DataCenter。
- DataCenter 不添加 system prompt、不聚合事件、不格式化 action、不计算分数；这些合同由
  客户端代码拥有。内测环境的 exact request/response 审计必须按已认证账号隔离。
- Sidecar Agent Host 只通过私有 v3 协议携带代码绑定的 Agent ID；
  `X-WhaleHall-Model-Purpose` 与 `X-WhaleHall-Model-Agent` 只能由 Bun transport 在完成
  catalog、purpose 与 owning-run 校验后设置。Renderer、请求 body 与调用方 HTTP headers
  都不能设置或覆盖；请求 body 中的 `userId`、Agent identity、token 或 key 一律拒绝。
- raw activity outbox、receipt、score 和后台 Agent job 使用账号专属 ledger。未登录
  窗口不进入云 outbox；不同账号不能接管 pending 数据。
- 每个模型入口必须覆盖输入边界、严格输出合同、取消/超时、错误恢复、幂等与用途审计。
- `tests/model-call-boundary.test.ts` 是发布 gate：它扫描桌面生产源码，禁止本机模型
  symbol、模块名和 loopback 端口重新出现，并验证 `planning` 是独立 relay purpose。
