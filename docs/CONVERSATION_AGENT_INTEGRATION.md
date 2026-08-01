# 对话 Agent 接入

桌面端 React 不直接访问 Agent。对话请求固定经过：

```text
React conversation feature -> Electrobun Typed RPC -> Bun main -> Agent HTTP facade
```

Agent 项目 `whaleHall/agent` 启动 Mastra 后提供以下本地接口：

- `GET /v1/conversations/active`
- `POST /v1/conversations`
- `POST /v1/conversations/messages`

所有请求由 Bun 添加 `x-whalehall-user-id`，因此浏览器页面不会接触 Agent 地址或认证令牌。响应只包含对话、用户消息和助手文本；工作流 trace、提示词、检索候选及动作原始载荷不得返回给前端。

## 本地联调

1. 在 `D:\study\Out-of-class_Learning\programme\My_project\whaleHall\agent` 配置数据库与模型所需环境变量。桌面联调应使用构建后的稳定服务：

   ```powershell
   npm.cmd run build
   npm.cmd start
   ```

   `npm.cmd run dev` 仅用于修改 Agent 代码时的热重载开发；它重载期间可能暂时返回 502，不应与桌面稳定联调混用。

2. 启动桌面应用前，在同一进程环境中配置：

   ```powershell
   $env:WHALEHALL_AGENT_API_URL = "http://127.0.0.1:4111"
   ```

3. 可选：两端设置同一个 `WHALEHALL_AGENT_API_TOKEN`。设置后，Agent 会拒绝未携带相同令牌的请求。

`WHALEHALL_AGENT_API_URL` 仅接受 HTTPS，或本机回环地址的 HTTP。若未配置或服务不可达，界面会显示可恢复的不可用/离线状态。

当前接口采用一次请求一次完整回复，尚未引入 token 流式传输、对话列表、删除会话或动作确认执行。
