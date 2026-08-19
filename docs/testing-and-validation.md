# Testing, Verification & Production Validity

OpenPets ships an Electron app, npm packages, third-party-runnable plugin code,
and remotely-hosted catalogs — so "does it pass tests" is necessary but not
sufficient. This doc lays out the full quality ladder: unit/behavior tests,
**contract tests** at public boundaries, runtime checks, the **plugin release
validators**, and **catalog verification** — i.e. what "production-valid" means
before you ship pets, plugins, packages, or the app.

## The quality ladder

From fastest/narrowest to broadest:

1. **Behavior tests** — unit tests of pure logic.
2. **Contract tests** — validate public boundaries (IPC, catalog, manifest)
   against fixtures so producers and consumers can't drift apart.
3. **Runtime checks** (`check-*.ts`) — assertions about packaging, CSP, SDK
   conformance, and integration previews that run as part of `check`/`test`.
4. **Release validators** — the gates that catch *production-breaking* mistakes
   the test suite alone misses (catalog/package drift, missing ZIPs, SHA
   mismatches, unresolved `$t:`).
5. **Live validation** — post-deploy checks against the real origin.

Run the suite with `pnpm test` (builds first, then each package's tests) and
`pnpm check` (per-package typecheck + build + contract checks). See
[development.md](development.md) for the command surface.

## Desktop tests

The desktop runner (`apps/desktop/scripts/run-tests.mjs`) orchestrates:
preload syntax checks → test compilation → behavior tests → contract tests →
dist checks. Test compilation refreshes the production main-process `dist/`
before compiling `.test-dist/`, so runtime checks never consume stale output.
Desktop contracts use tracked desktop/repository inputs only; an optional
ignored website checkout is outside this suite's boundary. Three buckets:

- **Behavior** (`apps/desktop/tests/*.test.ts`): lease manager, app state,
  version checking, ZIP safety, Codex pets, Claude memory, reaction-animation
  mapping, voice settings/target resolution, bounded provider responses,
  plugin-to-pet speech targeting, Codex JSON session parsing, Companion
  consent/settings normalization, 24-hour memory pruning/bounds, safe context
  construction, time/proactivity decisions, shared orchestrator behavior,
  host-AI settings/migration/abortable probes, expiring plugin contributions,
  single-owner WebM/PCM microphone arbitration, capture sender/token/frame
  validation, preload forwarding, AudioWorklet resampling/framing at 44.1/48 kHz,
  device-loss/privacy/crash/shutdown teardown, runtime-derived wake availability,
  bounded native-helper protocol v2 (primary phrase plus learned variants) and
  f32le wire encoding, LiveKit official-classifier manifest integrity and
  composition (only LiveKit emits official keyword events; only Sherpa emits
  official VAD events), Sherpa manifest v2
  role/provenance/path/size/checksum/executable and exact-single-target validation,
  helper ready/event/process lifecycle, recoverable unsupported-phrase retry, and
  backpressure behavior, finite PCM-to-WAV encoding, pure post-keyword
  activation policy (including long silence rejection, continuous
  wake-plus-command speech, and maximum-duration finalization without a VAD
  endpoint), and the injected wake coordinator's no-speech, one-turn, live
  settings resynchronization, required output-suppression,
  single-flight startup, stale-async, reset/WAV failure isolation,
  renderer-facing reason redaction, stale error/
  settings/stop/suspend teardown ordering (including overlapping resume), cooldown,
  power, and teardown behavior, plus experimental custom-phrase calibration pre-roll,
  silence rejection, local-only transcription, text-only deduplication, reset,
  and ambient-wake resume.
  Compiled to `.test-dist/`.
- **Contract** (`apps/desktop/contracts/*.contract.ts`): the public boundaries —
  - `catalog-fixture.contract.ts` — catalog validation against fixture data.
  - `local-ipc-protocol.contract.ts` — IPC request/response parsing
    ([ipc.md](ipc.md)).
  - `plugin-manifest.contract.ts` — manifest v1 schema, config refs, permissions,
    deferred features, action validation ([plugins.md](plugins.md)).
- **Runtime checks** (`apps/desktop/src/check-*.ts`): notably
  - `check-packaging-contract.ts` — asserts the packaged app includes bundled
    official plugins, preload/font resources, and the target-specific wake
    resource mapping. Packaged-output mode locates
    both `resources/voice-wake/livekit` and
    `resources/voice-wake/sherpa-onnx` and runs the matching manifest
    path/role/provenance/size/checksum/platform validation used before spawn.
    This is the guard that a *packaged* build is actually shippable.
  - `check-opencode-desktop-setup.ts` — verifies the bundled OpenCode setup
    preview matches expectations.

For voice-platform changes, run the desktop test and typecheck plus a manual
Control Center smoke test. Verify Settings → Abilities presents Listen, Speak,
and Vision without typed chat or push-to-talk; verify System Voice
discovery/test, the configured
PocketTTS loopback service, secret boolean status, per-pet fallback behavior,
voice-only cancellation, and the microphone indicator's exact track lifetime.
For progressive conversation captions, confirm the working bubble remains until
audible playback begins, words advance during both System Voice and an audio
provider, the full response remains at completion, and cancellation leaves no
stale partial response.
For wake-capture changes, also verify that disabling Listen or changing the
wake sensitivity updates the armed runtime without restart, a failed enable does not
leave the saved switch on, post-keyword silence is never transcribed, a
completed spoken turn re-arms for the next wake phrase without feeding the pet's
own reply back into keyword detection, a
lock → suspend → resume sequence stays blocked until unlock, plugin
WebM/wake PCM mutual exclusion, 20/30 ms exact framing, stale/wrong-sender frame
rejection, bounded renderer
queueing, renderer/device-loss notification, abort during pending microphone
acquisition, preload packaging, and idempotent cleanup.
The release-candidate microphone check is twenty wake attempts: ten at a normal
speaking position and ten combining fan noise with a farther speaking position.
Record detection and acknowledgement delay for every attempt; do not count a
late queued detection as an immediate success.
For experimental custom-phrase calibration changes, verify that setup pauses ambient listening, accepts
the configured bounded sample batch, never calls the configured cloud
transcription path, persists no audio or temporary paths, stores at most fifteen
deduplicated text variants, skips unsupported optional variants, and resumes
ambient listening after save or cancel.
For LiveKit/Sherpa host changes, additionally run both manifest and process-runtime tests
and verify ready-handshake blocking, event bounds, PCM little-endian encoding,
drop-on-backpressure, abort, graceful stop, forced cleanup, and safe crash/error
reporting. Run the Sherpa prepare/smoke commands and the LiveKit prepare command
on the target OS, then build main and stage both bundles; this proves the real
helpers/models and compiled production validators agree. Sherpa's smoke run
writes evidence bound to the exact target manifest and helper hashes; preparing
again invalidates it, and staging fails if it is missing, stale, or was produced
from different helper build inputs than the current checkout. A LiveKit release
additionally requires independent positive utterances and negative/silence
fixtures to be exercised on the native target before shipping; classifier
training metrics are not a substitute for that release QA. `package:dir` is locked to the current
host/architecture and must pass packaged-output validation. The release workflow
also validates the target-specific wake resources produced after every
`electron-builder` run. Windows and Linux release bundles require their own
native smoke results; a passing macOS fixture is not cross-platform evidence.

Codex conversation health must verify the installed CLI's `--json` exec/resume
contract. Runtime availability alone does not replace microphone/privacy,
one-turn, packaging, signing/notarization, platform smoke, and empirical
false-accept/false-reject QA.

For Companion changes, the observable contracts to protect are:

- the first consent action enables memory + Sometimes proactivity atomically but
  leaves plugin, sensitive context, Vision, and wake listening off until the
  user makes those separate choices;
- pet personalities remain pet-specific while profile/provider choices are
  host-owned and provider-independent;
- future wake transcripts enter the existing context, bubble display,
  cancellation, memory, target-health, and speech path; assistant memory is
  written only after successful display;
- memory is pruned at 24 hours and obeys entry/per-pet/file/prompt bounds;
- proactive decisions honor quiet hours, current activity, readiness, daily and
  per-plugin caps, spacing, expiry, and dedupe; provider results revalidate the
  same visible, unpaused default pet immediately before display; time expression
  does not create a conversation;
- plugin facts/opportunities require permission plus host consent, expire, stay
  process-local, cannot override the active default companion target, and never bypass host
  wording/delivery authority; and
- host-AI provider settings migrate once from the legacy plugin-platform `ai`
  field, credentials stay opaque, and abort cancels completion/transcription/
  health work.

Run `pnpm --filter @open-pets/desktop test` and its typecheck, then manually open
the default pet. Verify disclosure defaults, personality/profile edits, Codex
and configured host-AI health, provider-switch cancellation, memory clear, the
absence of typed/PTT controls, local Listen health/enablement, and disabled
Vision truthfulness. Settings →
Abilities should explain local-only wake behavior and 24-hour Vision retention
without presenting Sherpa/KWS/VAD jargon as user choices.

For Vision changes, test the dedicated settings/store/service boundaries and
host-AI image payloads for OpenAI-compatible and Anthropic providers. Protect
these observable contracts: fresh default-off consent with no migration from
the old screen placeholder; no capture while disabled, paused, power-blocked,
or the default pet is hidden/paused, including changes during async capture;
screenshot and summary expiry at 24 hours plus count/byte/text bounds,
duplicate-ID rejection, and crash-leftover index-temp cleanup; pause retains
until expiry; disable deletes data;
an empty image result, failed index write, or text-only model that ignores the
synthetic visual probe never reports success; changing provider/model/key
aborts any screenshot that was already in flight; pausing/disabling Vision while a
proactive result is generating prevents the late result from displaying;
renderer snapshots never expose screenshots, file names, paths other than the
disclosed storage directory, or summary text; Vision summaries are labeled as
untrusted quoted observations rather than instructions before direct or
proactive prompts; and Vision proactive candidates still obey the shared
quiet/activity/readiness/cadence/dedupe policy. Manually
verify the OS screen permission result, a real configured-provider capture and
summary, the displayed storage location/disclaimer, tray and default-pet
30/60/90-minute pause/resume actions, expiry, and delete-on-disable.
Diagnostics should show bounded `companion`/`vision` decisions and plugin quota
counts, never prompts, responses, profile text, fact or Vision summary text,
screenshots, credentials, endpoints, or raw-audio payloads.

## Package tests & contracts

Each package runs its own `check`/`test`. Notable contract/boundary coverage:

- `packages/client/contracts/client-protocol.contract.ts` — the client side of
  the IPC protocol, paired with the desktop's server-side contract so both ends
  validate the same shapes.
- `packages/sdk/src/check-plugin-sdk.ts` — **SDK conformance**: compiles/runs a
  representative plugin against the test harness to detect drift between the
  published types (`index.ts`), the harness (`testing.ts`), and the desktop
  bridge. Changing the SDK without updating all three fails here. See [sdk.md](sdk.md).
- `packages/cursor/src/check-cursor.ts`, `packages/opencode` checks, etc. —
  validate the safe config-write behavior (status classification, redaction,
  symlink/oversize rejection, atomic writes, uninstall preserving user entries).
  See [agent-integrations.md](agent-integrations.md).

## Plugin testing

- **Unit**: each official plugin has a `test.js` using
  `@open-pets/plugin-sdk/testing` — fake time/events, descriptor-level
  assertions, no Electron. Run via `pnpm plugins:test`, which first runs
  `pnpm plugins:locales` (`scripts/check-plugin-locales.mjs`) to verify every
  `$t:`/`ctx.t()` key resolves. See [sdk.md](sdk.md).
- **Package producer**: `pnpm plugins:package:test` protects fixed UTF-8 ZIP
  ordering, CRC/central-directory parsing, desktop-manifest parity, traversal +
  Windows-path rejection, source/output symlink rejection, and exact
  community-sidecar/digest coverage. It also covers catalog parity limits and
  legacy ASCII ZIP names without the UTF-8 flag. Root `.gitattributes` fixes
  plugin text to LF and WebP to binary so checkout settings do not perturb
  hashes. `pnpm plugins:check` runs those tests before a no-write package-plan
  build.
- **Manifest validation**: `openpets plugin validate <dir>` checks manifest,
  permissions, SDK compatibility, config field types, network hosts, asset
  formats/size caps, entry files, and panels — run it before packaging.

- **Companion contribution contract**: run
  `pnpm --filter @open-pets/plugin-sdk check` and the desktop bridge/contribution
  tests when changing `ctx.companion` or `companion:context`. The harness records
  contributed/removed facts and opportunities; Focus Buddy's test verifies a
  delayed low-urgency focus opportunity and removal/reconciliation behavior.

- **Calendar Airmail**: its deterministic harness coverage should exercise the
  primary-calendar reconciliation, state-appropriate connection commands,
  ten-minute and start deliveries, duplicate suppression, selected/default
  couriers, and reconnect-required cleanup. Run its plugin test alongside
  `pnpm plugins:locales`,
  `pnpm plugins:test`, and `pnpm --filter @open-pets/plugin-sdk check` when
  changing its SDK-facing behavior.
- **Delivery/picker boundary**: desktop bridge tests cover `ui:delivery`
  permission and lifecycle semantics; manifest validation covers declared
  sprite-grid options and asset references. For an Electron end-to-end smoke run,
  verify that the Airmail settings grid loads each bundled courier, keyboard and
  pointer selection persist, reduced motion is static, and a test delivery uses
  the selected courier without requiring any installed pet.

## Plugin release validation (production gate)

`plugins:check` alone is **not** release-readiness. The dedicated validators are
the production gate (`scripts/validate-plugin-release.mjs`):

| Command | When | Catches |
|---------|------|---------|
| `pnpm plugins:package` | build artifacts | (produces catalog + ZIP staging) |
| `pnpm plugins:validate-release` | **before deploy** | unresolved `$t:` names/descriptions in catalog cards, missing plugin ZIPs, SHA mismatches, strict ZIP EOCD/central/header/CRC failures, desktop-incompatible manifests, missing `locales/en.json`, missing declared assets/entry files (including courier sprites), catalog/package drift, and **community plugin sidecar + reviewed-tree digest validation** (`provenance.json`, `submissions.json`) |
| `pnpm plugins:validate-live` | **after deploy/R2 upload** | the same, against the live catalog + live ZIPs & live sidecars |

### Plugin sidecar validation

The release validator automatically loads `web/public/plugins/provenance.json`
and `web/public/plugins/submissions.json` and asserts:
1. Every community plugin mapped in the catalog has a matching provenance entry.
2. All provenance entries contain valid URLs, commit SHAs (40 hex characters), reviewed tree SHA-256 digests, and formatted dates.
3. Update policy is strictly limited to either `safe-auto` or `manual-review`.
4. Pending submissions are well-formed and are not also present in the installable catalog.

Before those generated copies exist, `scripts/sync-plugins.mjs` validates the
tracked sources under `plugins/community/` more narrowly: provenance keys must
exactly cover the current community folders (no missing or stale extras), fields
and GitHub owner/repository relationships are validated, and pending submissions
cannot overlap. The digest is the enforced reviewed content boundary: the
validator recomputes it from every current source file, so any byte change
requires manual review and all three review fields to be refreshed. Offline
validation does not fetch or cryptographically bind `sourceCommit`; reviewers
are responsible for comparing that upstream snapshot before approving the new
digest.

The full pre-ship sequence (from `AGENTS.md`):
`pnpm plugins:package` → `pnpm plugins:validate-release` → deploy/upload →
`pnpm plugins:validate-live`. Treat a failing validator as a hard stop — these
are exactly the mistakes that 404 a plugin or render a raw `$t:...` to users.
For the full plugin catalog release path in one command, run
`pnpm plugins:release`; it packages, validates, publishes ZIPs, deploys the web
catalog, then validates the live catalog.

## Catalog verification (production gate for pets)

Pet catalogs have a parallel "doctor" run from `web/` (read-only; safe anytime).
Detailed in `web/docs/pet_publishing.md`; the gate in brief:

| Command | Adds |
|---------|------|
| `bun run verify:catalog` | manifest integrity, artifact freshness vs manifest, on-disk assets, orphan dirs |
| `bun run verify:catalog:remote` | HEAD-checks every ZIP on R2 — catches "not installable" pets |
| `bun run verify:catalog:prod` | diffs local vs the deployed prod catalog (pending/removed) |
| `bun run verify:catalog:all` | all of the above |

The non-negotiable rule: **never ship a catalog entry whose ZIP isn't live on
R2.** Run `verify:catalog:remote` before deploying and `verify:catalog:prod`
after to confirm the deploy landed. See [catalog.md](catalog.md).

## What "production-valid" means

Before shipping, the relevant gate must be green:

- **A package change** → `pnpm check` + `pnpm test` (incl. contract + conformance
  checks) pass.
- **An app change** → desktop behavior + contract + runtime checks pass; if it
  touches packaging/CSP/bundled plugins, `check-packaging-contract.ts` passes.
  A delivery, trusted-asset protocol, or sprite-picker change additionally needs
  the desktop bridge/static checks and the targeted Electron smoke above.
- **A plugin release** → `validate-release` before deploy, `validate-live` after.
- **A pet catalog change** → `verify:catalog:remote` before, `verify:catalog:prod`
  after.
- **Linux-specific behavior** → validated on the Ubuntu VM
  ([development.md](development.md)).

If a gate is skipped, say so explicitly rather than implying coverage. Contract
and validator failures are signal, not noise — they encode the ways this product
has broken in production before.
</content>
