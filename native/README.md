# Native source layout

`native/` is the ownership root for source that is compiled into subprocesses
shipped with the WhaleHall desktop application. It is distinct from generated
staging under `.native/` and from the packaged `app/native` directory.

| Component | Source | Boundary |
| --- | --- | --- |
| Rust Local Tool Host | `local-host/` | Cross-platform `protocol`, `core`, and `server` Cargo workspace |
| Credential helper | `credential-helper/` | Standalone cross-platform Cargo crate with its own lockfile |
| macOS Observer | `observer/` | Signed Swift helper for consent-bound desktop observation |
| macOS Vault Broker | `vault-broker/` | Signed C broker for protected observation content |

The Local Tool Host and credential helper intentionally remain separate Cargo
dependency and lockfile boundaries. Their executable names, wire contracts,
signing identities, and packaged destinations are independent of their source
locations.

`scripts/build-native.ts` is the canonical build and staging entry point.
Electrobun copies only staged artifacts from `.native/<os>-<arch>/`; source
directories are never packaged directly. Do not hand-edit any nested `target/`
directory or `.native/` output.

When adding or moving a native component, update the build script, Electrobun
watch/copy rules, CI cache and manifest paths, source-reading tests, and this
inventory together.
