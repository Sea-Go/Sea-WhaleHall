# WhaleHall Vault Broker v2

This directory contains the macOS 14 local vault broker. It accepts exactly one
binary request on file descriptor 3 and returns at most one response on that
socket. Key bytes are never accepted through arguments, environment variables,
standard input, standard output, standard error, or JSON.

The caller must half-close its write side after the exact 32-byte request. The
broker waits for EOF under the five-second socket timeout; truncation, a byte 33
(including one sent after a delay), or withheld EOF fails closed.

The packaged and immutable installed executable basename is fixed as
`whalehall-vault-broker-v2`. The broker runs from its versioned, owner-only
installation outside the replaceable application bundle. The build must define
both code-signing requirements; omitting either macro is a compile-time error
in `process_guard.c`:

```text
WHALEHALL_CORE_REQUIREMENT
WHALEHALL_OUTER_REQUIREMENT
```

After v2 has been published or installed, any change to these sources, the
compiler/linker, signing requirements, or wire contract requires a complete
immutable version bump. The two-build hash/CDHash/DR gate proves only
reproducibility within one build; it is not permission to publish different
bytes under the v2 namespace.

The broker binds the socket's audit-token PID and effective UID to its direct
core parent, then verifies the exact launcher/Bun/core ancestry and immutable
process start times. It performs strict static code validation of the canonical
core executable and the complete launcher-derived app bundle, covering Bun and
sealed resources, before every Keychain operation and key response. Their
shared canonical app-bundle paths, the broker's signed versioned no-overwrite
install path, and kqueue NOTE_EXIT watches remain fail-closed boundaries.
Failure diagnostics use only fixed `whvb stage=...` Unified Logging messages;
they never include content, paths, process identifiers, Keychain values, or
caller-supplied strings.

The frame parser/encoder is pure C and can be tested independently:

```sh
clang -std=c11 -Wall -Wextra -Werror \
  native/vault-broker/frame.c native/vault-broker/Tests/frame_tests.c \
  -o /tmp/whalehall-vault-frame-tests
/tmp/whalehall-vault-frame-tests
```

`Tests/static_code_tests.c` links the production static-validation seam and
verifies a locally signed core executable and complete app bundle against their
distinct pinned requirements. It also verifies that swapping those
requirements fails closed.

`Tests/keychain_policy_tests.c` verifies authoritative-source comparison and
idempotent IMPORT result semantics without reading the login Keychain.

A production compile links the macOS Security and CoreFoundation frameworks
and libbsm. For example, the build supplies properly shell-escaped requirement
strings and compiles `main.c`, `frame.c`, `keychain_store.c`, and
`process_guard.c` with:

```text
-mmacosx-version-min=14.0 -framework Security -framework CoreFoundation -lbsm
```
