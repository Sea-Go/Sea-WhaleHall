# WhaleHall model relay

This native Node 22 service is intentionally not an Agent. It exposes only:

- `POST /v1/auth/sessions`
- `POST /v1/auth/sessions/refresh`
- `DELETE /v1/auth/sessions/current`
- `GET /v1/auth/me`
- `POST /v1/chat/completions`

The chat endpoint requires both a short-lived bearer token and
`X-WhaleHall-Agent-Key`. It resolves the bearer subject first and verifies the
personal key against that exact user's `agentKeyHash` with the existing scrypt
format. Neither desktop bearer/relay keys nor upstream Qwen credentials are
forwarded upstream or returned in an API response.

It enforces an exact `qwen3:1.7b` allowlist, size/rate/idempotency limits, and
byte-preserving OpenAI-compatible forwarding. Relay records are retained for
30 days. It has no prompt injection, conversation/history, Tool, planning, or
activity-analysis endpoint; the latter is a local encrypted desktop workflow.

## Fixed production boundary

`bun run build:model-relay` emits ESM for Node 22 and `bun run start:model-relay`
starts it. The production entry point has no provider URL/key environment
options. It always:

- binds `127.0.0.1:8787`;
- forwards only to CPU-only Ollama
  `http://127.0.0.1:11437/v1/chat/completions`;
- allows only `qwen3:1.7b`;
- records requests/responses for 30 days.

Required environment values are intentionally limited to local file paths:

- `WHALEHALL_RELAY_USERS_FILE`: absolute owner-only JSON user file.
- `WHALEHALL_RELAY_DATA_DIR`: private directory for token digests and relay
  records.

`WHALEHALL_CHAT_REQUESTS_PER_MINUTE` and
`WHALEHALL_LOGIN_ATTEMPTS_PER_MINUTE` are bounded optional limits. The service
rejects all alternate HTTP endpoints, including GPU/Ollama paths.

The users file is an array (or `{ "users": [...] }`) containing `id`, `email`,
`displayName`, `initials`, `passwordHash`, `agentKeyHash`, and optional
`disabled`. Generate it using `bun run provision:relay-owner`; plaintext
passwords and personal relay keys must never be written to this file.

Deployment assets, CPU preflight, exact Caddy routes, and rollback steps are in
[`deploy/home-cloud/model-relay/README.md`](../../deploy/home-cloud/model-relay/README.md).
They use systemd and Caddy only—never Docker, FRP, Cloudflare, or the GPU
training Worker.
