# WhaleHall 内测模型网关配置

首个开发内测版把所有可配置远端模型调用收敛到一个 DataCenter 网关。聊天、规划、
后台 activity Agent 和 sealed-window reflection 都请求代码所有的：

```text
POST https://data.sea-ridethewindbreakthewaves.xyz/v1/chat/completions
```

每个请求要求当前原生会话的 bearer、由 run ID 与 exact body 派生的
`Idempotency-Key`，以及 Bun 主进程添加的
`X-WhaleHall-Model-Purpose: agent|activity`。DataCenter 只从认证 session 确定 user；
Renderer、Sidecar 和 JSON body 都不能提供或覆盖 user/purpose/token。

## 配置

```yaml
reflection:
  name: "qwen3:1.7b"

agent:
  name: "qwen3:1.7b"

cloudSync:
  enabled: false
  contentEncryptionEnabled: false
  consents:
    activity: "off"
    browser: "off"
    presence: "off"
```

新配置的两个角色只允许选择固定模型名。DataCenter production origin 是代码所有常量，
不能由安装包、环境变量或用户配置覆盖。旧文件中的 `reflection.baseurl`、
`reflection.apikey`、`agent.baseurl` 和 `agent.apikey` 仍可兼容解析，但其值在配置边界即被
丢弃：不会发送、记录、返回给运行时，也不会触发自动重写。

首次启动把 checked-in 模板复制到 user-data `config.yaml`，权限为 `0600`；无效或旧文件
不会被应用自动重写。用户只需用 DataCenter 账号登录即可获得模型 relay 能力。账号切换会
终止旧账号流并使用新 session；无有效 session 时安全失败，不会退回独立 model origin。

## 内测审计与数据边界

此版本明确是 internal-only。为满足开发调试，DataCenter 按认证 user 保存每次模型请求的
exact request 和 exact response，并提供受控的开发者查询/筛选。首版允许这些模型内容在
云端明文持久化，不启用客户端内容加密。它不改变普通 desktop-event cloud sync 的默认
关闭状态，也不把 token 或上游凭据写入审计内容。

客户端仍负责完整 prompt、Memory、Tool、规划 Workflow、时间/action/分数校验与本地恢复；
DataCenter 只认证、分类、审计和转发 OpenAI-compatible 字节。流式响应保持顺序和取消；
非流式与流式请求都保留既有 idempotency 语义。

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
