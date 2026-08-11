# Home-cloud native relay deployment

This directory is deployment material only. Do not deploy it until the
corresponding PR is merged into `main`. It intentionally contains no Docker,
FRP, Cloudflare, GPU, activity-Worker, or other-project changes.

The public model origin routes only `POST /v1/activity/completions` to this
service. Authentication, chat, Agent registration, consent, crypto context and
desktop event ingestion belong to the DataCenter data origin and must not be
added to this Caddy handler.

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

This writes literal reflection and personal relay keys to the local owner-only
`config.yaml`, but writes only `passwordHash`, `reflectionKeyId`,
`reflectionKeyHash` and `agentKeyHash` to `model-relay-users.json`. Copy only
the latter to the server; never copy the desktop `config.yaml` or print either
key. Existing users require the explicit `--replace` flag to avoid accidental
overwrite.

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
5. Add the exact allow and deny handlers in `Caddyfile.fragment` above generic
   model routing. Preserve the existing `/v1/activity/analyze` handler verbatim.
6. Only reload the two affected services:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now whalehall-model-relay.service
sudo systemctl status --no-pager whalehall-model-relay.service
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

The relay binds only to `127.0.0.1:8787`; Caddy is the public TLS boundary.
It retains encrypted-on-disk chat request/response records for 30 days, while
reflection bodies are forwarded transiently and never written to relay storage.

## Verification and rollback

Verify `/v1/activity/completions` with only the provisioned
`X-WhaleHall-Reflection-Key`, a non-streaming scrubbed body, and an empty relay
record directory. Confirm the existing `/v1/activity/analyze` endpoint still
answers through its previous handler. Then verify the model origin fails closed
before any generic `/v1/*` model handler can receive the request:

```sh
model_origin=https://model.sea-ridethewindbreakthewaves.xyz
test "$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --request GET "$model_origin/v1/activity/completions")" = 405
for data_path in \
  /v1/auth/me \
  /v1/chat/completions \
  /v1/agent/register \
  /v1/devices/test-device/consents/activity \
  /api/v1/agent/events/desktop/cursor; do
  test "$(curl --silent --output /dev/null --write-out '%{http_code}' \
    "$model_origin$data_path")" = 404
done
```

Verify those DataCenter endpoints independently against the data origin. Check
`systemctl status` and relay logs only for status/error metadata; neither should
contain bearer tokens, keys, or raw activity windows.

If the relay cannot start or verification fails, remove only the new Caddy
relay handler, reload Caddy, then stop and disable
`whalehall-model-relay.service`. Restore the previous merged application
release if needed. Do not modify FRP, Cloudflare, Docker, or the existing GPU
training/activity services as part of this rollback.
