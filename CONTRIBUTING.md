# Contributing to Sea-WhaleHall

Start with [README.md](README.md) for the system architecture and
[AGENTS.md](AGENTS.md) for repository-wide implementation rules. Client work
must also follow
[docs/frontend/FRONTEND_STANDARD.md](docs/frontend/FRONTEND_STANDARD.md);
calendar work additionally follows
[docs/frontend/CALENDAR_STANDARD.md](docs/frontend/CALENDAR_STANDARD.md).
## Environment

Required versions are pinned by the repository:

- Bun `1.3.14`;
- Rust `1.97.1` with Cargo, rustfmt, and Clippy;
- platform build tools required by Electrobun;
- macOS 14+, Windows 11+, or Ubuntu 22.04+ for supported development targets.

Install JavaScript dependencies without changing the lockfile:

```bash
bun install --frozen-lockfile
```

Follow the operating-system prerequisites in [README.md](README.md#requirements).
Do not use a different package manager or update `bun.lock` incidentally.

## Development commands

Start Electrobun using built views and its watcher:

```bash
bun run dev
```

Start Vite HMR and Electrobun together:

```bash
bun run dev:hmr
```

The standalone desktop-pet Action Lab is available while Vite runs at:

```text
http://127.0.0.1:5173/pet/demo.html
```

## Test and build commands

Use only commands that exist in the current `package.json`:

```bash
# TypeScript
bun run typecheck

# All Bun tests
bun run test

# Rust workspace tests
bun run test:rust

# Rust formatting, Clippy, and Rust tests
bun run check:rust

# TypeScript, complete Rust checks, and all Bun tests
bun run check

# Vite client/pet views
bun run build:views

# Native Local Tool Host
bun run build:native

# Unsigned Electrobun canary for the current host
bun run build:canary

# Native sensor JSONL integration probe
bun run test:sensors:ci

# Complete semantic pet animation catalogue verifier
bun run scripts/verify-pet-animations.ts
```

There is currently no repository `lint`, `format`, or E2E script. GitHub
Actions separately validates workflow YAML with actionlint and validates shell
scripts with `bash -n`. Do not report nonexistent local commands as completed.

## Branch names

Use a short lowercase kebab-case name:

```text
feat/calendar-week-view
fix/auth-session-expiry
docs/frontend-standards
test/pet-drag-rollback
chore/dependency-audit
```

Use the commit type as the branch prefix when practical. Avoid personal names,
issue dumps, and generic branches such as `changes` or `work`.

## Commit messages

Use Conventional Commits:

```text
<type>(<scope>): <description>
```

Allowed types:

```text
feat, fix, refactor, perf, style, test, docs, build, ci, chore, revert
```

Allowed scopes:

```text
client, shell, auth, plan, calendar, report, settings, pet, rpc, agent,
local, build, ci, deps, docs
```

The description must:

- be written in English;
- start with an imperative/base-form verb;
- have no trailing period;
- be at most 72 characters for the complete subject line.

Examples:

```text
feat(calendar): add weekly schedule editing
fix(auth): prevent protected content flash
docs(client): add frontend contribution standards
```

Commitlint, Husky, and lint-staged are not currently installed. The policy is
enforced through contributor review until the repository adopts a compatible
front-end lint/format toolchain. Do not add hooks or dependencies in an
unrelated feature.

## Pull requests

Keep a pull request focused on one product or engineering outcome. Complete
[the pull request template](.github/pull_request_template.md) and include:

- a concise summary and explicit scope;
- affected architecture boundaries;
- implemented loading/empty/error/offline/conflict states;
- exact commands run and their results;
- risk and rollback notes;
- related issues or specifications.

UI changes must include before/after screenshots at both `1440x900` and
`1180x720`. If a state did not exist before, label the before image
“not applicable” and provide the after image. Include screenshots for dense
calendar or long-text cases when affected.

Reviewers must be able to distinguish generated fixtures from production data.
Do not use screenshots containing credentials, browser history, accessibility
content, private calendar entries, or other real user data.

## Validation by change type

| Change | Minimum local validation |
| --- | --- |
| Documentation only | Check links, commands, terminology, and `git diff --check` |
| Client React/CSS | Affected tests, `bun run typecheck`, `bun run build:views`, visual acceptance |
| Typed RPC/Bun | Affected tests, `bun run typecheck`, `bun run test`, relevant desktop smoke |
| Pet renderer/behavior | Affected pet tests, animation verifier, `bun run build:views`, Action Lab check |
| Rust Local Tool/sensor | `bun run check:rust`, relevant Bun/native integration tests |
| Build/packaging | `bun run check`, `bun run build:canary` on the target host |

Before requesting review, run the broadest applicable validation and record
anything that could not be run. Do not describe a skipped check as passing.

## Secrets and local data

Never commit:

- API keys, access tokens, refresh tokens, cookies, passwords, or private keys;
- `.env` files containing real values;
- databases or exported data from the WhaleHall user-data directory;
- browser, activity, presence, accessibility, application inventory, or
  calendar data from a real account;
- local build output from `dist/`, `build/`, `artifacts/`, `.native/`, or Cargo
  `target/` directories;
- logs or screenshots containing sensitive user information.

Use deterministic fixtures and temporary directories in tests. Renderer logs
must not contain tokens or sensitive Tool payloads.

## UI and calendar review

UI direction and reference limits are defined in
[docs/frontend/UI_REFERENCES.md](docs/frontend/UI_REFERENCES.md). General
architecture, state, styling, accessibility, and Definition of Done are in
[docs/frontend/FRONTEND_STANDARD.md](docs/frontend/FRONTEND_STANDARD.md).
Calendar models, interaction, timezone, recurrence, and visual matrices are in
[docs/frontend/CALENDAR_STANDARD.md](docs/frontend/CALENDAR_STANDARD.md).
