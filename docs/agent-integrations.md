# Agent Integrations & CLI

OpenPets reacts to coding agents. Each supported agent has an integration
package that does two jobs: **configure** the agent to talk to OpenPets, and at
runtime **translate** the agent's activity into safe pet reactions sent over
local IPC. This doc covers the first-class integrations (Claude Code, Codex,
MCP, OpenCode, Cursor, Pi), the shared speech-safety layer, and the CLI that
orchestrates them.

For the wire protocol they all use, see [ipc.md](ipc.md). Source maps live in
each `packages/*/codemap.md`.

## The shared shape

Every integration follows the same contract, which is worth internalizing once:

- **Configuration is atomic and reversible.** Writes go through temp-file +
  rename with a backup first; paths are validated against traversal/symlink
  escape; managed entries are marked so they can be detected, updated, and
  removed without clobbering the user's own config. Status is always classified
  (`missing`/`installed`/`needs-update`/`conflict`/`invalid`/…), so the UI and
  CLI can offer the right action.
- **Runtime is fire-and-forget.** Agent events are classified into a reaction
  and/or a speech category, dispatched non-blocking, and any IPC failure is
  swallowed. The pet must never slow down or break the agent.
- **Speech is always safe.** Automatic messages come from validated pools (see
  below), never from raw prompt/output text.
- **Leases route the pet.** Integrations acquire a lease on first activity,
  heartbeat it, and release on shutdown. See the lease model in [ipc.md](ipc.md).

## Pet pool: multiple agents, multiple pets

By default every agent session that does not pass `--pet <id>` shares the single
default pet. The **pet pool** preference (Control Center → Settings → General,
`petPoolEnabled`, off by default) changes this so concurrent sessions each get
their own pet from a user-configured ordered list.

**How it works when enabled:**

- The user configures an ordered list of installed pets in Settings. Slot 1 is
  the primary/default pet; subsequent slots are assigned to additional concurrent
  sessions in order.
- When a new session starts without `--pet`, the lease manager assigns it the
  first pool slot not currently held by an active session.
- Once every pool slot is occupied, additional sessions are assigned a random
  eligible pet (installed, non-broken, excluding the built-in default).
- When a session ends its lease, its pet slot is freed and available to the next
  session.
- **`--pet <id>` always takes priority** and bypasses the pool entirely —
  unchanged from current behavior.

**Eligible pool pets** are installed, non-broken pets excluding the built-in
default. Broken or uninstalled pets are skipped silently.

**Cross-platform and agent-agnostic.** Pool assignment is pure lease logic with
no platform dependency — it works on macOS, Windows, and Linux. Any agent that
acquires a lease through the shared OpenPets client benefits automatically: Claude
Code CLI, opencode, Cursor, and any other MCP client all go through the same
`lease.acquire` path.

When the pool is disabled (the default), behavior is unchanged: all sessions
without `--pet` share the single default pet.

## Safe speech: `@open-pets/agent-events`

`packages/agent-events/` is the shared guardrail. It provides curated speech
pools by category — `thinking`, `success`, `error`, `permission` — and the
validators that keep messages safe: single line, 1–140 chars, and rejecting
code, URLs, file paths, and secret-like tokens. `pickHookSpeech(category)`
selects a message; `validateHookSpeech()` enforces the rules. `claude`,
`opencode`, and `pi` all depend on it so no integration can leak sensitive text
into a bubble.

## Claude Code — `@open-pets/claude`

The deepest integration, because Claude Code has a rich hook system.

- **MCP setup** (`claude-code.ts`): registers an MCP server named `openpets`
  using `claude mcp add/get/remove`. Command modes: `published`
  (`npx -y @open-pets/mcp`), `local`, `bundled` (ASAR-unpacked path). Paths are
  validated to stay within expected directories.
- **Hooks** (`hook-settings.ts` + `hooks.ts`): installs command hooks into
  `~/.claude/settings.json` for the lifecycle events `UserPromptSubmit`,
  `PreToolUse`, `PermissionRequest`, `Notification`, `Stop`, `StopFailure`. Each
  managed entry carries the `--openpets-managed` marker. `runClaudeHookFromStdin()`
  maps an event to a reaction: prompt submit → thinking, permission → waiting,
  stop → success, stop-failure → error, and `PreToolUse` is classified by tool
  (Edit/Write/MultiEdit → editing, Bash test commands → testing).
- **Project-local awareness**: if a project defines its own OpenPets hook
  (`.claude/settings.local.json` with `--project-local`), the global hook stands
  down to avoid double-firing.
- **Throttling**: ~20s speech / ~3s permission / ~10s reaction cooldowns via a
  JSON state file, so the pet doesn't chatter.
- **Memory**: the desktop's `claude-memory.ts` manages `~/.claude/openpets.md`
  (the instructions file telling Claude how to use the pet).

Doctor/install/uninstall helpers (`installClaudeHooks`, `doctorClaudeHooks`, …)
are what the Control Center Integrations page and the CLI call.

## Codex — `@open-pets/codex`

The Control Center owns Codex setup as a first-class integration. OpenPets does
not install a Codex marketplace plugin and does not launch an `npx` download at
Codex startup. The desktop packages both the hook adapter and the existing
`@open-pets/mcp` runtime, then configures Codex to invoke those ASAR-unpacked
files directly.

- **Detection and status:** the card reports the detected Codex version and
  executable, connection state, hook trust, MCP ownership, last sanitized event,
  and every managed path/entry. The current adapter is contract-gated to the
  verified Codex `0.144+` hook/config surface within the current `0.x` line;
  older and future-major versions show Unsupported instead of guessing.
- **Activity reactions:** the Codex integration card separately controls task
  start, in-progress, and task-completed pet reactions. New installs enable only
  completion (success or error), keeping the pet quiet while Codex starts and
  works unless the user opts into those updates. Managed entries in
  `~/.codex/hooks.json` still report thinking, working, editing, testing,
  waiting, success, and error states. The desktop returns the applicable saved
  preference with each sanitized lifecycle event, and the hook sends a pet
  reaction only when that stage is enabled. `UserPromptSubmit`, `PreToolUse`,
  `PermissionRequest`, `PostToolUse`, `SubagentStop`, and `Stop` provide the
  lifecycle signals. Raw prompt, tool input, output, paths, and secrets are never
  persisted or sent as event metadata.
- **Pet controls:** the same Connect transaction registers the bundled
  `openpets` MCP server. Users can ask Codex to make the pet react, say a short
  message, or show a local image through `openpets_react`, `openpets_say`, and
  `openpets_show_media`. These intentional MCP controls remain available when
  any or all automatic lifecycle reaction stages are disabled.
- **Trust:** OpenPets writes hooks but never self-approves them. When approval is
  pending, **Review in Codex** opens an interactive Codex CLI session in the
  user's terminal. The user approves the six OpenPets commands ending in
  `--openpets-managed` when Codex shows **Hooks need review**. When that screen
  reports exactly the six expected hooks, the UI directs the user to **Trust all
  and continue**; a different count sends them through **Review hooks** so only
  OpenPets-managed commands are approved. If Codex self-updates and exits first,
  the same terminal handoff detects the version change and restarts Codex instead
  of requiring another Review click. If the CLI is already open, `/hooks` opens
  the same review screen there; `/hooks` is not a command in the Codex desktop
  message composer. While the integration modal is open, OpenPets polls the
  read-only trust result, refocuses the Control Center, and changes to Connected
  as soon as approval completes. OpenPets reads the resulting `hooks.state`
  hashes but never writes them, because an installer must not approve its own
  command hooks. A current hook definition whose earlier approval hash is stale
  is classified as **Waiting for approval**, not **Needs repair**: rewriting the
  same hooks cannot repair user-owned trust and previously caused a repair loop.
- **Ownership and repair:** hooks are marker-owned and merged without replacing
  unrelated entries; MCP removal refuses foreign entries; writes are backed up
  and rolled back if verification fails. Install/Repair first verifies the new
  setup, then removes the exact legacy `openpets@personal` plugin registration,
  trust blocks, cache, and runtime data while preserving `~/.codex/pets/`.

Disconnect is one-step and idempotent: it removes only the current marker-owned
hooks and matching MCP entry, then returns to Ready with Connect and Refresh.
A late command timeout is treated as success only when a final doctor pass proves
both owned components are absent; foreign entries remain untouched and visible
as a conflict. The modal opens as soon as Connect starts, keeps status/actions,
approval, and the last event in one connection journey, and shows progress on
the active button (`Connecting…`, `Repairing…`, `Removing…`, or `Checking…`).
Technical command overrides are collapsed under Troubleshooting and are blank
by default; normal installations auto-detect Codex and use the runtime bundled
with the desktop app. Transparency paths use `~` for the user's home and
describe the managed entries without exposing the machine-specific packaged
runtime path. Internally, machine-readable Codex JSON remains unredacted until
ownership verification is complete; only renderer, log, and error-summary
boundaries redact paths and secrets. The Integrations card never chooses a
Companion conversation provider.

## MCP server — `@open-pets/mcp`

A standalone stdio MCP server (`open-pets-mcp`) for any MCP-capable agent. It
registers `openpets_status`, `openpets_react`, `openpets_say`, and
`openpets_show_media` with Zod-validated input and read-only/idempotent
annotations. Media requires an absolute supported local image path and remains
subject to the desktop IPC file/size checks.
On startup it acquires a lease, heartbeats every ~5s, and releases on
SIGINT/SIGTERM. Errors are sanitized so IPC paths/tokens/sockets never leak into
tool output. It is spawned by the CLI (`runMcp()`) which forwards stdio and
signals. `--pet <id>` targets a specific pet.

> **Window confinement requires an installed pet.** Passing `--pet <id>` only
> activates window confinement when the requested pet is actually installed. If
> the pet ID is misspelled or not yet installed, the MCP server silently falls
> back to the default (unconfined) pet. OpenPets now surfaces this via a desktop
> notification when the fallback occurs. To list installed pets run
> `openpets pets`; to install one use `openpets install <pet-id>` or the Pets
> tab in Control Center.

## OpenCode — `@open-pets/opencode`

Ships both a config manager and a runtime plugin.

- **Config** (`opencode-config.ts`, JSONC-aware): manages `mcp`, `instructions`,
  and `plugin` arrays in the effective OpenCode config (project `.opencode/` or
  global `~/.config/opencode/`), choosing the right file among `config.json` /
  `opencode.json` / `opencode.jsonc` and preserving user arrays. Managed
  instruction blocks use `<!-- OPENPETS:START/END -->` markers. Full
  prepare/write/remove/doctor lifecycle.
- **Runtime** (`opencode-plugin-runtime.ts`, plugin id `open-pets-opencode`):
  hooks `event`, `chat.message`, `tool.execute.before/after`, classifies them to
  reactions/speech, manages a lease (renew with a 2s buffer), and applies the
  same throttle windows as Claude.

## Cursor — `@open-pets/cursor`

Pure file management for Cursor, no runtime hooks (Cursor drives the pet via the
MCP server). It manages the `openpets` entry in `mcp.json` (global
`~/.cursor/mcp.json` or project `.cursor/mcp.json`) and optional project rules at
`.cursor/rules/openpets.mdc`. Strong safety posture: strict JSON only, size caps
(256 KiB config / 64 KiB rules), symlink rejection at every path level, atomic
writes with backup, recursive redaction of sensitive keys/values, and refusal of
unpinned versions (`@latest`). Rules ownership requires an exact
`OPENPETS:CURSOR_RULES:START/END` marker pair. The desktop uses preview/copy;
the CLI writes project rules.

## Pi — `@open-pets/pi`

A Pi coding-agent extension (declared in `pi.extensions`). It maps Pi lifecycle
events (`session_start`, `agent_start`, `turn_start`, …) to reactions and
registers a `/openpets` slash command namespace (`status`, `test`,
`react <reaction>`, `say <message>`). MVP scope is default-pet-only and
non-blocking; it registers **no** model-callable tools, and never forwards
prompt/assistant/tool/command text, paths, URLs, or secrets.

## Codex CLI as a Companion target

Companion Conversations can use Codex CLI to generate ordinary pet conversation,
but provider selection remains separate from the coding-agent connection above.
The Codex CLI option is always visible in AI Brain settings. A detected, supported
CLI can power conversation without requiring OpenPets reaction hooks or MCP to be
installed or trusted; those Integration components remain responsible only for
coding-agent reactions and explicit pet controls. Selecting Codex as the brain
does not install or modify hooks/MCP.

`CodexCompanionTarget` wraps the host's existing cancellable
`CodexConversationTarget`, probes `codex --version`, `codex exec --help`, and
resume support, and requires the structured `codex exec --json` contract. Each
pet has its own runtime session UUID; changing provider or cancelling a turn
aborts the child process. If a resumed session has gone stale, the orchestrator
retries the same bounded prompt once without that session.
Pet turns use Codex's official `--ignore-user-config` mode, disable plugins and
shell tooling, ignore user rules, and force a read-only sandbox. Login is still
shared, but the pet cannot inherit the user's MCP servers, plugin skills, coding
instructions, or write-capable agent environment. Every target also runs from a
dedicated empty, user-private temporary workspace instead of the user's home or
an active project, and removes that workspace when the target shuts down. Child
processes receive an allowlisted launch/login environment (home, path, locale,
temporary-directory, platform profile paths, and an existing `CODEX_HOME`), not
the desktop process's API keys, plugin tokens, MCP variables, or unrelated
secrets. When the selected Codex command is an absolute path, its containing
directory is prepended to that isolated PATH so packaged GUI launches can also
resolve the CLI's local `node` shebang interpreter. Image turns terminate the
CLI's variadic `--image` arguments before the prompt so Vision never mistakes
the prompt for another image filename or waits on closed stdin.

AI Brain model choices come from the installed CLI's official app-server
`model/list` response rather than a hand-maintained list or free-text field.
Model discovery uses the same allowlisted child environment as conversation
turns, including prepending an absolute Codex command's directory to `PATH`, so
an Applications-launched GUI can resolve Codex's `env node` shebang just as a
terminal launch can.
OpenPets preserves the CLI's default model option, constrains reasoning effort to
the selected model's advertised values, resolves catalog IDs to the executable
model name returned by Codex, and marks text-only models. When Codex is
the global brain, built-in Vision uses `codex exec --image` with an ephemeral,
read-only run and a securely deleted temporary screenshot; it does not pass
through Ollama or the direct API Brain gateway.

OpenPets constructs the prompt before Codex sees it from the selected pet's
personality, the explicit minimal user profile, local time/activity hints,
roughly 24 hours of pet-scoped recent memory, and separately consented plugin
facts. The host displays and records the response. Therefore switching between
Codex CLI and the app's Anthropic/OpenAI/Ollama-compatible host-AI target does
not switch personality, profile, memory, voice, plugin authority, or proactive
policy. Wake activation is also unrelated; it depends on explicit user consent
and a healthy validated local bundle. Microphone audio never goes to Codex CLI:
local wake detection identifies the phrase, the selected Listening provider
(recommended local Sherpa-ONNX or optional OpenAI Audio Transcriptions) converts
only the bounded command to text, and that text is sent to the selected Brain.

The isolation above is intentional even when the user's normal Codex setup has
MCP servers. A Companion turn does not inherit global MCP servers, rules,
plugins, shell access, or project credentials. Instead, an installed OpenPets
plugin can request the sensitive `companion:context` permission and, after the
separate host consent switches are enabled, contribute bounded expiring facts
or opportunities. Those host-mediated contributions are included for whichever
Brain is active, including Codex. A future Screenpipe plugin therefore supplies
approved screen context through that contract; installing Codex does not grant
Screenpipe or any other plugin blanket access to the user's full Codex toolchain.

## The CLI — `@open-pets/cli`

The user-facing front door (`openpets`), and the package that composes the
others. Commands:

| Command | Does |
|---------|------|
| `configure` | Configure Claude / OpenCode / Cursor for a project (atomic, safe-path) |
| `install <pet-id>` | Install a pet via the client |
| `status` | Print app/pet status JSON over IPC |
| `pets` | List installed pets |
| `react <reaction>` / `say <message>` | Drive the active pet |
| `mcp` | Launch the MCP stdio server |
| `hook` | Run a Claude Code lifecycle hook |
| `plugin validate <dir>` | Validate a plugin before install/release |
| `plugin new <name> --template <t>` | Scaffold an SDK v3 plugin |

The plugin subcommands are the author-side DX entry point — see
[plugins.md](plugins.md), [sdk.md](sdk.md), and [development.md](development.md).
The CLI enforces safe project paths and atomic config writes throughout.

## Quick orientation

| Agent | Config home | Runtime mechanism |
|-------|-------------|-------------------|
| Claude Code | `~/.claude/` (settings, MCP, `openpets.md`) | lifecycle hooks |
| Codex | `~/.codex/hooks.json` + global `openpets` MCP entry | lifecycle hooks + bundled MCP |
| MCP (generic) | agent's MCP config | stdio MCP tools |
| OpenCode | `.opencode/` or `~/.config/opencode/` | plugin event hooks |
| Cursor | `.cursor/mcp.json` + rules | MCP tools |
| Pi | `pi.extensions` | extension events + `/openpets` |
</content>
