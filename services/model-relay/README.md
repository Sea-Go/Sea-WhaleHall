# WhaleHall model relay

> **状态：遗留独立资产。** 打包后的 WhaleHall 桌面端不会启动或调用此服务；当前生产
> 模型路径是桌面 → DataCenter `/v1/chat/completions`。本目录保留给历史 loopback-Ollama
> 部署资料和回归测试，不能作为 DataCenter 的替代或回退。

This native Node 22 service is intentionally not an Agent. It exposes only:

- `POST /v1/auth/sessions`
- `POST /v1/auth/sessions/refresh`
- `DELETE /v1/auth/sessions/current`
- `GET /v1/auth/me`
- `POST /v1/chat/completions`

The chat endpoint requires a short-lived bearer token and the code-owned
`X-WhaleHall-Model-Purpose: agent|activity|planning` header. It resolves the account only
from the bearer subject. Historical `X-WhaleHall-Agent-Key` input is ignored
for compatibility, never authenticated, forwarded, logged, or stored. Neither
the desktop bearer nor upstream Qwen credentials are forwarded upstream or
returned in an API response.

The former bearer-less `/v1/activity/completions` route is retired. Activity
reflection now uses authenticated DataCenter `/v1/chat/completions` with the
current user's bearer and a host-owned purpose header. This service must not be
used as an activity fallback.

It enforces an exact `qwen3:1.7b` allowlist, size/rate/idempotency limits, and
byte-preserving OpenAI-compatible forwarding. Authenticated model relay records
retain their code-owned purpose for 30 days. It has no prompt injection,
conversation/history, Tool, planning, or activity-analysis policy endpoint;
the latter is a local encrypted desktop workflow.

## Fixed production boundary

`bun run build:model-relay` emits ESM for Node 22 and `bun run start:model-relay`
starts it. The production entry point has no provider URL/key environment
options. It always:

- binds `127.0.0.1:8787`;
- forwards only to CPU-only Ollama
  `http://127.0.0.1:11437/v1/chat/completions`;
- allows only `qwen3:1.7b`;
- records authenticated agent/activity/planning requests and responses for 30 days.

Required environment values are intentionally limited to local file paths:

- `WHALEHALL_RELAY_USERS_FILE`: absolute owner-only JSON user file.
- `WHALEHALL_RELAY_DATA_DIR`: private directory for token digests and relay
  records.

`WHALEHALL_CHAT_REQUESTS_PER_MINUTE` and
`WHALEHALL_LOGIN_ATTEMPTS_PER_MINUTE` are bounded optional limits. The service
rejects all alternate HTTP endpoints, including GPU/Ollama paths.

The users file is an array (or `{ "users": [...] }`) containing `id`, `email`,
`displayName`, `initials`, `passwordHash`, and optional `disabled`. Generate it
using `bun run provision:relay-owner`; plaintext passwords must never be written
to this file. A historical `agentKeyHash` or retired reflection credential field
in an older file is accepted only as compatibility input, discarded during
parsing, and never loaded into the runtime user model.

Deployment assets, CPU preflight, exact Caddy routes, and rollback steps are in
[`deploy/home-cloud/model-relay/README.md`](../../deploy/home-cloud/model-relay/README.md).
They use systemd and Caddy only—never Docker, FRP, Cloudflare, or the GPU
training Worker.
