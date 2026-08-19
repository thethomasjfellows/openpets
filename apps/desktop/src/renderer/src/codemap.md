# apps/desktop/src/renderer/src/

## Responsibility

React/Tailwind source for the Control Center management UI. This renderer presents dashboard status, pet management, coding-agent integrations, plugin management, and settings using narrow preload APIs backed by `windows.ts` IPC handlers and desktop services.

## Design

- **Route Shell**: In-renderer route state supports `dashboard`, `pets`, `integrations`, `plugins`, and `settings`; tray actions retarget the singleton window through route-change events.
- **Dashboard**: Reads a narrowed dashboard snapshot for default pet preview, install/catalog counts, plugin health, update status, and activity totals.
- **Pets**: Combines installed pets, catalog v3 pages/search, Codex imports, filters, detail panes, set-default/install/import/remove actions, and animated sprite previews.
- **Integrations**: Card-first setup UI for Claude Code, Codex, OpenCode, Cursor, and Pi guidance, including Codex's guided one-window hook review, automatic trust polling, one combined capabilities section with three-stage automatic reaction controls (start/working/completed) plus intentional pet commands, command mode/path controls, and preview/action flows.
- **Plugins**: Gallery-first plugin hub for installed/catalog/local/broken filters, catalog refresh, local load, install/update/uninstall, enable/disable, config modal, command execution, runtime/status display, and broken-state feedback.
- **Settings**: Startup, launch-at-login, optional speech-bubble narration, pet scale, reaction-animation mapping, update check, default-pet position reset, and pet reaction previews. AI Brain uses one top-level active-brain selector plus always-visible Codex, Anthropic, OpenAI, OpenRouter, Ollama, and custom provider cards whose saved models, endpoints, credentials, and readiness are independent; cards load provider model catalogs into dropdowns while retaining manual IDs, and Codex models and supported reasoning efforts are discovered rather than typed. Listen owns wake phrase, default-on five-second post-response follow-up listening, selectable microphone with System Default fallback, a plain-language live input meter, up to fifteen visible text alternatives, local pipeline health, speech recognition, and macOS microphone permission. Speak owns TTS providers and auto-discovers System Voice choices into a dropdown. Vision uses one opt-in switch, one compact live status/action row, an optional cross-provider image-capable model override, concise rolling-24-hour compressed storage disclosure, and 30/60/90-minute pause/resume controls. A successful capture probe overrides stale macOS screen-permission reporting.
- **Bridge Contract**: All data and actions go through `window.openPetsControlCenter`; page snapshots intentionally omit raw install paths and unrelated app state.

## Key Files

- `main.tsx`: Single-file React app containing type definitions, route shell, page components, icons, snapshot loading, and action handlers.
- `styles.css`: Tailwind base/components/utilities plus glass-card layout, navigation, galleries, modals, status pills, previews, and notifications.
- `vite-env.d.ts`: Vite/TypeScript renderer environment declarations.
