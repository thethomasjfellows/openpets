# Desktop App

The desktop app (`apps/desktop/`) is the heart of OpenPets: the only long-lived
process, owner of all state, windows, the tray, pet rendering, the plugin
runtime, and the local IPC server that agents talk to. This doc explains its
process model, the major subsystems, and the rules that keep it secure and
stable. For the pet rendering specifics see [pets.md](pets.md); for the IPC wire
contract see [ipc.md](ipc.md); for plugins see [plugins.md](plugins.md).

Source map: `apps/desktop/codemap.md` and `apps/desktop/src/codemap.md` are the
authoritative file-by-file maps. This doc is the narrative on top of them.

## Process model

Electron gives us a **main process** and multiple **renderer processes**. In
OpenPets:

- The **main process** (`src/main.ts` and the modules it orchestrates) holds all
  authority: state, lifecycle, tray, windows, IPC, leases, catalog/install,
  plugins, i18n.
- **Renderers** are sandboxed and powerless by default. Each gets a *narrow*
  preload bridge exposing only the APIs it needs:
  - The **Control Center** renderer (the React/Tailwind UI) via
    `control-center-preload.cjs`.
  - **Pet windows** (transparent, frameless, always-on-top) via `pet-preload.cjs`.
  - **Plugin JS hosts** and **plugin panels** via `plugin-sdk-preload.cjs`.

There is **no default main window**. The app is tray-first: tray actions open
the singleton Control Center routed to a specific page. A single-instance lock
(`app.requestSingleInstanceLock()`) focuses the existing instance instead of
launching a second one.

## Startup sequence

`main.ts` runs a deterministic bootstrap (see `src/codemap.md` for the exact
order): install lifecycle handlers → initialize the logger → initialize app
state → initialize voice, Companion settings/memory, plugin-platform and host-AI
settings → install the internal UI protocol/handlers → create the tray → start
the local IPC server → create the host voice/Companion platform → initialize the
plugin service (with the Electron JS host) → optionally show the default pet.
Shutdown cancels microphone, proactive, provider, speech, and Companion work
before stopping the plugin service, IPC server, and pet windows.
Launching OpenPets again while its tray process is already running, or activating
it from macOS, opens/focuses the singleton Control Center instead of appearing to
do nothing.

Key files: `main.ts` (entry/bootstrap), `lifecycle.ts` (app events + cleanup),
`state.ts` (shell pause flag).

## Linux display backend (Ozone/Wayland)

On Linux, `main.ts` appends `--ozone-platform=x11` **before** `app` is ready, so
the app always runs under x11/XWayland. This is required because OpenPets pets
depend on programmatic top-level window positioning (`setPosition`/`setBounds`)
and z-order control (`setAlwaysOnTop`); native Wayland forbids clients from
positioning or restacking their own toplevels, which silently breaks motion,
gravity, walkabout, drag, and always-on-top stacking. The forcing is
unconditional (it overrides even an explicit `--ozone-platform=wayland`) so a
mistaken launch flag cannot disable pet movement.

The escape hatch is the environment variable `OPENPETS_ALLOW_WAYLAND=1`: when
set, the app honors the system default backend (or an explicit
`--ozone-platform`) and emits a one-time `warn("app", ...)` at startup (after the
startup-begin log) stating that positioning, gravity, walkabout, and drag are
unsupported under native Wayland and how to restore full functionality. The
pet-drag path keys off this same effective backend via
`isEffectiveWaylandBackend()` in `pet-window.ts`, which is evaluated at
window-creation time (after the switch is applied) and cached. The pure backend
decision (platform + `--ozone-platform` + `XDG_SESSION_TYPE`/`WAYLAND_DISPLAY`)
is factored into `computeEffectiveWaylandBackend()` in `wayland-backend.ts`;
`pet-window.ts` delegates to it and owns only the cache.

The x11-forcing branch and the `OPENPETS_ALLOW_WAYLAND` opt-out are asserted by
`check-packaging-contract.ts`, so this behavior cannot silently regress.

On Windows, the shell silently strips `HWND_TOPMOST` from other windows when an
app enters fullscreen (browser video, games) and never restores it — and no
Electron event fires when it happens, so the `show`/`restore` re-assertions
never run and the pet stays buried until manually toggled. Pet windows
therefore re-assert always-on-top on a 1s interval while visible (the
shell's demotion sweep re-strips the flag every ~2-4s while a fullscreen app
is foreground, so the cadence bounds the buried time to under a second),
dropping
Electron's cached always-on-top flag first — Electron short-circuits
`setAlwaysOnTop(true)` when its cached state already matches, so without the
cache-bust the re-assert never reaches the OS
(`createBasePetWindow` in `pet-window.ts`); the call is a cheap no-op while the
flag is intact, and keeping the pet above fullscreen content matches the
explicit macOS `visibleOnFullScreen: true` behavior.

Separately, Chromium's native window occlusion tracker considers every window
on a display occluded while a fullscreen app is active there and stops
painting it — a transparent pet window goes blank even with its z-order
intact. `main.ts` disables `CalculateNativeWinOcclusion` on Windows so the
pet keeps rendering during fullscreen video and games.

## Subsystems

### Tray & windows

- `tray.ts` builds the tray icon (`assets.ts` loads `assets/tray-icon.png`,
  keeps it as a full-color image, and falls back to a generated icon if the
  asset is missing) and the context menu,
  including update status and route-targeted Control Center entries and a "open
  logs" action.
- `windows.ts` is the Control Center coordinator: it creates the hardened
  `BrowserWindow`, loads the Vite renderer (dev) or packaged `dist/renderer`
  (prod), targets a route, registers all renderer-facing IPC handlers, builds
  the Dashboard snapshot, and defines the internal asset protocols.
  Route requests can carry `{ route, petId, section, notice }`; a pet's
  **Talk to this pet** menu item opens `route: "pets"`, selects that installed
  pet, and focuses its `section: "companion"` composer. Invalid/uninstalled pets
  resolve to a bounded `pet-unavailable` notice instead of an arbitrary route.
- `display.ts` provides screen-geometry helpers for positioning pet windows,
  including the permissive `clampToNearestDisplayIfOffscreen` helper that allows
  pets to roam across display seams while only snapping when fully off-screen.

### Control Center (renderer)

The React/Tailwind UI under `src/renderer/`. Pages: **Dashboard, Pets,
Integrations, Plugins, Settings**. It is a pure consumer of main-process
snapshots and actions exposed over the preload bridge — it holds no privileged
capability of its own. The renderer is the only "frontend" in scope for these
docs (the `web/` marketing site is out of scope). See
`src/renderer/src/codemap.md` for component structure.

The default-pet detail owns `PetCompanionPanel`, which edits only that pet's
seven-field character profile. Settings owns the shared **Memory** page for the
user profile, rolling-memory controls, clearing, and the single Off/Rarely/
Sometimes/Often proactive selector. AI Brain owns provider selection; plugin
context consent stays on each plugin's enable/permission surface.
Typed chat and push-to-talk are not exposed. Other installed pets do not receive
Companion controls. The Control Center never calls a provider directly and
never receives credentials, raw microphone audio, or the persisted
recent-memory file.

### Pet windows

Pet rendering lives in `pet-window.ts` plus the two controllers
(`default-pet-controller.ts`, `agent-pet-controller.ts`) and the motion/mapping
helpers. This is covered in depth in [pets.md](pets.md).
The shared motion ticker validates signed 32-bit integer coordinates before
calling Electron's native `setPosition` boundary. A destroyed window or native
conversion failure unregisters only that pet's motion state, so a bad display
transition cannot escape the timer as a main-process exception.

Pet windows also own the presentation endpoints for the host-level voice
platform. When **Read speech bubbles aloud** is enabled in Settings, a newly
presented plain-text transient bubble enters `VoiceOutputService`, which resolves
the global provider/voice selection. System Voice uses renderer
`speechSynthesis`; PocketTTS, OpenAI-compatible TTS, and ElevenLabs return
bounded audio to a separate voice-only playback element. Interruption, queueing,
and cancellation never stop the existing plugin-audio channel. Narration is
default-off, best-effort, quiet-hours aware, and deduplicated per pet window.
Automatic intermediate task reactions (thinking, working, editing, testing,
and waiting) remain visual-only so long-running agents do not repeatedly speak
progress filler; terminal success/error reactions and explicit pet messages
remain audible. The visual bubble remains authoritative.

Wake conversation feedback uses that same pet bubble instead of a detached
host overlay: a local wake hit shows **Listening** with a red activity pulse and
an inset upper-right close control with reserved header and message space, endpointing replaces
it with a compact blue **Thinking** state, and actual TTS playback shows
**Speaking** with a yellow activity pulse, the same close control, and a
playback-driven progressive caption. System Voice uses
native word-boundary events when available; audio providers reveal a
punctuation-weighted word sequence against the media element's real playback
position. Completion leaves the full answer visible, while cancellation removes
stale partial text. The working animation loops through provider generation and
TTS synthesis rather than ending after one sprite cycle. Conversation response
text is modestly larger than status, plugin, and listening bubbles. The wake
turn also holds a short-lived presentation lease from detection through spoken
output completion. Default-pet reactions arriving from coding-agent IPC remain
recorded but cannot replace the listening, working, or response bubble until
that lease ends. After spoken output and the Companion turn both complete, the
default-on follow-up preference immediately reopens that listening state for
five seconds without displaying a countdown; the completed response remains
below its red **Listening** header during that window. Speech onset clears the
short no-speech timer; local frame energy provides the same transition when the
runtime misses its speech-start VAD event, so an accepted second turn cannot be
cut off by the no-speech timer. Conversational endpointing tolerates natural
pauses and keeps the turn open for up to 30 seconds. Silence before speech clears the bubble and returns to
ordinary keyword detection. The bubble close control and the global **Control +
backtick** shortcut cancel listening,
transcription, provider generation, or speech without consuming Escape in the
user's dictation app. A follow-up finalized while the prior turn promise is still
settling is queued once rather than discarded.
Codex automatic reactions have a separate persisted three-stage policy in the
Codex integration card: task start, while working, and task finished. Only task
finished is enabled by default. The lifecycle event remains available for
integration health and diagnostics even when its visible reaction is disabled;
intentional Codex MCP pet controls are unaffected.
Persistent wake capture keeps browser echo/noise suppression disabled so a
distant phrase is not classified away as background sound; the native local
helper applies conservative, capped gain only to quiet frames before KWS/VAD.
Before provider synthesis, numeric clock times are converted to speakable words
(for example, `10:57` becomes “ten fifty-seven”) while the visible Companion
answer remains unchanged.

Control Center → Settings → Speaking stores non-secret configuration in
`openpets-voice-settings.json`. API keys are stored through the encrypted host
secrets store and IPC exposes only boolean key status. `PocketTtsService` is an
explicit on-demand model/service manager: **Download & Enable** runs the pinned
first-party package through `uvx`, binds only to `http://127.0.0.1:8000`, warms
the selected built-in voice, records the completed install, and starts it
offline on later launches. It never downloads merely because Settings opened.
The UI owns install/start/stop progress, a built-in voice selector, and read-only
advanced service details. The adapter sends multipart `text` and `voice_url` to
`POST /tts`. Provider responses are MIME-checked, streamed through a 10 MiB cap,
and never expose credentials or raw provider payloads to renderers.

Plugin `voice:listen` uses the same bounded mono 16 kHz WAV transcription input and is separate from
Companion listening consent. `VoiceCaptureService` remains the single microphone
authority for both that plugin path and the persistent local wake PCM bridge, so
they cannot own tracks concurrently. Companion command transcription is
endpointed finite-WAV recognition, not partial/streaming recognition, so the
Listening bubble does not claim to display live transcript text. Ambient local
wake PCM relies on the OS
microphone indicator and never opens the custom overlay. The privacy-indicator
window appears only for a bounded post-wake request or one-shot plugin capture
and is cleared on endpoint, cancellation, error, stop, or power teardown. Optional Codex
conversation uses `codex exec --json` and session UUID resume events—not terminal
scraping—and owns cancellable child processes per pet session. Because the full
request is passed as an argument, OpenPets closes the child's stdin immediately;
otherwise Codex waits for additional prompt input until the provider timeout. Companion and
Vision invocations use Codex's official user-config isolation, disable plugins
and shell tooling, ignore rules, and force a read-only sandbox while preserving
the user's Codex login. They run from a dedicated empty `0700` temporary
workspace—not the user's home or current project—and remove it at shutdown.

Settings exposes separate left-navigation surfaces so each pipeline stays short
and diagnosable:

- **Listen** defaults to the fixed official **Hey Pedra** classifier and explains that persistent wake detection
  is local-only—not ambient recording, persistence, transcription, or cloud
  streaming. The persistent-listening switch stays directly below the live
  Listen status so an OS permission grant cannot be mistaken for enabling the
  feature. Returning from macOS System Settings refreshes permission and pipeline
  readiness immediately. Listening can be enabled only when the target-specific runtime bundle,
  macOS microphone permission, and the selected finite transcription provider
  are ready. Built-in local transcription is recommended and keyless: the user
  explicitly downloads a pinned, checksum-verified Sherpa-ONNX Whisper tiny.en
  model, which is stored under `userData/local-stt/` and then runs offline in a
  separate one-shot helper process. Ambient wake audio remains KWS/VAD-only and
  is never passed through that transcription model. OpenAI Audio Transcriptions remains an
  optional provider with editable endpoint/model settings; transcription can
  also be turned off. Codex is not an audio decoder: it receives the resulting
  text only when Codex is selected as the global AI Brain. The page reports microphone capture, helper connection, recent PCM
  frames, transcription, and Companion completion independently; only recent
  live PCM can produce a green **Listening** state. Companion enablement and
  wake-phrase changes resynchronize the live capture automatically. The system
  microphone indicator stays visible while listening. Plugin one-shot listening
  temporarily releases persistent wake capture and re-arms it afterward.
  Official wake sensitivity is a small preset selector backed by evaluated
  classifier thresholds; new installs default to **Easy** (`0.16`) so ordinary,
  farther-away, and fan-noise speech does not require shouting. It is not
  microphone-volume gain. The classifier is
  phrase-specific, so official setup never claims to learn the user's voice or
  save transcript alternatives. An explicitly labeled experimental custom-
  phrase mode retains the guided **Improve wake phrase recognition** card while it
  captures ten bounded samples per repeatable batch. Those samples are transcribed only by
  the installed local Whisper helper over an in-memory stdin pipe, never
  written to disk, and never
  routed through the selected cloud transcription or AI provider. Only
  deduplicated text mishearings are saved with the phrase. The review shows the
  batch interpretations and how many recordings the current local wake detector
  recognized. Users can record more batches and delete individual visible
  interpretations; OpenPets retains and activates up to fifteen through the
  bounded helper protocol. This is text interpretation setup, not acoustic voice
  enrollment, and the source recordings are discarded after transcription.
  Listening also offers a microphone selector with System Default as the safe
  default. A missing saved device falls back to System Default, and a compact
  live input meter helps users confirm normal speech is reaching the local
  detector without exposing technical audio measurements. A separate
  **Continue listening after replies** preference is enabled by default and can
  be turned off without disabling the wake phrase itself.
  Editing the phrase makes older setup inactive; resetting removes it. Downloading the local setup
  model does not change the user's normal transcription provider.
- **Speaking** owns the global provider, credentials, voice discovery, fallback,
  and per-provider speech-test controls. System voices are discovered on entry
  and presented as a dropdown. A System Voice test cannot accidentally
  exercise PocketTTS or a fallback provider. Spoken Companion turns suppress
  the matching bubble's ordinary auto-narration so one answer has one TTS owner.
- **Vision** is a separate default-off capability presented as a concise
  **Pet Vision** switch, one live Working/Setup needed status row, an optional
  model override that can use any verified image-capable model from configured
  AI Brain providers, and an **Open Storage
  Folder** action. **Check Vision** always performs a non-capturing
  screen/provider readiness probe, including while Vision is off or paused.
  Temporary 30/60/90-minute pause/resume controls remain in the tray menu so the
  settings page stays compact. On macOS the page offers Privacy & Security and
  restart actions only when the real capture probe reports permission denial. A
  successful nonempty `desktopCapturer` thumbnail is the only proof that capture
  is ready. Successful enumeration without a usable thumbnail is unavailable,
  not permission-denied, and an inconclusive real probe overrides Electron's
  potentially stale synchronous TCC metadata. This prevents an already-enabled
  installation from repeatedly sending the user back to System Settings while
  still refusing to claim Vision works without a capturable image. Listening
  provides the parallel microphone flow, but an accepted microphone grant takes effect
  without forcing an unnecessary relaunch. Development
  builds are identified so users understand that macOS grants access to that
  exact app copy; packaged builds include `NSMicrophoneUsageDescription`.
  **Restart OpenPets** performs Electron's documented immediate-restart sequence:
  one guarded `app.relaunch()` followed by `app.exit(0)`. It preserves launch
  arguments and appends a diagnostic marker that is recorded by the replacement
  process at startup. Packaged macOS QA must confirm the process ID changes; a
  renderer-only or mocked relaunch check is not sufficient for this workflow.
- **AI Brain** owns one global conversation target. A compact top row combines
  the active-provider selector with that provider's ordinary conversation
  readiness; it chooses Codex CLI or one direct provider. Separate cards below
  retain the configuration for Codex, Anthropic, OpenAI, OpenRouter, Ollama, and a custom
  OpenAI-compatible endpoint at the same time; selecting a brain does not erase
  or hide the others. Each direct-provider card owns its model, endpoint where
  applicable, readiness check, and independently encrypted credential. A card
  can load that account or local server's current model catalog and then turns
  the model field into a dropdown, while retaining manual model IDs for services
  that do not expose a catalog. The
  Codex card links to Integrations when the managed Codex connection is not
  ready. When Codex is selected it
  discovers the live model catalog through `codex app-server` `model/list`,
  exposes only each model's supported reasoning efforts, and marks image-capable
  models. Persisted catalog IDs are resolved back to Codex's executable model
  names before a turn. Codex never routes through the direct-provider fields.
  Readiness is shown as **AI Brain Ready/Needs Attention** for ordinary
  conversation plus a separate, non-blocking Pet Vision Ready/Not
  available/Needs attention result. Checking a provider evaluates both paths,
  but a Vision limitation never disables a working conversational brain. The
  Vision result links directly to Pet Vision settings.

Vision is host-owned rather than a plugin. `vision-service.ts` captures every
connected monitor after a 30-second enable delay and then roughly every 20–25
minutes while the default pet is visible and unpaused. It stops capture while disabled,
paused, suspended, locked, or while the default pet is hidden/paused. The
service rechecks the same pet ID, visibility, and pause state before capture,
after capture, and before persistence so an in-flight eligibility change cannot
retain or summarize late screenshots. All monitor images from a cycle share a
capture-group ID. Each image is labeled as the primary monitor or a numbered
secondary monitor and retains the display ID and bounds needed for future
screen-targeted companion behavior. The
Electron adapter checks OS screen-capture permission and encodes a bounded
1280×800 JPEG for each image input. `VisionAiRouter` sends each screenshot to the selected
global AI Brain: Codex receives it through the official CLI image input, while
the direct API target uses Anthropic, OpenAI, OpenRouter, Ollama, or a custom
OpenAI-compatible image input. Both receive an instruction to produce a richer
2–4 bullet summary of the app/window, likely activity, and distinct
non-sensitive regions with rough positions, without quoting or transcribing
visible text or exposing sensitive details. Health uses a synthetic magenta image and requires the model to identify its color, so a text-
only model that ignores image input cannot report Vision-ready. Changing the
AI target, model, reasoning effort, or key invalidates Vision health so an image
that passed one provider's probe cannot be sent to an unprobed replacement. A summary is
  saved only after non-empty image summarization succeeds; neither screenshots,
  paths, nor summary text cross the renderer IPC boundary. A multi-monitor cycle is
  retained as one group; if any monitor fails to persist, the incomplete group is
  rolled back so later conversations never inspect only part of that capture.

Pet Vision may store an optional model override independently from the active
conversation brain. The selector combines Codex image-capable models with
direct-provider models that report image input in their AI Brain catalogs; a
previously verified configured model remains selectable even when its catalog
does not expose modality metadata. The selected provider's existing endpoint
and credentials are reused. **Use active AI Brain default** removes the override.

Screenshots and summaries live under `userData/openpets-vision/` and are pruned
on startup, reads, and a periodic timer. Vision-owned atomic index temp files
are also removed on startup, pruning, and disable so a crash cannot extend
summary retention. Retention is at most 24 hours and is
also capped at 192 entries, 1 MiB per screenshot, 48 MiB of screenshots, 900
characters per summary, and a 512 KiB index. Pause retains existing context
until normal expiry but suppresses new capture and proactive Vision candidates.
Only summaries from roughly the last 30 minutes may create a Vision-aware
check-in through the existing global check-in cadence; Vision does not add a
second frequency control. Check-in prompts prohibit repeating private details.
Disabling aborts work and deletes retained screenshots and summaries; the UI
reports an error instead of claiming deletion if the store cannot confirm it.
A failed index write likewise remains an error and does not advance the last
retained-summary timestamp.
Ordinary Companion turns receive summary text plus its non-sensitive monitor
label, but never display IDs, bounds, image paths, or bytes. When the user's
message deterministically asks about the screen, screenshot, monitor, desktop,
or a visibly referenced app/object, the orchestrator asks the active Companion
AI Brain to inspect each image in the newest retained capture group. Those
  per-monitor observations are bounded and included only in that turn's final
  text prompt; raw image bytes and paths never enter renderer IPC, the text prompt,
  or durable memory. Raw bytes are sent only after that exact target configuration
  has already passed image-readiness verification. Disabling Vision changes its
  access generation, aborting any remaining monitor inspections and the pending
  answer. The orchestrator fingerprints the active target, provider,
model, endpoint, credential, and Codex reasoning choice; a change before,
during, or after inspection cancels the turn before another monitor or final
response can use mixed provider state. Inspection failure falls back to retained
summaries instead of breaking the conversation. Proactive turns remain summary-only. Direct and
proactive prompts label all Vision context as untrusted observations that can
never supply instructions. Vision-driven proactive candidates still pass the
same quiet-hours, activity, provider-health, daily cap, spacing, expiry, and
dedupe policy as every other check-in. Every
proactive result revalidates that the same default pet is still visible and
unpaused immediately before display. Vision candidates additionally revalidate
their source opportunity, so pausing, disabling, or expiring Vision during
provider generation suppresses the late result.
Screenpipe remains an optional plugin direction and is not part of built-in Vision.

`voice-wake-types.ts`, `voice-wake-helper-protocol.ts`,
`voice-wake-helper-wire.ts`, and `voice-wake-activation.ts` define the bounded
helper, NDJSON/f32le PCM, and activation contracts. `voice-audio.ts` finalizes a
valid post-wake utterance as bounded mono PCM WAV. `voice-wake-runtime.ts` and
`voice-wake-word-service.ts` define the injected runtime/capture boundary and the
host-owned coordinator. The official runtime composes a local LiveKit
phrase-specific classifier (the only source of `keyword` events) with the
existing Sherpa helper in VAD-only mode. Sherpa remains the local Whisper engine
and an explicit experimental custom-phrase KWS path; it is never a second
official wake detector. `voice-wake-livekit-manifest.ts` and
`voice-wake-livekit-runtime.ts` validate and run the isolated Rust classifier
helper, while `voice-wake-sherpa-manifest.ts` and
`voice-wake-sherpa-runtime.ts` retain the reviewed Sherpa bundle lifecycle.
The Rust classifier keeps stdin ingestion separate from model inference. Before
each prediction its bounded worker queue drains to the newest PCM window, so a
slow prediction cannot make microphone audio accumulate seconds behind realtime.
Keyword events include the newest source-frame timestamp plus detector window
and stride metadata; host diagnostics report transport delay separately from
phrase-end recognition latency.
Protocol v2 configures a custom primary phrase plus
up to fifteen locally learned text variants; unsupported optional variants are
skipped while an unsupported primary phrase remains a recoverable setup error.
The helper uses recall-oriented English KWS boost/threshold tuning without
transcribing ambient speech. An accepted wake hit immediately sets the pet's visible listening state and
arms the following separate utterance; the tail of the wake phrase is never
included in command transcription. The acknowledgement and privacy overlay are
cleared on endpoint, output, timeout, stop, and failure. The initial no-command
guard is cleared as soon as command speech starts, so it cannot truncate a long
request; the separate bounded utterance cap remains authoritative. Reaching the maximum utterance duration finalizes or rejects
the bounded WAV even if the helper never emits a VAD endpoint. The coordinator
invokes the existing finite transcription and Companion path once per bounded utterance,
requires voice output activity as a readiness dependency, stops feeding PCM to
the detector during thinking, pet output, and cooldown so the pet cannot hear its
own reply as a wake attempt, and tracks lock and suspend as
independent blockers so resume cannot re-arm before unlock. Startup is
single-flight; stopping fully resets output suppression so re-arming after a
stop-during-speech cannot remain muted. Generation and abort guards prevent late capture,
transcription, or Companion completions from overwriting stopped or suspended
state. Reset failures and invalid/oversized finalized WAV input are converted into
the same bounded runtime-error teardown rather than escaping event or timer
callbacks. Generation checks on runtime-error, settings, stop, and power teardown
prevent any older async cleanup from overwriting a newer re-armed, stopped, or
suspended lifecycle state. Renderer-facing wake reasons defensively
redact paths, URLs, and token-like values. Behavior tests exercise that path with fake capture/runtime
adapters.

`voice-wake-calibration-service.ts` and `voice-wake-calibration-collector.ts`
own the experimental custom-phrase ten-sample setup lifecycle, pre-roll, VAD-bounded audio, visible
interpretation normalization/deletion, current-detector recognition count,
support checks, and wake suspension/resume.
`voice-capture-core.ts` now implements the future `VoiceWakeCaptureSource` while
`voice-capture.ts` remains the Electron security adapter. A fresh hidden,
sandboxed renderer loads the deny-by-default `voice-capture.html` from a local
file origin so Chromium exposes `mediaDevices`, plus `voice-capture-preload.cjs`;
its AudioWorklet mixes and
resamples microphone input to exact 20/30 ms mono 16 kHz f32 frames. Bounded
plugin listening uses the same worklet to produce a finite PCM16 WAV rather
than a provider-specific browser recording container. The preload
and main process both validate bounded payloads, and main additionally binds each
frame to the expected renderer sender, generation, and random session token.
Renderer buffering is capped at three droppable frames; main fans out current
frames without persistence, transcription, network access, or an unbounded
queue. An allowlisted preload event also reports track/device loss, a prolonged
mute, stream inactivity, a closed audio context, or worklet failure to the same
session teardown path. A saved microphone that leaves acquisition pending gets
a short bounded attempt before capture retries once with System Default, so a
stale or temporarily unavailable device cannot leave wake listening disabled.
Stop, shutdown, abort during pending microphone
acquisition, acquisition failure, and renderer loss all clear the partition and
balance the privacy indicator exactly once.

The LiveKit boundary requires an exact **Hey Pedra** classifier ID, evaluated
sensitivity thresholds, reproducible training provenance, release-floor recall
and false-positive metrics, regular non-symlink files, byte lengths, SHA-256
checksums, and legal notices. Missing classifier or provenance data is a hard
packaging failure; no transcript or substring fallback exists. Native
positive-audio and negative/silence smoke runs remain required release evidence
for every packaged target and must use fixtures that are independent of the
synthetic training set.

The Sherpa boundary validates manifest v2 provenance, explicit runtime/KWS/VAD
asset roles, normalized relative paths, regular non-symlink files, exact byte
lengths, streaming SHA-256 checksums, legal-file presence, the selected platform
helper/libraries, and executable rules before spawn. It then performs a
versioned ready handshake, bounded stdout/stderr parsing, safe logging, PCM
drop-on-backpressure, drain/timeout recovery, and idempotent abort/stop/crash
teardown. In official mode the helper owns VAD only; KWS remains available only
for the explicitly selected experimental custom-phrase path. OpenPets retains microphone permission,
in-memory lifecycle, post-keyword transcription, Companion dispatch, and output
suppression. Idle PCM goes only to local KWS/VAD and is never included in the
finite audio sent for transcription.

`voice-transcription-router.ts` keeps finite speech recognition independent of
the AI Brain. The local path in `voice-local-transcription.ts` validates every
downloaded model file by immutable URL, byte length, and SHA-256 before an
atomic install, validates the packaged Sherpa helper before each run, writes a
bounded temporary WAV, accepts only bounded JSON output, and removes the WAV in
all completion paths. The OpenAI path is used only when explicitly selected.

Production availability is derived from the actual packaged target bundle, not
a global compile-time flag. electron-builder receives only the validator-selected
files from `wake-helper/package-resource/` and the separately validated LiveKit
bundle from `livekit-wake-helper/package-resource/`. Missing, wrong-target, damaged, or
incomplete resources report a bounded unavailable reason and never receive the
capture/transcription/output dependencies needed to arm. The pinned build,
manifest/provenance, staging, and release instructions live in the corresponding
`apps/desktop/wake-helper/` and `apps/desktop/livekit-wake-helper/` directories.

### Companion conversations

`voice-platform.ts` owns the shared Companion runtime alongside voice output:
`CompanionOrchestrator`, the Codex and host-AI targets, future wake-transcript
handoff, and `CompanionProactiveService`. Runtime sessions are pet-scoped and
reset when the selected target changes;
an invalid resumed Codex session is retried once without the stale session.

Companion starts disabled with consent version `0`. The first enable writes one
atomic disclosed state: Companion enabled, recent memory enabled, and gentle
check-ins enabled at **Sometimes**. Later disable/re-enable cycles preserve the user's
independently reversible choices. Wake and Vision remain separate explicit
choices. A missing wake runtime, permission, or transcription model blocks live
capture with a diagnostic reason but preserves the user's explicit wake
preference so it can arm automatically after the dependency becomes ready.
Vision uses its own fresh `openpets-vision-settings.json` state and
does not migrate the former Companion screen placeholder, so stale settings
cannot silently grant microphone or screen consent.

Host-owned persistence is deliberately separate from installed-pet app state:

- `openpets-companion-settings.json` — consent, selected target, explicit user
  profile (name, preferred address, and freeform About You), per-installed-pet
  character overlays (visible name, species, origin, appearance, personality,
  quirks, and life story), plus memory/proactivity/wake choices. Version 2
  migrates old goals into About You and old personality text into the matching
  character overlay.
- `openpets-companion-memory.json` — rolling displayed conversation. Startup
  rewrites it after pruning malformed/expired/over-limit entries. Retention is
  24 hours, with global, per-pet, prompt-entry, text, and file-size bounds.
- `openpets-vision-settings.json` — dedicated default-off Vision consent, an
  optional bounded pause deadline, and an optional active-provider-only model
  preference.
- `openpets-vision/` — atomic Vision index plus bounded compressed JPEG screenshots and
  summaries, all on the rolling 24-hour retention cycle.
- `openpets-host-ai-settings.json` — versioned provider profiles plus the one
  active direct provider for Anthropic, OpenAI, OpenRouter, Ollama, and custom
  OpenAI-compatible completion, transcription, and image summary paths. On
  first launch after the split, a configured legacy `ai`
  block is migrated out
  of `openpets-plugin-platform.json` and removed from that file. The old
  plugin-platform settings API projects the host settings for compatibility but
  no longer creates a second source of truth. API keys use separate
  provider-scoped entries in the host secrets store; renderer IPC exposes only
  boolean key status. A former shared key is moved once into the active
  provider's credential slot without overwriting a newer provider-specific
  credential. The retired
  localhost Codex-via-Ollama bridge on port `18081` is forward-migrated to an
  unconfigured Direct API Brain, while ordinary Ollama endpoints remain intact.
- `openpets-pockettts-settings.json` — explicit managed-install marker, enabled
  state, pinned package version, and fixed loopback host/port. Package/model
  bytes remain in `uv`'s local cache rather than the settings file.
- `openpets-transcription-settings.json` — Listening provider choice (`local`,
  `openai`, or `none`) plus the optional OpenAI endpoint/model; its API key stays
  in the host secrets store.
- `local-stt/` — explicit local Whisper model install, integrity marker, and
  short-lived transcription jobs. Installed files are fully rehashed once per
  process and again whenever their filesystem signature changes.

`CompanionProactiveService` evaluates once after startup and then every five
minutes for the visible, unpaused default pet. It derives local day parts and
activity hints, can express morning/midday/evening/night posture without a
bubble, and considers host time prompts, eligible plugin
opportunities, and recent eligible Vision summaries. Quiet hours, an active
interaction, provider health, daily caps, per-plugin caps, dedupe, and minimum
spacing all suppress delivery. Rarely,
Sometimes, and Often currently cap host check-ins at 1/3/5 per local day with
minimum spacing of 6 hours/3 hours/90 minutes; these are ceilings, not schedules.

The main process logs bounded decisions under the `companion` and `vision`
scopes: settings changes, target/kind/input sizes, selected memory/fact counts,
capture stage, retained entry counts, cancellations, proactive suppression
reasons, and display/failure outcomes. It does not log prompts, responses,
character/profile fields, fact or Vision summary text, screenshots, paths,
credentials, endpoints, or raw audio.

### Local IPC server

`local-ipc.ts` runs a `net.Server` over a Unix socket / Windows named pipe /
TCP, routes a versioned JSON protocol, and writes a discovery file so clients
can find it. The lease manager (`lease-manager.ts`) sits behind it. Full
contract in [ipc.md](ipc.md).

**Pet fallback notification:** when an agent requests a specific pet via
`--pet <id>` and that pet is not installed (or is invalid/broken), the lease
manager silently falls back to the default pet and window confinement does not
activate. `pet-fallback-notify.ts` detects this condition and fires a native
macOS notification (once per unique pet ID) so the user knows why confinement
is inactive. The notification includes the command to use once the pet is
installed.

### App state

`app-state.ts` persists a versioned JSON document under
`userData/openpets-state.json` using atomic temp-write + rename. It holds
installed pets, the default-pet config, reaction→animation overrides, onboarding
state, locale preference, the pet pool preference (ordered pet list +
`petPoolEnabled` toggle), and display-roaming preferences (`petConfinementEnabled`,
`petCrossDisplayEnabled`). It also stores the default-off
`readSpeechBubblesAloud` accessibility preference. `app-state-core.ts` holds
pure helpers (scale options, onboarding and narration-preference normalization)
that are testable without Electron.

#### Pet pool preference

The **pet pool** is an ordered list of installed pets plus a master enable/disable
toggle (`petPoolEnabled`, default `true`), both configurable in Control Center →
Settings → General. When enabled, the lease manager uses the ordered list to
assign a distinct pet to each concurrent agent session that does not explicitly
request one via `--pet <id>`. Slot 1 is the primary/default pet; slot 2 onwards
are assigned to additional sessions in order. When all pool slots are taken,
further sessions receive a random eligible pet (installed, non-broken, not the
built-in default). Slots free up when their session ends. `--pet <id>` bypasses
the pool entirely. When disabled, all sessions without `--pet` share the single
default pet (legacy behavior). Pool assignment is pure lease logic and works on
all platforms.

**Toggle side-effects:** disabling the pool immediately despawns all active pool
pets (releases their leases, which closes their windows). Re-enabling respawns a
pool pet for every session whose client PID is still alive — those sessions
acquire new leases and their windows reopen. Sessions whose processes have already
terminated are skipped. This is handled by `dispatchPoolToggle` in `local-ipc.ts`,
wired from the `update-preferences` IPC handler in `windows.ts`.

**Session teardown:** a periodic liveness sweep (the `local-ipc.ts` cleanup timer
calling `lease-manager.ts`'s `checkPidLiveness`) releases an agent pet's lease —
and so closes its window — once the owning session is gone. It probes the
**terminal owner PID** (when known) as well as the client PID, so an orphaned but
still-running client can't keep a pet alive indefinitely. Expiring the 15s TTL is
the backstop; liveness is the prompt path.

See [agent-integrations.md](agent-integrations.md) for the
full behavioral description.

### Plugin subsystem

A large, self-contained subsystem (`plugin-*.ts`) covering manifests, state,
runtime, the sandboxed JS host, the permission-checked SDK bridge, catalog/local
install, assets, panels, diagnostics, and platform settings. Fully documented in
[plugins.md](plugins.md) and [sdk.md](sdk.md).

The plugin subsystem also owns **display deliveries**: a lazy, transparent,
host-owned surface used by `ctx.ui.delivery`. A delivery is rendered as a single
courier-and-banner surface on the cursor display, rather than as a spawned pet
or a plugin-controlled overlay. Each display advances a bounded FIFO queue;
expiry, dismissal, display removal, plugin reload/disable/uninstall, and app
shutdown are host lifecycle events. The host animates the declared courier strip
and owns its layout; plugins only supply a trusted sprite reference and text.

Calendar Airmail's configuration is a plugin-exclusive courier picker. It is an
accessible animated sprite grid whose selected/hovered/focused cards animate,
while reduced-motion users see a static first frame. It does not select, preview,
or validate installed pets; its bundled courier sprites remain available wherever
the plugin is installed.

### Agent setup

`agent-setup.ts` detects installed agents and runs configuration actions (MCP
add/replace/remove, hooks install/uninstall/doctor, memory file install),
delegating to the integration packages. Its Codex path resolves the packaged
`@open-pets/codex` hook adapter and `@open-pets/mcp` entry from ASAR-unpacked
resources, exposes one Connect/Repair/Disconnect lifecycle, and performs
replacement-first legacy migration. Codex command JSON is preserved internally
for exact ownership checks, while renderer snapshots format home paths as `~`
and omit packaged runtime locations. The modal keeps connection controls at the
top and places command overrides in a collapsed troubleshooting disclosure.
`claude-memory.ts` manages the Claude
instructions file. See [agent-integrations.md](agent-integrations.md).

### Catalog & installation

`catalog.ts` fetches the pet catalog (v3 paginated, with v2/fixture fallback);
`pet-installation.ts` downloads + validates + extracts pet ZIPs; `codex-pets.ts`
imports locally-developed pets. See [catalog.md](catalog.md) and [pets.md](pets.md).

### i18n

`src/i18n/` resolves the active locale and serves localized host UI text and pet
reaction speech, with English fallback. See [i18n.md](i18n.md).

### Updates

`update-checker.ts` polls GitHub releases and surfaces update status to the tray
and Dashboard; `update-version.ts` does version parsing/comparison.

### Logging

`logger.ts` provides scoped, structured logging (scopes: `app`, `ipc`, `lease`,
`pet.*`, `state`, `tray`, `ui`, `companion`) with log rotation (~2MB) and redaction of
sensitive data, written to `userData/logs/openpets.log`. Renderer diagnostics
should be routed here so failures are visible in the log file, not only DevTools
(see the logging guidance in `AGENTS.md`).

### Desktop analytics

The desktop app has a privacy-preserving PostHog analytics client in
`analytics.ts`. It runs from the main process only, posts to the self-hosted
OpenPets PostHog project, and is disabled in dev unless
`OPENPETS_ANALYTICS_DEBUG=1` is set. Users control capture in Settings with the
**Share privacy-preserving usage analytics** toggle. Remote analytics uses a
random local `distinctId`; local app state also keeps dashboard counters such as
message/reaction totals, per-pet activity counts, first-run/first-reaction
milestone timestamps, and the consent value.

Analytics events are intentionally product/health level: app startup, first run,
Control Center opens, pet catalog/install/customization flows, bounded
integration activity, IPC connection/lease health, plugin install/enable/command
usage, catalog/update reliability, and renderer/plugin runtime failures. Do not
send prompts, code, file paths, repo names, terminal commands, pet speech,
clipboard contents, plugin config values, local usernames, hostnames, raw stack
traces, or raw local pet/plugin/command identifiers. Add only bounded enum-style
properties such as platform, app version, locale, source, `integration_type`,
runtime, result, and safe error codes.

## Security model

This is non-negotiable surface area. The app handles remote content (catalogs,
ZIPs) and runs third-party plugin code, so it is defensive by construction:

- **Sandboxed renderers** with `contextIsolation`; capabilities reach them only
  through narrow `contextBridge` preload APIs.
- **Strict CSP**: `default-src 'none'`, inline styles only. Any new
  renderer-visible URL scheme, image source, dev endpoint, or internal protocol
  **must** be added to the CSP in *both* `apps/desktop/vite.config.ts` and
  `apps/desktop/src/renderer/index.html`. Common pet image protocols:
  `openpets-codex:`, `openpets-installed:`, `openpets-pet-preview:`, and
  `openpets-plugin-asset:`. Forgetting the CSP makes images fall back to the
  default pet even when install/render logic is correct. (This is a documented,
  easy-to-hit footgun in `AGENTS.md`.)
- **Mock keychain** to avoid OS credential prompts.
- **IPC network security**: TCP mode is restricted to loopback/private
  addresses; public IPs and hostnames are rejected. See [ipc.md](ipc.md).
- **Defensive I/O**: atomic writes everywhere; path-traversal and symlink checks
  on every filesystem boundary; strict ZIP entry validation (`zip-safety.ts`).
- **Plugin sandbox**: plugins run in hidden, session-partitioned BrowserWindows
  with navigation/window-open hardening and permission-gated SDK calls. See
  [plugins.md](plugins.md).

- **Trusted plugin assets**: `openpets-plugin-asset:` serves only an enabled,
  exact-version JavaScript plugin's declared sprite. The protocol accepts only a
  narrow sprite route, resolves it beneath the real install root, rechecks WebP
  dimensions against manifest frame metadata, and returns no filesystem paths to
  a renderer. Delivery documents have their own restrictive CSP and can load
  only this protocol (or data URLs).

## Packaging

`electron-builder.yml` configures cross-platform packaging (macOS/Windows/Linux)
with ASAR. Bundled mode unpacks the integration binaries from ASAR so hooks/MCP
can spawn them. `scripts/release-local.mjs` automates a macOS-local release with
a GitHub draft. See [development.md](development.md) for the release flow.

## Where to look first

| If you're touching… | Start in |
|---------------------|----------|
| Tray menu / Control Center routing | `tray.ts`, `windows.ts` |
| Pet appearance / animation | `pet-window.ts`, `reaction-animation-mapping.ts` ([pets.md](pets.md)) |
| Agent → pet command path | `local-ipc.ts`, `lease-manager.ts` ([ipc.md](ipc.md)) |
| Persisted settings | `app-state.ts` |
| Companion consent/profile/personality | `companion-settings.ts` |
| Companion prompt/memory/orchestration | `companion-context.ts`, `companion-memory.ts`, `companion-orchestrator.ts` |
| Companion targets/check-ins | `companion-target-*.ts`, `companion-proactive-service.ts`, `companion-proactivity.ts` |
| Host AI configuration/gateway | `host-ai-settings.ts`, `host-ai-gateway.ts` |
| Plugin behavior | `plugin-service.ts` + `plugin-*.ts` ([plugins.md](plugins.md)) |
| Agent configuration | `agent-setup.ts` ([agent-integrations.md](agent-integrations.md)) |
| Install / catalog | `catalog.ts`, `pet-installation.ts` ([catalog.md](catalog.md)) |
| Anything renderer-visible with a URL | also update the CSP (both files) |
</content>
