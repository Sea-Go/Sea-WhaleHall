# 客户端模型调用边界

## 规则

WhaleHall 的新增或修改的**可配置桌面模型调用**必须经
`src/agent/mastra-host` 的 Mastra Agent 或 Workflow。Renderer 不得导入 Mastra、AI
SDK 或直接发起模型请求；Bun 也不得绕过 Sidecar 为 `config.yaml` 的角色新建 HTTP/LLM
客户端。

该规则适用于两个唯一可编辑角色：

| 角色 | Mastra 入口 | 远端数据边界 |
| --- | --- | --- |
| `reflection` | `reflection.analyze` → `activity-reflection` Workflow → 仅含 Mastra 原生本地 Skill 元工具的 Agent | Bun 在客户端生成完整中文 prompt；Sidecar 仅在本地内存中把它变成 OpenAI-compatible body。Bun 使用当前账号的 bearer 请求 DataCenter 固定 `/v1/chat/completions`，并以代码常量添加 `X-WhaleHall-Model-Purpose: activity`；DataCenter 从 session 归属 user 并在内测环境保存请求/响应供开发者查看。 |
| `agent` | conversation、planning、activity Mastra Agents | Sidecar 构造 OpenAI-compatible 请求，Bun 通过同一认证网关发送；普通对话/计划标记 `agent`，后台 activity Agent 标记 `activity`。Renderer 和 Sidecar 永远拿不到 bearer 或上游凭据。 |

`activity-reflection` 不注册产品 Tool 或 Memory；它只允许 Mastra 对两个本地 Skill 提供的
只读 `skill`、`skill_read`、`skill_search` 元工具。外层 Workflow 禁止 snapshot 持久化，内部
reflection Agent 也不注册到 durable Mastra 实例。原始窗口 prompt 与模型输出只存在于
本地 Bun/Sidecar 的一次调用内；持久化的只有 Bun 验证后的 receipt、事件和分数账本。

## 代码审查约束

- 新的 `config.yaml` 角色、聊天、Agent 或远端生成模型调用，必须先增加/复用 Mastra
  Agent 或 Workflow，再通过已有私有 stdio 协议实现受限 host adapter。
- 不得新增直接调用旧 `/v1/activity/analyze` Worker 的客户端。`reflection` 只能经
  `MastraActivityReflectionAnalyzer`、Mastra Workflow、`ModelRelayTransport` 和固定
  DataCenter `/v1/chat/completions` 路径到达模型。
- 完整 `raw_event` 与目标快照可以作为本地 Sidecar 的 `userPrompt`，因为模型必须看到它们；
  但它们不得进入 Renderer、配置、日志、durable snapshot、普通 Agent run 或 Tool。relay
  bearer 和上游凭据始终留在 Bun/relay，不能进入 Sidecar。
- DataCenter 不添加 system prompt、不聚合事件、不格式化 action、不计算分数；这些职责只能
  在客户端代码中实现。内测版会按认证 user 保存 exact request/response，属于明确的
  internal-only 明文审计能力，不是产品云同步或长期隐私策略。
- `X-WhaleHall-Model-Purpose` 只能由 Bun 的 code-owned transport/bridge 设置；Sidecar、body、
  Renderer 都不能提供或覆盖。请求 body 中的 `userId`、token 或 key 一律拒绝。
- raw activity outbox、receipt、score 和后台 Agent job 使用账号专属 ledger。未登录窗口不进入
  云 outbox；A 的 pending 只能由 A 重登恢复，B 不能接管，且不会从无 owner 的全局窗口回扫。
- 新模型调用必须有覆盖其输入脱敏、取消/超时、错误恢复和输出合同的测试；不能以“测试
  用直接 fetch”作为生产路径的例外。

## 现有受审计例外

以下是经明确审计的本地模型锁或工件校验链，不读取 `config.yaml` 的 `reflection` /
`agent` 配置，也不构成可配置模型入口：

- ModernBERT 的校准分类器；
- Reflection 的 lock-pinned Qwen 分类裁决 fallback；
- Timeline v2 的 lock-pinned Qwen 带引用 hypothesis helper；
- Dynamic PlanningRuntime 的 lock-pinned Qwen 结构化分析器。它只能使用
  `WHALEHALL_TEACHER_MODEL_LOCK`，必须在构造客户端前通过
  `verifyOllamaModelLock`，并且只暴露窄化的 `PlanningModelPort` 合同。

这些位置以 `@whalehall-model-boundary-exception` 标注，并受源代码测试列出。它们不能
接受新的可配置地址、不能被新功能复用为通用模型 transport；若要迁移，必须单独保留其
模型锁/工件验证与隐私合同，再移入 Mastra 边界。
