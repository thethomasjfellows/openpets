# packages/codex/

First-class Codex integration owned and packaged by the OpenPets desktop app.

## Responsibility

Detects the supported Codex CLI contract, manages marker-owned lifecycle hooks
and the `openpets` MCP entry, diagnoses Codex hook trust, migrates the exact
legacy OpenPets marketplace plugin after replacement verification, and ships
the bounded hook adapter invoked by Codex.

## Design

- Configuration is inspected before mutation and classified into installable,
  waiting-for-trust, connected, repair, conflict, and unsupported states.
- `~/.codex/hooks.json` is merged atomically with backups; unrelated hooks are
  preserved and only `--openpets-managed` entries are removed.
- MCP install/remove uses the Codex CLI and refuses to remove a foreign entry.
- Install/repair rolls hook and MCP changes back if the replacement cannot be
  verified. Legacy removal runs only after that verification.
- The runtime maps allow-listed hook event names to lifecycle/reaction enums and
  never forwards raw prompt, tool input, output, paths, or secrets.

See [src/codemap.md](src/codemap.md) and
[../../docs/agent-integrations.md](../../docs/agent-integrations.md).
