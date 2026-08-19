# First-Class Codex Integration: Plan

## Goal

Add Codex as a first-class Control Center integration that OpenPets can detect, install, repair, diagnose, migrate, and disconnect without a Codex marketplace plugin or startup-time `npx`. A healthy integration installs both lifecycle reactions and OpenPets MCP pet controls, and makes the existing Codex CLI Companion provider selectable; when disconnected, that provider remains visible but disabled with a “Connect Codex in Integrations” explanation.

## Background

- The existing Integrations management spine is renderer → narrow preload → main-process IPC → `agent-setup.ts`: `apps/desktop/src/renderer/src/main.tsx:2281`, `apps/desktop/control-center-preload.cjs:80`, `apps/desktop/src/windows.ts:779`, and `apps/desktop/src/agent-setup.ts:13`. Claude already supplies the closest card/action/status/managed-change patterns at `apps/desktop/src/renderer/src/main.tsx:2318` and `packages/claude/src/hook-settings.ts:7`.
- The current repository has no tracked Codex marketplace-plugin source. The legacy installation is user-side state: an `openpets@personal` registration/cache, hook trust hashes, MCP contribution, skill payload, and runtime data. The current development machine’s legacy plugin, marketplace entry, cache, and trust records were removed before planning; `~/.codex/pets/` and unrelated Codex state were preserved. Product work must still automatically detect and migrate this footprint for existing users.
- Codex CLI 0.144.4 discovers pluginless command hooks from `~/.codex/hooks.json` or inline `[hooks]` config. Hook trust is definition-hash based with managed/trusted/untrusted/modified states, but approval/status management is interactive through `/hooks`; there is no supported noninteractive `codex hooks` command. OpenPets may inspect only its exact managed entries and hashes, while Codex remains the authority that grants trust.
- Codex MCP servers are supported through global `[mcp_servers.<name>]` configuration and the supported `codex mcp add/get/list/remove` commands. The desktop already ships `@open-pets/mcp`, resolves ASAR-unpacked package paths, and validates bundled package artifacts: `packages/mcp/src/index.ts:160`, `packages/mcp/src/server.ts:5`, `packages/claude/src/claude-code.ts:70`, and `apps/desktop/src/check-packaging-contract.ts:285`.
- Lifecycle events already flow through the shared client and local IPC into pet reactions/speech: `packages/claude/src/hooks.ts:34`, `packages/client/src/index.ts:63`, and `apps/desktop/src/local-ipc.ts:386`. The new adapter should reuse the shared safe event pools, lease behavior, throttling principles, and scoped logging rather than plugin runtime APIs.
- Companion Codex is deliberately a separate host-owned provider path. Selection/persistence/execution live at `apps/desktop/src/renderer/src/main.tsx:2998`, `apps/desktop/src/companion-settings.ts:49`, `apps/desktop/src/companion-target-codex.ts:12`, and `apps/desktop/src/voice-conversation-codex.ts:27`. Provider changes cancel active turns, and every turn rechecks runtime readiness. Integration health must gate UI selectability without merging integration semantics into personality, memory, voice, or provider execution.
- User decisions: keep Codex CLI visible but disabled when disconnected; connecting installs lifecycle reactions and MCP pet controls together with no extra toggle; automatically remove the legacy marketplace-plugin footprint to avoid conflicts; do not configure Codex as the pet’s brain from the Integrations card.

## Approach

Create a dedicated repository-owned Codex integration package and make the desktop app its sole management surface. The package owns Codex discovery, standalone hook generation/runtime, exact managed-entry inspection, MCP registration, trust classification, and forward-only legacy migration; the desktop owns orchestration, UI state, logging, last-event presentation, and the relationship to Companion settings.

Install one cohesive integration:

1. Merge marker-bearing OpenPets command hooks into the supported user hook file without replacing unrelated hooks. Each command invokes a built, ASAR-unpacked OpenPets Codex adapter shipped with the desktop app—never a marketplace plugin or startup-time package fetch.
2. Register the shipped `@open-pets/mcp` entry as the global `openpets` MCP server through supported Codex CLI management commands. The MCP tools are part of the integration and have no separate toggle.
3. Let Codex remain the trust authority. For the initially supported Codex 0.144.x schema, OpenPets inspects only its versioned desired definitions and the corresponding read-only `hooks.state` records, using fixture-tested normalization/hash behavior from the matching Codex source. It reports trusted/waiting/modified/unsupported states, directs the user to Codex’s `/hooks` approval UI, and never writes trusted hashes or bypasses trust. Unknown schemas are diagnostic-only until explicitly supported.
4. Treat setup health as a composite contract: compatible Codex CLI detected, managed hooks current, hook trust confirmed, bundled MCP registration current, and no blocking legacy/conflicting entry. Repair reconciles OpenPets-owned drift. A foreign `openpets` collision stays blocked until the user invokes Repair after reviewing the exact replacement in “What OpenPets changes”; background detection never overwrites it.
5. Keep integration and Companion concepts separate. The Integrations card connects Codex activity and pet controls. Companion settings separately decide whether Codex is the pet’s AI provider, but the existing Codex CLI option is selectable only when both the integration contract and the existing JSON exec/resume capability probe are healthy. Disconnecting does not rewrite the user’s stored provider preference; it makes the option and send path unavailable until reconnection.

The status model should be a single clone-safe snapshot shared by the card and Companion UI. It includes CLI version/location, overall connection state, hook install/trust state, MCP state, legacy migration/conflict state, last redacted lifecycle event and timestamp, supported actions, and a disclosure list of exact OpenPets-managed files/entries. Raw hook payloads, prompts, tool inputs, secrets, and unrelated Codex configuration never cross the renderer bridge or enter logs.

Use an explicit state machine:

| State | Meaning | Companion Codex |
| --- | --- | --- |
| `not_detected` | Compatible Codex executable not found | Visible, disabled |
| `installable` | CLI supported; no managed integration | Visible, disabled |
| `installing` | Transactional reconciliation in progress | Visible, disabled |
| `waiting_for_trust` | Hooks/MCP installed, Codex approval outstanding | Visible, disabled; MCP may work but integration is not connected |
| `connected` | Hooks current/trusted and MCP current | Eligible, pending the existing exec/resume health probe |
| `needs_repair` | OpenPets-owned entries are missing or modified | Visible, disabled |
| `conflict` | Foreign-owned `openpets` entry blocks safe setup | Visible, disabled |
| `unsupported` | CLI/config schema cannot be managed safely | Visible, disabled |

Install/repair is staged and rollback-aware: preflight the CLI/schema, paths, desired ownership manifest, and collisions; back up and merge hooks; register MCP; verify both; only then remove provably owned legacy registration/state. If replacement verification fails, restore prior managed hook/MCP state and leave the legacy installation intact. Ambiguous residue is reported rather than automatically deleted.

## Work Items

### Item 1 — Establish the Codex integration package and public contract

**Goal:** Add a focused `@open-pets/codex` workspace package with a versioned ownership/runtime manifest covering supported Codex versions, managed hook identities, canonical definitions/trust classification, MCP name/command, bundled path resolution, and legacy-owned keys/paths.

**Done when:** The package exports typed detect/doctor/install/repair/disconnect APIs, a hook stdin entry point, composite state-machine types, pure managed-change previews, and a 0.144.x ownership manifest backed by fixtures. Desktop dependency/build declarations resolve the adapter and MCP command in development and packaged ASAR-unpacked layouts. The package does not import Electron or renderer code.

**Key files:** `pnpm-workspace.yaml`; `packages/codex/package.json`; `packages/codex/tsconfig.json`; `packages/codex/src/index.ts`; `packages/codex/src/ownership.ts`; `apps/desktop/package.json:24`; patterns in `packages/claude/src/claude-code.ts:5`, `packages/claude/src/hook-settings.ts:7`, `packages/claude/src/hooks.ts:10`, and `packages/claude/src/claude-code.ts:89`.

**Dependencies:** None.

**Size:** M

### Item 2 — Implement the bundled lifecycle hook adapter

**Goal:** Convert Codex lifecycle hook JSON from stdin into safe OpenPets reactions and speech through the shared client, with bounded parsing, throttling, lease handling, and redacted diagnostics.

**Done when:** Supported Codex events drive the intended thinking/editing/testing/waiting/success/error reactions; malformed or unknown payloads fail closed; raw agent content is never spoken or logged; repeated events are throttled; and each accepted event sends a separate sanitized integration-event record (integration id, lifecycle enum, timestamp only) through the validated client/local-IPC boundary for the card’s last-event field.

**Key files:** `packages/codex/src/hooks.ts`; `packages/codex/src/cli.ts`; `packages/agent-events/src/`; `packages/client/src/index.ts:63`; `packages/client/contracts/`; `packages/claude/src/hooks.ts:34`; `apps/desktop/src/local-ipc.ts:386`; `apps/desktop/contracts/local-ipc-protocol.contract.ts`.

**Dependencies:** Item 1.

**Size:** L

### Item 3 — Add safe hook/MCP management and forward-only legacy migration

**Goal:** Reconcile only OpenPets-owned Codex configuration while preserving unrelated user hooks, MCP servers, marketplaces, plugins, trust state, projects, profiles, and local pets.

**Done when:** A preflighted install/repair atomically merges versioned marker-bearing hooks and registers the bundled MCP server through `codex mcp`, then verifies both before migrating anything. Failure restores the prior managed hook/MCP state. Disconnect removes only ownership-manifest entries. After replacement verification, one-time migration removes the legacy `openpets@personal` registration, exact trust keys, and provably owned residue; it removes the marketplace only when no other dependent remains, reports ambiguous residue, and never touches `~/.codex/pets/`. A foreign collision requires the explicit, disclosed Repair action.

**Key files:** `packages/codex/src/hook-settings.ts`; `packages/codex/src/mcp-settings.ts`; `packages/codex/src/legacy-migration.ts`; `packages/codex/src/transaction.ts`; atomic-write patterns at `packages/claude/src/hook-settings.ts:273` and `packages/opencode/src/opencode-config.ts:107`; bundled MCP resolution at `packages/claude/src/claude-code.ts:70`; `apps/desktop/electron-builder.yml:11`; `apps/desktop/src/check-packaging-contract.ts:263`.

**Dependencies:** Items 1–2.

**Size:** L

### Item 4 — Build desktop orchestration, status, and event observability

**Goal:** Make `agent-setup.ts` the app-facing owner of Codex detect/doctor/install/repair/disconnect/migration actions and expose one narrow status snapshot to the renderer.

**Done when:** The main process is the authoritative state-machine owner; reports detected Codex path/version, composite connection state, hook trust, MCP health, last sanitized event, available actions, and exact managed-change disclosure; refreshes after every transition; records concise scoped logs; and persists only integration id/event enum/time. Automatic migration runs only after verified replacement setup and remains idempotent after interruption.

**Key files:** `apps/desktop/src/agent-setup.ts:13`; `apps/desktop/src/windows.ts:779`; `apps/desktop/control-center-preload.cjs:80`; `apps/desktop/src/agent-activity-payload.ts:7`; `apps/desktop/src/app-state.ts:39`; `apps/desktop/src/logger.ts`.

**Dependencies:** Items 1–3.

**Size:** L

### Item 5 — Add the first-class Codex Integrations card

**Goal:** Place Codex beside Claude Code with transparent status, diagnosis, and lifecycle actions.

**Done when:** The card shows detected version/location, overall connection, Activity reactions, MCP pet controls, hook trust, last event, and Install/Repair/Disconnect actions. “Waiting for approval in Codex” includes a precise `/hooks` instruction. “What OpenPets changes” lists the exact managed hook file/entries, MCP entry/command, bundled runtime source, read-only trust record, and any legacy entries scheduled for cleanup. The card never describes Companion provider selection as part of connection.

**Key files:** `apps/desktop/src/renderer/src/main.tsx:2281`; Claude card patterns at `apps/desktop/src/renderer/src/main.tsx:2318`; bridge types at `apps/desktop/src/renderer/src/main.tsx:150`; `apps/desktop/src/i18n/locales/en.ts:672`.

**Dependencies:** Item 4.

**Size:** L

### Item 6 — Gate the existing Codex Companion provider on integration health

**Goal:** Keep Codex CLI visible in Companion/AI settings but disable selection until the first-class integration and the existing Codex JSON conversation contract are healthy.

**Done when:** The selector always displays Codex CLI; disconnected/waiting/repair states disable it and link users to Integrations; connected state triggers the existing `codex exec --json`/resume probe and enables it only when that probe succeeds. The renderer fetches Codex integration/target health even when Host AI is selected, disables Send when the selected target is unavailable, and the main process remains the authoritative guard. Provider switching still cancels active turns, stored provider choice is not silently rewritten on disconnect, and personality/memory/voice/plugin context remain host-owned.

**Key files:** `apps/desktop/src/renderer/src/main.tsx:2998`, `apps/desktop/src/renderer/src/main.tsx:3049`, `apps/desktop/src/renderer/src/main.tsx:3135`; `apps/desktop/src/windows.ts:240`; `apps/desktop/src/companion-settings.ts:49`; `apps/desktop/src/companion-target-codex.ts:12`; `apps/desktop/src/voice-conversation-codex.ts:27`.

**Dependencies:** Item 4. The card in Item 5 consumes the same contract but does not block Companion enforcement.

**Size:** M

### Item 7 — Protect behavior, update documentation, and verify on a clean Codex profile

**Goal:** Add regression evidence for the user-visible contracts and keep maintained docs aligned with the new ownership model.

**Done when:** Focused tests fail if unrelated Codex config is overwritten, managed hook/MCP entries drift, trust is falsely claimed, transactional rollback loses prior state, legacy migration touches local pets/shared marketplaces, hook events leak raw content, or Companion Codex becomes selectable while disconnected. Packaging checks prove the adapter, MCP entry, and client dependency resolve under `app.asar.unpacked`, with no `npx` fallback. Desktop quality gates pass. Manual verification covers install → Codex approval → event receipt → MCP pet control → Companion selection → repair → disconnect, plus automatic migration and rollback fixtures. Documentation names the integration/Companion distinction, exact managed files, approval flow, troubleshooting, logging, and packaged-runtime contract.

**Key files:** `packages/codex/src/*.test.ts`; `apps/desktop/tests/`; `apps/desktop/src/check-packaging-contract.ts`; `docs/agent-integrations.md`; `docs/desktop.md`; `docs/development.md`; `docs/testing-and-validation.md`; verify `docs/plugins.md` and `docs/superplugins.md` remain accurate.

**Dependencies:** Items 1–6.

**Size:** L

## Open Questions

None currently block planning. Implementation must preserve the distinction between “integration connected” and “Codex selected as Companion provider,” and must not imply that OpenPets can approve hook trust on Codex’s behalf.

## References

- [Official Codex hooks documentation](https://learn.chatgpt.com/docs/hooks)
- [Official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp)
- [Official Codex configuration basics](https://learn.chatgpt.com/docs/config-file/config-basic)
- `docs/agent-integrations.md:73`
- `docs/agent-integrations.md:153`
- `docs/desktop.md:117`
- `docs/testing-and-validation.md`
