# Architecture

OpenPets is a pnpm + TypeScript monorepo for an Electron desktop companion app
and a set of npm packages that let coding agents drive animated desktop pets.
This doc is the one-page mental model: what runs where, how a request travels
end to end, and the vocabulary used throughout the rest of the docs.

## The product in one sentence

A small animated pet lives on your desktop and reacts to what your coding agent
is doing — thinking, editing, waiting for permission, succeeding, failing — and
can be extended with companion plugins, while pets themselves are downloadable
from a public catalog.

## Runtime topology

There are three runtime worlds. Keep them distinct in your head.

1. **The desktop app** (`apps/desktop/`) — an Electron process tree. The main
   process owns state, windows, the tray, the pet windows, the plugin runtime,
   and a **local IPC server**. This is the only long-lived process.
2. **Agent-side integrations** (`packages/*`) — short-lived code that runs
   inside or alongside a coding agent (Claude Code hooks, the MCP server,
   OpenCode plugin, Cursor config, Pi extension, the CLI). They translate agent
   activity into pet commands and send them over local IPC.
3. **The public web origin** (`openpets.dev`, source in `web/`) — static
   catalogs and asset hosting. The app fetches pet/plugin catalogs and downloads
   ZIPs from here. Only the *data* side of `web/` (catalogs, ZIP hosting, pet
   metadata) is in scope for these docs; the marketing site/frontend is not.

```
coding agent  ──(hook/MCP/plugin event)──▶  @open-pets/client
                                                  │  local IPC (socket/pipe/TCP)
                                                  ▼
                                         desktop app (main process)
                                          ├─ lease manager → pet windows
                                          ├─ app state (JSON)
                                          ├─ plugin runtime + SDK bridge
                                          └─ catalog/install
                                                  │  HTTPS
                                                  ▼
                                         openpets.dev (catalogs, ZIPs on R2)
```

## The packages, and what each is for

| Package | Role | Doc |
|---------|------|-----|
| `@open-pets/client` | The IPC client every integration uses to talk to the app | [ipc.md](ipc.md) |
| `@open-pets/cli` | User-facing CLI: configure agents, manage pets, run MCP, scaffold/validate plugins | [agent-integrations.md](agent-integrations.md), [development.md](development.md) |
| `@open-pets/mcp` | Stdio MCP server exposing status, reaction, speech, and local media tools to MCP agents | [agent-integrations.md](agent-integrations.md) |
| `@open-pets/claude` | Claude Code hooks + MCP/settings/memory management | [agent-integrations.md](agent-integrations.md) |
| `@open-pets/codex` | Codex detection, hook/MCP ownership, trust diagnosis, migration, and runtime adapter | [agent-integrations.md](agent-integrations.md) |
| `@open-pets/opencode` | OpenCode plugin runtime + config management | [agent-integrations.md](agent-integrations.md) |
| `@open-pets/cursor` | Cursor MCP config + project rules management | [agent-integrations.md](agent-integrations.md) |
| `@open-pets/pi` | Pi coding-agent extension + `/openpets` commands | [agent-integrations.md](agent-integrations.md) |
| `@open-pets/agent-events` | Shared, validated speech pools for agent feedback | [agent-integrations.md](agent-integrations.md) |
| `@open-pets/plugin-sdk` | Public SDK v3 type contract + deterministic test harness | [sdk.md](sdk.md) |
| `install-pet` | Standalone pet installer (works with or without the running app) | [pets.md](pets.md) |
| `pet-format` | Tiny marker/identity type for pet packages | — |

The dependency spine: every integration depends on `@open-pets/client`; the
`cli` composes `claude`, `opencode`, `cursor`, and `mcp`; `claude`/`opencode`/`pi`
depend on `agent-events` for safe speech.

## End-to-end flows

These are the flows worth holding in memory. Each links to the doc that details it.

- **Agent reaction → visible pet.** Agent activity is classified into a reaction
  category, sent via the client over IPC, the lease manager routes it to a pet
  window, and the window plays the mapped animation with localized speech.
  See [ipc.md](ipc.md) and [pets.md](pets.md).
- **Speech bubble → optional voice output.** After a plain-text transient bubble
  is actually presented, the pet-window layer may route that text through the
  host-owned voice platform when the user has enabled **Read speech bubbles
  aloud**. The platform resolves global provider and voice settings,
  applies voice/provider fallbacks, and uses a voice-only playback channel.
  Refreshes are deduplicated, quiet hours mute narration, and TTS failures never
  affect the visual bubble.
- **Companion turn → pet response.** A wake-confirmed bounded transcript enters
  the main-process `CompanionOrchestrator`. When the user enables Listen, the
  host validates the target-specific local Sherpa bundle before it can arm the
  shared microphone capture. It builds bounded context from the default pet's
  seven-field character profile, the explicit About You profile, local time/activity hints, recent
  pet-scoped memory, and consented
  plugin facts. The selected target is either a cancellable Codex CLI session or
  the configured host-AI provider. Only a response actually displayed in the
  pet bubble is recorded; optional speech uses the same voice-output service.
  Changing targets does not change the pet's personality or OpenPets memory.
    Post-wake transcription is a separate finite local-Whisper or optional OpenAI
    request configured under Listening even when Codex is the conversation target;
    it is not routed through Ollama or the direct API Brain settings. Ambient
    wake listening remains KWS/VAD-only; only the following bounded command is
    transcribed and reaches Codex.
- **Proactive opportunity → restrained check-in.** A host-owned scheduler
  evaluates time-of-day, consented plugin opportunities, and recent
  opt-in Vision summaries for the visible, unpaused default pet. Quiet hours,
  active listening/thinking/speech, dedupe, daily caps, and the
  Rarely/Sometimes/Often spacing policy can suppress
  any candidate. Plugins contribute expiring facts or opportunities only; the
  host decides whether to act and the selected provider writes original pet
  wording. The same time state can produce a once-per-day-part reaction hint
  without creating a spoken check-in. Fast wake detection runs in a native KWS/VAD
  helper behind a validated target manifest and bounded NDJSON protocol. Ambient
  audio stays local and in memory before activation. After a spoken answer, an
  optional five-second follow-up window accepts one new utterance without the
  wake phrase; silence returns the pet to ordinary wake detection.
- **Installing a pet.** The app fetches catalog v3 (paginated, with a v2/fixture
  fallback), downloads the pet ZIP from `zip.openpets.dev`, validates and
  extracts it, and records it in app state. See [catalog.md](catalog.md) and
  [pets.md](pets.md).
- **Running a plugin.** The plugin service loads an approved manifest (catalog
  or local), the runtime starts a sandboxed JS host, and the SDK bridge applies
  permission-checked calls to pet/schedule/storage/UI/etc. See [plugins.md](plugins.md)
  and [sdk.md](sdk.md).
- **Configuring an agent.** The CLI or Control Center detects the agent, writes
  MCP config + hooks/rules atomically, and installs a memory/instructions file.
  See [agent-integrations.md](agent-integrations.md).
- **Publishing content.** Pets and plugins are packaged into versioned catalogs
  and ZIPs, validated, and uploaded to R2 behind `openpets.dev`. See
  [catalog.md](catalog.md) and [testing-and-validation.md](testing-and-validation.md).

## Companion capability boundary

The conversational pet is a **companion with awareness and bounded everyday
utilities**, not a general-purpose agent or a voice frontend for Codex. Selecting
Codex as the AI Brain uses Codex to generate the pet's response; it does not
grant that pet-owned session the user's Codex skills, MCP servers, plugins,
shell, repository, rules, or arbitrary API access. This isolation is a product
boundary, not a temporary missing feature.

The boundary keeps the pet's responsibilities coherent:

- **Conversation:** a coherent per-pet character profile, explicit About You profile, recent pet-scoped memory,
  and natural spoken interaction.
- **Awareness:** local time/activity plus separately consented Vision and plugin
  context, always supplied as bounded untrusted observations.
- **Utilities:** small, domain-specific capabilities supplied by installed
  OpenPets plugins with declared permissions, validated inputs, and narrow
  results that the pet can explain in its own voice.
- **Proactivity:** restrained host-approved check-ins based on consented context
  and expiring plugin opportunities.

Serious coding, research, shell, repository, and open-ended agent work remains
in the user's normal Codex or other agent session. Agent integrations continue
to flow **from the agent into OpenPets** for pet controls and lifecycle
reactions; they do not make Companion conversations a route back into the
agent's tools. This separation prevents pet personality and concise-conversation
instructions from conflicting with operational agent instructions, and avoids
turning wake phrases, proactive check-ins, Vision, or false activations into
unbounded tool execution.

Calendar lookup, reminders, hydration, focus, and similar everyday actions
belong in narrowly scoped plugins rather than general MCP/tool access. The
plugin owns authentication, permissions, validation, and side effects; OpenPets
owns intent routing, consent, presentation, and final companion-style wording.
The current SDK supports plugin commands and context contributions. A future
spoken-intent/action contract must preserve this bounded model rather than
exposing arbitrary plugin, MCP, or provider tools to the conversation model.

## Cross-cutting invariants

These hold everywhere; the rest of the docs assume them.

- **Forward-only product direction.** Move the current app forward. Do not keep
  legacy compat code in current runtime paths. Old released apps must not break
  catastrophically on versioned data, but the current app carries no legacy
  bloat. (From `AGENTS.md`.)
- **Catalog v3 is the source of truth** for pets; catalog v2 is legacy/fallback
  only. Plugin catalog v2 is active; v1 is an empty compatibility shim.
- **Validate at every boundary.** Catalog entries, ZIP contents, pet metadata,
  IPC params, and plugin manifests are all strictly validated before use.
- **Atomic, safe I/O.** All persisted state uses temp-write + rename; all path
  handling rejects traversal and symlink escapes.
- **Least privilege.** Renderers are sandboxed with narrow preload bridges and a
  strict CSP; the hidden wake-capture renderer may emit only session-bound,
  exact-size PCM frames through its dedicated preload; plugins run in a
  permission-gated sandbox; IPC over TCP is restricted to private/loopback
  addresses. Pet-owned Codex turns ignore user configuration/rules, disable
  plugins and shell tooling, use a read-only sandbox, and start in an empty
  user-private temporary workspace rather than the home directory or a project.
- **Companion is not an agent gateway.** Pet-owned conversations never inherit
  the user's Codex skills, MCP servers, plugins, shell, project rules, or
  repository context. Bounded everyday actions belong to permission-checked
  OpenPets plugins; serious agent work stays in the agent application.
- **Companion data is consented and layered.** Core settings, the saved character profile,
  explicit profile fields, and roughly 24 hours of recent conversation are
  OpenPets-owned. Plugin context requires an enabled plugin with approved
  `companion:context`; disabling that plugin stops its contributions without a
  duplicate global switch. Vision and wake listening remain separate gates.
  Vision starts off, occasionally captures every connected display only after
  explicit consent, sends each image to the selected AI Brain (official Codex
  image input or a direct API provider) for a bounded privacy-safe summary, and
  retains both locally for no more than 24 hours. Ordinary conversation uses
  those summaries. Only an explicit screen-dependent user turn inspects the
  newest complete retained multi-monitor capture group through an AI Brain whose
  current configuration has passed image readiness; the resulting observations
  are transient and image bytes and paths never enter
  conversation memory or renderer IPC. All Vision context is untrusted
  observation data, never instructions. Wake listening remains explicit,
  local-only, and unavailable
  when its packaged bundle fails validation.
- **Providers do not own identity.** Codex CLI and host AI receive the same
  bounded host-built context. They do not own the character profile, user profile,
  recent-memory retention, plugin consent, or proactive-delivery policy.

## Glossary

- **Default pet** — the always-on pet shown when enabled; persistent, not
  lease-bound.
- **Agent pet** — a pet shown on explicit agent request, routed by a lease and
  closed when the last lease for it is released.
- **Lease** — a short-lived (15s TTL) claim with heartbeat renewal that routes
  agent commands to a specific pet and governs agent-pet visibility. See
  [ipc.md](ipc.md).
- **Reaction** — a categorical pet state (e.g. thinking, editing, waiting,
  success, error) that maps to a sprite animation and a speech pool. See
  [pets.md](pets.md).
- **Reaction → animation mapping** — user-configurable table from reaction types
  to sprite animation states.
- **Spritesheet** — the `spritesheet.webp` grid of frames a pet animates from.
- **Codex pet** — a locally-developed pet imported from `~/.codex/pets/`.
- **Control Center** — the React/Tailwind renderer UI (Dashboard, Pets,
  Integrations, Plugins, Settings) opened from the tray.
- **SDK v3 / manifestVersion 3** — the current plugin contract. See [sdk.md](sdk.md)
  and [plugins.md](plugins.md).
- **SuperPlugins** — the companion-first plugin product direction. See
  [superplugins.md](superplugins.md).
- **Companion Conversations** — the opt-in host feature that gives the default
  pet a personality, future wake-driven conversation, bounded recent memory,
  and restrained check-ins. It is distinct from coding-agent reactions.
- **Host AI** — the app-owned direct API conversation target with persistent
  profiles for Anthropic, OpenAI, OpenRouter, Ollama, and a custom
  OpenAI-compatible endpoint. One profile is active globally, but every
  profile's model, endpoint, and independently encrypted credential remain
  available when another brain is selected. Vision uses it only when that
  target is selected; Codex Vision and OpenAI speech recognition have separate
  host-owned paths. Settings and credentials remain host-owned.
- **Vision** — the default-off host ability that occasionally screenshots each
  connected display, labels every image by monitor, creates provider-backed
  privacy-safe context summaries, retains the images and summaries locally on a
  rolling 24-hour cycle, and can be paused or disabled independently of
  Companion and plugins. Explicit screen-dependent turns may inspect the newest
  retained capture group for that turn only; routine conversation remains
  summary-only.
- **Companion contribution** — an expiring plugin-supplied fact or proactive
  opportunity. It is untrusted context, never final pet wording, provider
  selection, speech authority, or core memory.
- **Catalog** — a versioned JSON index of installable pets or plugins served
  from `openpets.dev`. See [catalog.md](catalog.md).
</content>
</invoke>
