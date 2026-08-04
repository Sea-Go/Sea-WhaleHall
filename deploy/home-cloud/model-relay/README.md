# Home-cloud native relay deployment

This directory is deployment material only. Do not deploy it until the
corresponding PR is merged into `main`. It intentionally contains no Docker,
FRP, Cloudflare, GPU, activity-Worker, or other-project changes.

## Preconditions

On the home cloud, verify the CPU-only target before changing either relay or
Caddy. The relay code accepts exactly this loopback upstream and refuses a GPU
fallback:

```sh
curl --fail --silent http://127.0.0.1:11437/api/tags \
  | jq -e '.models[] | select(.name == "qwen3:1.7b")' >/dev/null
ss -ltnp | grep -F '127.0.0.1:11437'
node --version  # must be Node 22.x
```

If the CPU service or `qwen3:1.7b` is absent, stop here. Do not point this
relay at `11434`, GPU Ollama, or a training Worker.

Create the owner record locally, from the merged source checkout, with a real
interactive terminal:

```sh
bun run provision:relay-owner -- \
  --config /absolute/local/WhaleHall-user-data/config.yaml \
  --users /absolute/local/model-relay-users.json
```

This writes literal Worker and personal relay keys to the local owner-only
`config.yaml`, but writes only `passwordHash` and `agentKeyHash` to
`model-relay-users.json`. Copy only the latter to the server; never copy the
desktop `config.yaml` or print either key. Existing users require the explicit
`--replace` flag to avoid accidental overwrite.

## Install after merge

1. Build the merged `main` checkout with `bun install --frozen-lockfile` and
   `bun run build:model-relay`.
2. Place that checkout at `/opt/whalehall/Sea-WhaleHall`, owned by the
   non-login `whalehall` service account. Create
   `/var/lib/whalehall-model-relay` with owner `whalehall:whalehall`, mode
   `0700`.
3. Install the generated hash-only user file as
   `/etc/whalehall/model-relay-users.json`, mode `0640`, owner `root:whalehall`.
   This keeps it unreadable to other users while allowing the `whalehall` service
   group to read the scrypt hashes after systemd drops privileges.
   Install `model-relay.env.example` as `/etc/whalehall/model-relay.env`, adjust
   paths only, and keep it mode `0600`.
4. Install `whalehall-model-relay.service` under
   `/etc/systemd/system/`. Its `ExecStart` expects `/usr/bin/node`; confirm that
   path resolves to Node 22 before enabling it.
5. Add the exact handler in `Caddyfile.fragment` above generic model routing.
   Preserve the existing `/v1/activity/analyze` handler verbatim.
6. Only reload the two affected services:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now whalehall-model-relay.service
sudo systemctl status --no-pager whalehall-model-relay.service
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

The relay binds only to `127.0.0.1:8787`; Caddy is the public TLS boundary.
It retains encrypted-on-disk relay request/response records for 30 days.

## Verification and rollback

Use a scrubbed fixture account to verify `POST /v1/auth/sessions`, refresh,
logout, and `POST /v1/chat/completions` with both a bearer token and matching
`X-WhaleHall-Agent-Key`. Confirm the existing activity endpoint still answers
through its previous handler. Check `systemctl status` and relay logs only for
status/error metadata; neither should contain bearer tokens, personal keys, or
raw activity windows.

If the relay cannot start or verification fails, remove only the new Caddy
relay handler, reload Caddy, then stop and disable
`whalehall-model-relay.service`. Restore the previous merged application
release if needed. Do not modify FRP, Cloudflare, Docker, or the existing GPU
training/activity services as part of this rollback.
