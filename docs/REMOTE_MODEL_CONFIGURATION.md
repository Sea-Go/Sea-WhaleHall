# WhaleHall 内测模型网关配置

首个开发内测版把所有可配置远端模型调用收敛到一个 DataCenter 网关。聊天、规划、
后台 activity Agent 和 sealed-window reflection 都请求代码所有的：

```text
POST https://data.sea-ridethewindbreakthewaves.xyz/v1/chat/completions
```

每个请求要求当前原生会话的 bearer、由 run ID 与 exact body 派生的
`Idempotency-Key`，以及 Bun 主进程添加的
`X-WhaleHall-Model-Purpose: agent|activity|planning|reflection`。DataCenter 只从认证 session 确定 user；
Renderer、Sidecar 和 JSON body 都不能提供或覆盖 user/purpose/token。

## 配置

```yaml
reflection:
  name: "reflection"

planning:
  name: "planning"

agent:
  name: "agent"

cloudSync:
  enabled: false
  contentEncryptionEnabled: false
  consents:
    activity: "off"
    browser: "off"
    presence: "off"
```

三个名称是固定的逻辑角色，而不是真实的 Provider 模型 ID：`agent` 供对话和后台
activity Agent 使用，`planning` 供任务规划和 Dynamic Planning 分析使用，`reflection`
供 sealed-window activity reflection 使用。真实的上游模型、URL 和 API key 只由
DataCenter 的私有 `config.yaml` 映射；桌面端不得保存、发送或推测它们。DataCenter
production origin 是代码所有常量，不能由安装包、环境变量或用户配置覆盖。旧的双角色
`qwen3:1.7b` 文件可在内存中迁移到三个逻辑角色，但新三角色配置不接受真实 Provider
模型名。旧文件中的 `reflection.baseurl`、
`reflection.apikey`、`agent.baseurl` 和 `agent.apikey` 仍可兼容解析，但其值在配置边界即被
丢弃：不会发送、记录、返回给运行时，也不会触发自动重写。

每个安装都会按代码固定的 cutover ID 执行一次 production-origin 迁移，不依赖旧配置是否仍能
证明来源。SQLite v8 先在同一事务中写入 `prepared` journal，并清除旧来源的设备凭据、待发送
批次、consumer owner 与同步审计；随后删除旧版使用的 refresh-token 凭据名，最后才把 journal
标记为 `complete`。任一步失败或崩溃都会在下一次认证和网络启动前重复安全清理。新版登录只读写
旧版不知道的 production-only 凭据名，DataCenter 同步也只读写新的 production SQLite 表和
本地 consumer cursor；新 credential helper 对旧凭据名仅允许删除，读取和写入都会拒绝。因此
并行或降级运行的 staging 客户端不能把旧 token、pending、设备身份或 cursor 回灌给 production
runtime。

旧 `agent.baseurl` 属于非 production、旧 schema 或配置无效时，cloud sync 与全部 consent 仍会在
每次加载时保持关闭，直到用户明确提供当前 production 配置与授权。旧配置文件、本地会话、其他
账户数据和本地事件 journal 都不会被自动改写或删除。

首次启动把 checked-in 模板复制到 user-data `config.yaml`，权限为 `0600`；无效或旧文件
不会被应用自动重写。用户只需用 DataCenter 账号登录即可获得模型 relay 能力。账号切换会
终止旧账号流并使用新 session；无有效 session 时安全失败，不会退回独立 model origin。

## 内测审计与数据边界

此版本明确是 internal-only。为满足开发调试，DataCenter 按认证 user 保存每次模型请求的
exact request 和 exact response，并提供受控的开发者查询/筛选。首版允许这些模型内容在
云端明文持久化，不启用客户端内容加密。它不改变普通 desktop-event cloud sync 的默认
关闭状态，也不把 token 或上游凭据写入审计内容。

客户端仍负责完整 prompt、Memory、Tool 政策与审批基础设施、规划 Workflow、
时间/action/分数校验与本地恢复；DataCenter 只认证、分类、审计和转发
OpenAI-compatible 字节。当前 production conversation 为纯文本模式，不注册产品 Tool；
Planning 与 Calendar 专页继续使用各自的权威本地路径。流式响应保持顺序和取消；非流式与
流式请求都保留既有 idempotency 语义。

## Activity 账号隔离

- sealed window 只在当前账号登录且其 account-scoped delivery lifecycle 运行时进入 outbox；
- outbox 行耐久记录创建时 session identity，ledger 本身固定绑定 account；
- receipt、score 和后台 Agent job 与同一 account ledger 一起隔离；
- A 登出会先中止 live relay 并关闭 A lifecycle，A pending 保留；B 使用不同 ledger，不能
  查询、发送或 claim A 的 window/receipt/job；
- A 重登可以用新 session 恢复 A 的 exact pending wire；
- 未登录期间封闭的窗口不上传，也不会被后续账号从全局 Reflection repository 回扫认领。

## 失败策略

无 session、DataCenter 不可用、响应丢失或账号切换都 fail closed。
客户端不回退独立 model origin，不把 user ID 写入 body，也不把凭据下发给 Sidecar/Renderer。
响应丢失保留账号专属 outbox 并用相同 request/idempotency key 重试；取消保留既有 durable
恢复状态。
