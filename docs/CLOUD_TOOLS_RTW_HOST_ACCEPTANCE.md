# WS04-D RTW 云搜索 Tools 宿主候选交接

状态：`LOCAL_VERIFIED`。此切片从 WhaleHall 集成提交 `63155a2` 建立独立开发工作树，新增 Bun 产品客户端、受限渲染投影和局部测试。RTW 产品接口只读核对其当前 Tool 父操作、子搜索、证据重读类型及 UserAuth 路由；没有更改 RTW、BTW、DataCenter 或正式 WhaleHall 运行装配。

## 已实现的调用边界

```text
未来 Bun ProductSessionProvider (当前正式值 null)
  → RTWCloudToolsClient.startParent
  → RTW UserAuth POST /v1/knowledge/answer-sessions/{session}/tool-runs
  ← RTW 签发 operation_id / scope_ref / snapshot_ref / budget_ref / 10 分钟期限
  → 父运行专属 CloudSearchToolSession（Mastra；当前未装入正式 conversation）
  → Bun RTWCloudToolsRun.port.search
  → RTW UserAuth POST .../tool-runs/{operation}/searches
  → RTW 服务端按固定主体／快照／累计 PG 预算签发 BTW fast/low Tools Scope
  → BTW /v1/search/tools/search
  ← SearchResult + RTW 耐久引用收据
  → Bun RTWCloudToolsRun.port.readEvidence
  → RTW UserAuth POST .../tool-runs/{operation}/evidence-reads
  ← 同版原文重读 + 当前引用可用性；模型父 Agent 自行继续决策
```

`startParent` 只接受 Bun 当前父运行给出的 run/account 标识、RTW 逻辑知识会话、module、幂等键和取消信号；RTW 本人产品 JWT 只从显式 `RTWProductSessionProvider` 读取，同时要求 Bun 本机账号会话提供者确认父运行的 account ID。每次请求使用启动时冻结的 RTW JWT、产品会话 ID／generation 与 Bun 登录的 account ID／session ID／generation，发请求前、收到 HTTP 后及解析完正文后均复核两套代次。Bun 账号切换所有者应调用 `run.cancel()`，旧请求得到 `CANCELLED` 或 `SESSION_CHANGED`，不得投给新账号；即使 RTW JWT 暂时不变，本机换号也会使旧结果失效。DC UUID 与 RTW UID 的权威同人绑定属 H01 待决；本切片不推算 UID、不签发 SubjectRef，也不把 DC bearer 当 RTW JWT。

父操作的 scope、snapshot、预算及期限只接受 RTW 回执。客户端核对当前接口的 4 次子搜索、24 次读、32768 quote runes、单搜索最多 8 次读／8192 runes 的上界；同键重取已耗尽父预算不会恢复本机新预算。子搜索仅发送 `query/depth/intelligence/read_calls/quote_runes/idempotency_key`，引用重读仅发送已知 `search_id/evidence_id/idempotency_key`。BTW 签名头、主体旧兼容槽与快照原文由 RTW 自己生成；Bun 不直连 BTW。

RTW 的耐久引用固定为 `search-citations/sha256/<SHA256(search_id)>`。Bun 只接受此前缀、64 位小写 hex 与实际 `search_id` 摘要一致的回执，搜索与重读均使用同一来源原字节和引用身份；任意放宽的路径或只长得像 SHA 路径的错误摘要均拒绝。

真实 Mastra Agent 的 `context.agent.toolCallId` 与父 run／operation／工具名生成固定子幂等键；缺实际框架 Tool-call ID 会拒绝执行。`CloudSearchToolSession` 在父运行内为同一键原子保存首次 query、depth、intelligence、已知续搜 ID、read／quote 限额或证据 ID，并只预留一次本机预算。丢 HTTP 回执、202 或可重试失败后，同一键仍按**首次原正文与原限额**请求 RTW；成功时只退还一次未使用读数／码点，不给新预算。已成功的同键请求也重新走 RTW 产品路由，回执必须与首次已核结果一致；证据重读再由 RTW 当前可用性门禁判定，来源撤回时不从本机缓存吐出旧 `available`。同键异文在本机拒绝并由 RTW 409 合同兜底；不同 Tool-call ID 按剩余预算新建调用。直接调用组件 `session.search()` 且不传 Tool-call ID 每次得到新键，只是一笔不可恢复的临时调用。

当前 RTW 子搜索拒绝 `continue_search_id`，故 Port 明确返回 `UNSUPPORTED`；202 和 503 仅交回固定子搜索 ID 的 `IN_FLIGHT`／`RETRYABLE_FAILURE`，本候选不把它们投影为已核证据，也尚未接 RTW GET 恢复回路。

RTW HTTP JSON 先按 1 MiB 有界字节读完，再复用现有 `parseRTWHistoryJSON` 对所有对象层拒绝重复键（包括 Unicode 转义别名），最后才投影 Zod DTO；普通 `JSON.parse` 后覆盖前值不能用作引用状态或 quote hash 的验收。旧云历史的原字节合同与解析器未更改。

Mastra Tool 得到结构化证据和供自身继续判断的已核 quote；搜索 Tool 不给出云端 summary 答案。`cloudToolSearchView` 只把搜索状态、停止原因、快照引用和证据 ID／来源／修订投影为 `unverified`；RTW 同版重读成功后可投影当前检查时点的 `available`，后续不可用结果清为 `unavailable`。该 DTO 不含 JWT、SubjectRef、旧 `turn_json`、完整 Quote 或搜索 Tool 的模型消息。它只是未来共享 Typed RPC 的候选类型，正式 Renderer 目前没有云搜索 Tool RPC 或卡片，不能把检查时点的状态当成持续有效。

## 验收与后续交接

修复前先把测试回执换成 RTW 权威 `durable_ref` 原形，旧 `1ac8be0` 代码定向 Bun 验收出现 3 次 `BAD_RESPONSE`（红日志 SHA-256 `3c43ee5adc338d0207a6f11df6703fc27b935832adf539fcdbd1df9b54314512`）。再放入“只余一次搜索预算，RTW 已存子操作而 HTTP 回执丢失”的真实 Bun loopback，旧逻辑在同 Tool-call ID 重放时报 `BUDGET_EXHAUSTED`（红日志 SHA-256 `69861d48912664b377e0aa54d173295324d669497758414b6ec24f9ed2760b20`）。两项都是原候选的真实接入阻断，前一版 `23 pass` 仅因错误的假引用和宽裕预算才成立。

修复后局部 Bun 测试使用 RTW 路由形状的隔离 HTTP 服务、真 Bun loopback 与锁定 Mastra 1.59.0 的**真实 Agent.generate Tool-call 事件**：核路径/bearer/正文白名单、已核 quote/耐久引用的父→搜→读、固定框架 ID、同键丢回执原正文重放、唯一搜索与读预算、异文冲突、不同键预算、来源撤回后重读不可用、严格重复 JSON、双账号代次与取消。`bun test tests/rtw-cloud-tools-client.test.ts tests/mastra-cloud-search-tools.test.ts tests/model-call-boundary.test.ts` 为 **26 pass / 0 fail**，日志 SHA-256 `1efeeea114f1a87682d74561befe27faf01d9b87ca69deab46941908311d135d`；`bun run typecheck` 退出 0，日志 SHA-256 `8366207267355d3e3d5bf3bf6e8c94c5f93f6078c34f08973fa2b38cdda6cc92`；本切片 5 份改动代码 `bunx biome check` 退出 0，日志 SHA-256 `bccc3edd2d5488a93c28e898532efd5a03ebebd86dd0fda566963c0c4b9a344f`。

这些仍是 WhaleHall 组件与 HTTP fixture；真实 RTW×BTW×Mastra 跨进程 Tools、DataCenter 本地模型、Collector 追踪、Electrobun 桌宠窗口均未在本切片验收。此前任何 Bun／Rust 全量 PASS 不能移作本修复的验收。

正式流量接纳还需三方交接：H01 确定同人账号与 Bun `RTWProductSessionProvider`，H02 在唯一 writer 管理的 Bun↔Sidecar Host-call／Typed RPC 中只传父 scope 与结构化 Tool 结果并实现旧请求取消，H07 用实际 RTW UserCenter/PG→BTW fast/low →RTW 证据重读→Mastra 父模型继续的同次运行验收。当前 `src/bun/index.ts` 的云历史 RPC 仍 `disabled`，conversation Agent 的 `tools` 仍为空；本切片没有注册正式 Port，也没有切换产品默认行为。
