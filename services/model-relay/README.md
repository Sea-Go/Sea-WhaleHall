# WhaleHall model relay

This service is intentionally not an Agent. It exposes only five endpoints:

- `POST /v1/auth/sessions`
- `POST /v1/auth/sessions/refresh`
- `DELETE /v1/auth/sessions/current`
- `GET /v1/auth/me`
- `POST /v1/chat/completions`

The chat endpoint authenticates an opaque bearer token, enforces an exact model
allowlist, request-size/rate/idempotency limits, stores the request and response,
adds the provider credential, and forwards the original OpenAI-compatible JSON
bytes. It never adds prompts, loads conversation history, executes tools, or
offers a history-read endpoint. Streaming responses remain streaming and are
recorded in byte order; incomplete streams are not replayed.

## Runtime configuration

The executable entry point is `main.ts`. `bun run build:model-relay` emits ESM
for Node 22, and `bun run start:model-relay` starts that build. Provider
credentials are never bundled. The following environment values are
required at runtime:

- `WHALEHALL_RELAY_USERS_FILE`: absolute path to a private JSON user file.
- `WHALEHALL_RELAY_DATA_DIR`: private directory for token digests and relay
  records.
- `WHALEHALL_PROVIDER_CHAT_COMPLETIONS_URL`: exact HTTPS provider endpoint.
- `WHALEHALL_PROVIDER_API_KEY`: provider credential, used only in the upstream
  `Authorization` header.
- `WHALEHALL_ALLOWED_MODELS`: comma-separated exact model identifiers; `*` is
  rejected.

The process binds to `127.0.0.1:8787` by default, for placement behind a TLS
reverse proxy. A non-loopback bind fails closed unless
`WHALEHALL_TRUSTED_TLS_PROXY=true` is explicitly set. Optional retention and
rate settings are documented by the names used in `main.ts`.

The user file is an array (or `{ "users": [...] }`) containing `id`, `email`,
`displayName`, `initials`, `passwordHash`, and optional `disabled`. Generate the
`passwordHash` with `createScryptPasswordHash`; plaintext passwords must never
be written to this file.

The built-in file stores are single-process adapters. Multi-instance deployments
must inject transactional shared implementations of `SessionStore`,
`RelayRecordStore`, and `RateLimiter` into `createModelRelayHandler`.
