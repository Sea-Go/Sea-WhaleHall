# WhaleHall 家里云模型配置

WhaleHall 的用户配置现在只加载两个模型角色：

```yaml
reflection:
  name: "qwen3:1.7b"
  baseurl: "https://model.sea-ridethewindbreakthewaves.xyz/v1/activity/analyze"
  apikey: "${WHALEHALL_ACTIVITY_WORKER_TOKEN}"

agent:
  name: "qwen3:1.7b"
  baseurl: "https://model.sea-ridethewindbreakthewaves.xyz/v1/activity/analyze"
  apikey: "${WHALEHALL_ACTIVITY_WORKER_TOKEN}"
```

字段只有以下三个：

| 字段 | 含义 |
| --- | --- |
| `name` | 家里云上固定使用的模型名，本配置为 `qwen3:1.7b`。 |
| `baseurl` | HTTPS Worker 的完整活动分析 URL。 |
| `apikey` | Worker Bearer 密钥，或受限的环境变量引用。 |

`config.template.yaml` 会在首次启动时复制为应用 user-data 目录的
`config.yaml`，该用户副本权限为 `0600`。仓库中的
[`config.example.yaml`](../config.example.yaml) 与根目录 `config.yaml`
都采用同一份家里云地址，但不包含真实密钥。

## 密钥

两项 `apikey` 当前都使用：

```text
${WHALEHALL_ACTIVITY_WORKER_TOKEN}
```

这会在应用启动时读取 `WHALEHALL_ACTIVITY_WORKER_TOKEN`。也可以在
owner-only 的 user-data `config.yaml` 中直接填写密钥：

```yaml
apikey: "your-worker-key"
```

不要把真实密钥写进 `config.example.yaml`、仓库根目录文件、Git、日志或
SQLite 收据。Finder 或安装包启动的桌面应用必须由对应启动机制提供该环境变量；
终端中的一次 `export` 不会传给已经运行的应用。

## 当前行为

`reflection` 会接收已经封闭的完整原始活动窗口，Worker 使用 Qwen 1.7B
整理为事件列表并返回分数。服务端保持 CPU 优先；GPU 仅在 CPU 无可用容量且
没有训练 work 占用时作为回退。

`agent` 也已加载同一模型、地址和密钥，供本地 Agent 执行器领取
`agentTriggerPending` 后使用。当前 Worker 的 HTTP 契约是
`activity-event-analysis-request.v1` / `activity-event-analysis-response.v1`，
不是通用 OpenAI 聊天接口；因此仅配置 Agent 不会额外发起一条聊天请求。

本地累计分数达到固定阈值 `1` 后，只持久化 `agentTriggerPending`。Worker
不会自行启动未定义的 Agent。保存配置后重启 WhaleHall 才会重新读取它。

## 校验

WhaleHall 严格拒绝以下情况，并保留原配置文件：

- 除 `reflection`、`agent` 以外的根字段；
- 每个角色缺少 `name`、`baseurl` 或 `apikey`；
- 非 HTTPS、回环地址、含用户名/密码、query 或 fragment 的 `baseurl`；
- 空白、含空格或格式错误的 `apikey` 环境变量引用。

旧版 `whalehall-client-config.v1` 会在内存中映射为这两个角色，以免已有
用户配置在升级时被覆盖；下一次手动保存时可改成上面的简化结构。
