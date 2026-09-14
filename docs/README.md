# WhaleHall documentation

Start with the [project overview](../README.md) to see what WhaleHall does.
The guides below follow the path from running the desktop application to
contributing to its individual components. Some detailed guides are in Chinese.

## Start here

- [Quick start](../README.md#quick-start): prerequisites, source checkout, and local launch.
- [Model gateway configuration](REMOTE_MODEL_CONFIGURATION.md): the fixed DataCenter account dependency, logical model roles, and cloud-sync settings; see [config.example.yaml](../config.example.yaml) for the format.
- [Contributing](../CONTRIBUTING.md): development commands, validation, branches, commits, and pull requests.
- [Desktop runtime setup](desktop-runtime.md#platform-prerequisites): platform dependencies, macOS signing, packaging, and account migration.

## Understand the system

- [Architecture](desktop-runtime.md#architecture): process boundaries and the detailed runtime graph.
- [Local Mastra Agent and model forwarding](CONVERSATION_AGENT_INTEGRATION.md): Agent lifecycle, local state, authentication, and planning.
- [Reflection and Timeline](REFLECTION_SYSTEM.md): events, windows, inference, persistence, and privacy.
- [Model-call boundary](MODEL_CALL_BOUNDARY.md): model orchestration, purposes, and release constraints.
- [Local Tool protocol](desktop-runtime.md#local-tool-protocol): JSONL requests, responses, events, and the tool catalogue.
- [Rust sensors](../whalehall-local/SENSORS.md): sensor ownership and links to each sensor's contract.

## Work on a component

- [Frontend standard](frontend/FRONTEND_STANDARD.md): feature structure, dependencies, state, styles, and acceptance requirements.
- [UI references](frontend/UI_REFERENCES.md): product references and WhaleHall's visual direction.
- [Calendar standard](frontend/CALENDAR_STANDARD.md): domain model, interactions, timezones, and tests.
- [macOS Observer](../native/observer/README.md) and [Vault Broker](../native/vault-broker/README.md): native observation and sensitive-content boundaries.
- [VS Code bridge](../integrations/vscode-whalehall/README.md): build, install, configure, and verify the editor extension.
- [Coding-agent guide](../AGENTS.md): repository instructions for automated contributors.

## Verify and troubleshoot

- [Build and integration gates](desktop-runtime.md#build-and-integration-gates): packaging and cross-repository checks.
- [Activity storage and verification](desktop-runtime.md#foreground-application-usage-and-sqlite): lifecycle, recovery, cleanup, and inspection.
- [Frontend release QA](frontend/RELEASE_QA.md): the acceptance checklist and dated verification records.
- [Desktop CI compatibility](../.github/CI_COMPATIBILITY.md): supported test environments and real-desktop runner requirements.
