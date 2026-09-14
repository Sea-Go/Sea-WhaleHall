# WS04-D 云搜索 Tool 组件交接

状态：`LOCAL_VERIFIED`（仅当前隔离分支的组件；H02/H07 真实链路未验收）。

`CloudSearchToolSession` 为**一次已认证的父 Agent 运行**创建三个 Mastra 1.59.0 `createTool`：`search_fast`、`search_detailed`、`read_evidence`。Bun 从真实会话注入 `accountId`、`operationId`、固定 `scopeRef/snapshotRef`、预算引用、总期限及取消信号；这些字段均不在模型参数中。工具只接受查询、智能等级、已知的续搜 ID 或已返回的搜索/证据 ID。搜索返回结构化证据、缺口、停止原因和耐久引用收据，不生成最终答案。调用方 Agent 可根据 Tool 消息继续决定是否搜索、重读或回答。

`CloudSearchProductPort` 是 WS04-A 的待接入口。Bun 应使用 H02 已认证产品接口，并将 RTW/BTW 的响应投影为此文件中的 `CloudSearchResult` 与 `CloudReadEvidenceResult`；不能让 Sidecar 直连 BTW，也不能从模型 JSON 接收身份、快照、预算或后端 URL。产品投影须给出固定 `snapshot_ref`、同版 `revision_id/locator/quote_hash`、真实 `pack_hash` 与 RTW 耐久 `citation_receipt`；空证据没有引用收据。`pack_hash` 与收据内容的权威一致性应由 RTW/BTW 接纳侧验证，本组件校验返回绑定与重读一致性。`quote_hash` 按 UTF-8 SHA-256 复核。Port 必须真正应用传入的限制和取消信号；本组件先预留上界，失败/重试不退预算，成功只按经过校验的实际用量退还未使用部分。调用方仍应由服务端验证累计预算引用，不能仅依赖桌面进程内账本。

装配时只能把 `session.tools()` 交给**该父运行专属、已通过实际模型 Tool-call 兼容测试的 Agent**。当前正式 interactive conversation 的 `tools: {}`、`activeTools: []` 和 `toolChoice: "none"` 均未修改，生产模型尚未通过这一兼容测试，不能直接开启云搜索。`src/agent/mastra-host/agents.ts`、`runtime.ts`、Sidecar 私有协议和 Bun Typed RPC 的共享装配应由各自唯一 writer 在 H02 接口确定后串行接入。若要公开答案/反馈，还须补 RTW 真实引用读取及真正可见的产品曝光收据；本机 pet feedback `sent` 不等于该收据。

专属测试用锁定版 Mastra 的真实 Agent 和模拟兼容 OpenAI Tool-call 响应，证明 `search_fast` 后父 Agent 收到 Tool 结果并继续生成自己的答案；还覆盖累计预算、伪造收据/正文/修订、跨运行证据 ID、空结果及运行中取消。此 fixture 不证明当前生产模型兼容、不证明实际 Bun→RTW→BTW 联通、Collector 链路或真实页面曝光。验收命令和结果以集成验收记录中的对应提交 SHA 为准。
