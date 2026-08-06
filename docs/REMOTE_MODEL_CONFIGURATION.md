# WhaleHall 家里云模型配置

桌面端用户配置只有两个模型角色，并且每个角色只有 `name`、`baseurl`、`apikey`
三个字面量字段：

```yaml
reflection:
  name: "qwen3:1.7b"
  baseurl: "https://model.sea-ridethewindbreakthewaves.xyz"
  apikey: "REPLACE_WITH_REFLECTION_RELAY_KEY"

agent:
  name: "qwen3:1.7b"
  baseurl: "https://model.sea-ridethewindbreakthewaves.xyz"
  apikey: "REPLACE_WITH_PERSONAL_RELAY_KEY"
```

| 角色 | 用途 | 凭据边界 |
| --- | --- | --- |
| `reflection` | 在客户端构造完整活动反思 prompt，经通用 relay 调用模型并在本机整理事件列表和分数 | 独立 reflection relay key |
| `agent` | 远端账号密码登录后，将聊天与后台活动分析经 relay 转到 Qwen | 仅属于该账号的 personal relay key |

两个 checked-in 示例文件只含 `REPLACE_WITH_*` 不可用占位符。它们不会启用远端
请求，也不接受 `${ENV_VAR}`、空白密钥、替换模型、替换路径或其他字段。首次启动会把
`config.template.yaml` 复制到 user-data 的 `config.yaml`，权限为 `0600`；无效或旧版
配置绝不被应用自动重写。

## Owner provisioning

不要手工把密钥提交到仓库。owner 在本机交互式终端运行：

```sh
bun run provision:relay-owner -- \
  --config /absolute/local/WhaleHall-user-data/config.yaml \
  --users /absolute/local/model-relay-users.json
```

该命令询问账号资料和密码，生成 reflection relay key 与 personal relay key，并将两个真实
字面量 key 写入 owner-only 本机 `config.yaml`。生成的 `model-relay-users.json` 只含
`passwordHash`、`reflectionKeyId`、`reflectionKeyHash` 与 `agentKeyHash`，可部署到 relay；
它不含任何明文 key，也不应打印、上传或提交本机 `config.yaml`。

## 自动活动链路

1. Reflection 仅在自然封闭的 `EventWindowV1` 后排入本地 outbox。Bun 生成完整原始窗口
   prompt，交给本地 Mastra `activity-reflection` Workflow；其 Agent 通过框架原生的本地
   `skill` 元工具加载打包的分析与评分 `SKILL.md`，不注册产品 Tool。随后它经 host-owned
   `ModelRelayTransport` 请求固定 `/v1/activity/completions`。因此不会逐条原始事件请求模型。
2. relay 仅以 reflection key 鉴权、限流、allowlist 并原样转发非流式 OpenAI body 到 CPU
   Qwen；它不含反思 prompt、聚合、时间/action 格式化、分数计算或反思记录逻辑。模型 JSON
   返回客户端后，由 Bun 严格校验并生成中文事件列表、receipt、重试 outbox 和分数账本。
3. 累积分数达到固定阈值 `1` 时，所有尚未处理的本地事件/分数会合并成一个串行
   后台 job。该 job 不包含原始活动窗口，不注册 Tool，也不会向 renderer 广播结果。
4. 该 job 只在已登录的同一账号下运行；登录切换不会跨账号重放。完成结果加密保存到
   本机 Agent 数据库。断电、模型失败和退出会保留可恢复 job，并在原账号恢复后重试。

reflection 与正式 chat/activity-analysis relay 都只允许家里云的 CPU loopback
`127.0.0.1:11437` 和 `qwen3:1.7b`；不会回退到 GPU，因此既有 GPU 训练 Worker 不会被
这个 relay 占用。新 `/v1/activity/completions` 路由须随本仓库 relay 部署后才会生效；旧
`/v1/activity/analyze` Worker 不会被这项改动修改或重启。

## 远端认证与聊天

生产桌面端使用 `POST /v1/auth/sessions` 的邮箱密码登录、refresh 与 logout。access/
refresh token 保留在 Bun 主进程安全凭据存储中，renderer 和 sidecar 都拿不到它们。

每个 `POST /v1/chat/completions` 同时带短期 bearer 与
`X-WhaleHall-Agent-Key`。relay 对 bearer 所属账号的 `agentKeyHash` 做 scrypt 验证；
两个凭据必须属于同一账号。上游 Ollama/Qwen 凭据永不下发桌面端。

原生 Node 22 + systemd + Caddy 部署与回滚步骤见
[`deploy/home-cloud/model-relay/README.md`](../deploy/home-cloud/model-relay/README.md)。
该部署在 PR 合并后才执行，且不使用 Docker、不改动 FRP、Cloudflare 或训练服务。
