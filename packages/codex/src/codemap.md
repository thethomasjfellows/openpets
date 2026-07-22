# packages/codex/src/

## Files

- `types.ts` — public status, action, component, and option contracts.
- `ownership.ts` — supported-version contract, managed markers, paths, commands,
  and transparent change descriptions.
- `codex-cli.ts` — bounded no-shell Codex command runner and safe summaries.
- `model-discovery.ts` — bounded official app-server `model/list` client and
  sanitized model/reasoning/modality contracts for the desktop AI Brain.
- `hook-settings.ts` — merge/install/remove/doctor logic plus read-only trust-hash
  verification for `~/.codex/hooks.json` and `config.toml`.
- `mcp-settings.ts` — ownership-aware Codex MCP inspect/install/remove/restore.
- `legacy-migration.ts` — exact legacy plugin/trust/cache/runtime cleanup while
  preserving shared marketplace entries and `~/.codex/pets/`.
- `integration.ts` — state-machine doctor with explicit component checks and
  transactional install/repair/disconnect orchestration. Stale approval hashes
  wait for interactive review rather than advertising an ineffective repair.
- `hooks.ts` / `cli.ts` — bounded stdin hook adapter and packaged executable.
- `check-codex-contract.ts` — behavior contracts for safe mapping, model
  discovery, hook merge, ownership, and legacy cleanup.

## Flow

`agent-setup.ts` resolves packaged entry paths → `integration.ts` diagnoses or
reconciles hooks/MCP → Codex runs `cli.ts hook` → `hooks.ts` emits a sanitized
`integration.event` and a pet reaction through `@open-pets/client`.
