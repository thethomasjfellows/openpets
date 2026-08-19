# Investigation: Pet Abilities Stack

> Status (2026-07-19): the wake recommendation was implemented with a native
> Sherpa KWS/Silero VAD helper, pinned target bundles, manifest v2 validation,
> real-model smoke tests, and target-specific packaging. Statements below about
> the then-current missing helper/package gate are retained as investigation
> history; the maintained behavior is documented in `docs/desktop.md` and
> `apps/desktop/wake-helper/`. The earlier pre-roll recommendation is also
> superseded: pre-keyword PCM is not included in provider transcription.
>
> Status (2026-07-19, Vision): the Vision separation recommendation is now
> implemented as a fresh default-off host service with occasional screenshots,
> provider-backed summaries, rolling 24-hour local retention, pause/resume, and
> shared Companion policy gates. Later statements that Vision is unavailable or
> captures nothing are retained only as implementation-history snapshots.

## Summary

Re-evaluate the complete voice, AI, speech-output, and vision stack for OpenPets, with particular attention to whether persistent microphone listening is the right product and systems design and where Sherpa-ONNX should sit.

## Symptoms

- The prior direction selected Sherpa-ONNX, but its exact responsibility and process boundary remain unclear.
- The current push-to-talk capture path is one-shot WebM recording, while wake-word detection requires a continuous audio-frame path.
- The desired product is voice-first, requires a wake phrase for every user turn, supports restrained proactive speech, and adds a single Vision capability with rolling 24-hour screenshot memory.
- It is not yet established whether persistent microphone capture is necessary, safest, or operationally preferable to session-based alternatives.

## Background / Prior Research

- A true application-owned hands-free wake phrase requires some component to keep receiving microphone audio. The strongest privacy/control shape is persistent local PCM capture into a small acoustic keyword detector; push-to-talk, shortcuts, and clicks are the only genuinely nonpersistent alternatives, and they are not hands-free. OS continuous speech recognition still listens continuously and varies materially by platform, packaging, language, and possible cloud use. Always-on cloud Realtime audio would transmit non-wake ambient audio and is not a wake-word detector. Primary sources: [Electron permissions](https://www.electronjs.org/docs/latest/api/session), [Electron power lifecycle](https://www.electronjs.org/docs/latest/api/power-monitor/), [Apple live recognition](https://developer.apple.com/documentation/speech/sfspeechaudiobufferrecognitionrequest), [Windows continuous recognition](https://learn.microsoft.com/en-us/windows/apps/develop/input/enable-continuous-dictation), [OpenAI Realtime](https://platform.openai.com/docs/api-reference/realtime).
- sherpa-onnx KWS consumes mono floating-point PCM, with the official microphone example resampling to 16 kHz and feeding `acceptWaveform()` before `isReady()`/`decode()`. It supports runtime-configurable open-vocabulary phrases within the selected model's token vocabulary; phrases use the exact model package's `tokens.txt` and BPE model and do not require retraining. KWS and Silero VAD are independent objects exported by the same native runtime and can coexist in one helper process, but they do not share model/session state. Primary sources: [official microphone example](https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/test_keyword_spotter_transducer_microphone.js), [KWS docs/model list](https://k2-fsa.github.io/sherpa/onnx/kws/index.html), [C API](https://k2-fsa.github.io/sherpa/onnx/c-api/html/index.html), [VAD docs](https://k2-fsa.github.io/sherpa/onnx/vad/index.html).
- A thin C/C++ helper using sherpa-onnx's stable C ABI avoids Electron native-addon ABI coupling and isolates native/ONNX crashes. Current project artifacts cover macOS arm64/x64, Windows x64, Linux x64/arm64. Framework code is Apache-2.0, Silero VAD is MIT, and every KWS/VAD model archive still requires its own license, provenance, notice, checksum, and redistribution audit. Primary sources: [repository/platform matrix](https://github.com/k2-fsa/sherpa-onnx), [Node packaging](https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/README.md), [releases/checksums](https://github.com/k2-fsa/sherpa-onnx/releases).
- For a bounded post-wake utterance, OpenAI's finite `/v1/audio/transcriptions` request is a simpler fit than maintaining a Realtime transcription session; Realtime is useful only if live transcript deltas become a requirement. Occasional screenshots can be sent inline to an image-capable model via the Responses API rather than persisted through the Files API. Text responses can continue through OpenPets' provider-neutral TTS boundary. Primary sources: [speech-to-text](https://developers.openai.com/api/docs/guides/speech-to-text), [Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription), [vision inputs](https://developers.openai.com/api/docs/guides/images-vision), [text-to-speech](https://developers.openai.com/api/docs/guides/text-to-speech), [API data controls](https://developers.openai.com/api/docs/guides/your-data#default-usage-policies-by-endpoint).

## Investigator Findings

### Decision

**Use persistent local capture.** A truly hands-free, customizable wake phrase before every turn requires OpenPets to keep a microphone stream locally available. This is **not** persistent transcription, recording, storage, or cloud streaming: while armed, mono PCM is processed only in memory by local KWS/VAD; no transcription request is made until a wake-confirmed, endpointed utterance exists, and ambient PCM/pre-roll is never written to disk or sent off-device.

Evolve the existing hidden capture renderer into the **single persistent AudioWorklet microphone source**; do not add a second capture owner. `VoiceCaptureService` already owns Electron media permissions, the hidden sandboxed `BrowserWindow`, the live-track privacy indicator, exclusivity, bounded capture, teardown, and shutdown (`voice-capture.ts`). Today it creates a fresh partition/window, calls `getUserMedia`, records WebM with `MediaRecorder`, then destroys everything per request. A second native/helper mic path would create competing permission, device, indicator, PTT/plugin, recovery, and shutdown authorities. Instead, keep one long-lived sandboxed capture surface while wake is consented/enabled; let PTT and plugin `voice:listen` become finite logical consumers of that stream. The existing plugin microphone switch remains a separate default-off permission for plugin one-shots, not authorization for Companion wake.

### Ownership and state machines

Use one main-process coordinator (`VoiceWakeWordService`) with three explicit owners:

- **Capture renderer / AudioWorklet:** owns only `MediaStreamTrack`, `AudioContext`, channel mixing/resampling, and emission of fixed-duration PCM frames. It does not decide wake, retain audio, transcribe, or call AI.
- **`VoiceCaptureService`:** sole microphone arbiter; owns permission/session/window lifecycle, privacy indicator, device events, normalized mono PCM distribution, and a bounded in-memory pre-roll ring. On KWS confirmation it returns an atomic pre-roll snapshot; otherwise frames are overwritten and never persisted.
- **`VoiceWakeWordService`:** owns consent/health, helper process, KWS/VAD policy, the locked post-wake utterance buffer, timers/backoff, and transitions into the existing listening/transcription path. It clears buffers on completion, cancellation, suspend, device/helper/capture failure, settings disable, and shutdown.

Model capture and turn state separately so persistent capture is not confused with an active conversation:

1. **Capture:** `disabled → starting-capture → starting-helper → armed`. From any live state, settings/Companion disable or quit gives `stopping → disabled`; OS suspend gives `suspended`; track/device loss gives `recovering-device`; renderer loss gives `recovering-capture`; helper exit/protocol failure gives `recovering-helper`. Recovery uses bounded exponential backoff and returns to `starting-*`; after the retry budget, stop the mic/indicator and expose `error` until a settings change or explicit retry.
2. **Turn:** `idle → activated → collecting → endpointing → transcribing → thinking → speaking → cooldown → idle`.
   - In `armed/idle`, every frame goes only to sherpa KWS/VAD and the RAM pre-roll ring.
   - A validated KWS hit freezes roughly 0.5–1.5 seconds of pre-roll, plays `voice-wake`/start cue, and enters `collecting`. Minimum speech, trailing-silence, and maximum-duration bounds must be explicit; reuse the current hard 30-second ceiling. Too-short/no-speech input is discarded without transcription.
   - VAD end locks the utterance, plays the stop cue, and invokes the authoritative `VoiceTranscriptionService`. If PCM is finalized as WAV rather than WebM, broaden `VoiceCaptureResult`/the upload filename without moving transcription responsibility: `HostAiGateway.transcribe()` remains the finite OpenAI-compatible `/audio/transcriptions` boundary.
   - The transcript enters `CompanionOrchestrator.sendUserTurn({ kind: "voice", speak: true })`, preserving provider health, cancellation generations, display-gated assistant memory, personality/profile/plugin facts, and 24-hour recent memory.
   - `VoiceOutputService` remains the sole TTS/playback and overlap authority. It should expose read-only start/stop activity (covering conversation, bubble narration, plugins, and tests) to the wake coordinator; KWS acceptance is suppressed around OpenPets cues and for a short post-output cooldown so the pet cannot wake itself.
   - **Barge-in:** a wake hit validated during output cancels through the existing authoritative calls already used by PTT—`CompanionOrchestrator.cancel(petId)` and `VoiceOutputService.cancel({ kind: "installed-pet", petId })`—then starts `collecting` from fresh pre-roll. Request echo cancellation in the Chromium capture path and require stronger KWS/VAD corroboration during playback. If a platform/device cannot make self-trigger rejection reliable, disable wake barge-in during TTS and re-arm after cooldown rather than risk loops; PTT/click barge-in still works.
   - Proactivity must treat activation, collection, endpointing, transcription, thinking, speaking, and recovery as interaction-active. This extends the existing `CompanionProactiveService` rule that already suppresses during `VoiceListeningSnapshot` starting/listening/stopping/transcribing and orchestrator thinking/speaking.

Lifecycle details are currently missing for persistent capture: `main.ts` only resynchronizes plugin schedules on `powerMonitor.resume`, and `lifecycle.ts` calls a synchronous `shutdownVoicePlatform()` that starts asynchronous listening cleanup without awaiting it. On suspend/lock, stop tracks/worklet/helper, clear PCM, and turn the indicator off; on resume/unlock, reacquire the current/default device only after permission and consent rechecks. Handle `track.onended`, device changes, `AudioContext` failure, hidden-renderer `render-process-gone`/unresponsive, and helper exit. Renderer loss must drop the indicator and restart both capture and helper; helper loss may keep the mic only for a short bounded restart window, but must clear decoder/pre-roll state and stop capture if readiness is not restored. Quit must await wake/helper/capture teardown before privacy/output/provider disposal and remain within the existing two-second hard-exit fallback.

### Sherpa-ONNX boundary

A thin C/C++ sherpa-onnx sidecar receiving PCM is the correct boundary. No sherpa/ONNX dependency or binary exists in the repository today, and `VoiceWakeWordService` truthfully remains a packaging gate. The helper should use sherpa's C ABI, load only the approved KWS and VAD models, accept versioned length-bounded mono 16 kHz PCM frames plus reset/config commands, and emit bounded readiness/KWS/VAD/error events. Electron owns the mic and timing; the helper owns model/session state and crash isolation only. It must never own permissions, devices, pre-roll, transcription, AI, TTS, consent, memory, or proactivity. This avoids Electron native-addon ABI coupling without duplicating platform microphone lifecycle.

There are currently two persisted wake enable flags: `CompanionSettings.wake.enabled` and `VoiceSettings.wake.enabled`, while the phrase lives in `VoiceSettings`. Make Companion wake consent/enabled the single authority and Voice settings the phrase/config authority; migrate/remove the duplicate enable flag forward-only. Keep both gated off until helper/model health passes. This also resolves the current contradiction where settings can retain an enabled wake value while `VoiceWakeWordService.start()` always throws.

### Vision separation

Keep Vision outside the audio/helper runtime. Add a host-owned Vision capture/retention service with its own explicit screen consent; do not reuse microphone consent or silently activate the currently forced-false `context.screenEnabled`. Store only explicitly consented screenshots in a separate bounded rolling store, prune at 24 hours, support clear/pause, and never place image bytes in `companion-memory.ts` text entries. Vision may contribute bounded derived context/facts and proactive opportunities to `CompanionOrchestrator`, but delivery remains governed by the existing Companion enablement, quiet hours, visible/unpaused pet, interaction suppression, dedupe, cadence, and provider-health rules. Thus settings, memory semantics, and proactivity remain authoritative while audio and Vision fail independently.

### Packaging, license, and test gates

Do not enable wake until every release target has passed all gates:

- Package a host-architecture helper outside ASAR (or explicitly unpacked), KWS/VAD models, exact `tokens.txt`/BPE assets, version/provenance metadata, and checksums. Extend `electron-builder.yml` and `check-packaging-contract.ts` to assert correct executable/model selection, regular non-symlink files, executable permission, checksum, model-load smoke, clean helper termination, and absence of wrong-architecture artifacts. The current release matrix is macOS x64/arm64 plus Windows/Linux x64, with Windows/Linux arm64 experimental; each shipped artifact needs a matching tested bundle.
- Ship third-party notices: sherpa-onnx framework license, every individual KWS/VAD model license and redistribution approval, source/version provenance, and cryptographic hashes. The framework license does not license the models; no repository LICENSE/NOTICE bundle currently covers these assets.
- Add behavior tests only for observable contracts: one mic owner; no disk/network activity while merely armed; pre-roll included only after wake; KWS→VAD→one finite transcription→the existing Companion path; no-speech discard; cue/TTS self-trigger suppression; wake/PTT barge-in cancellation; plugin/PTT arbitration; settings/Companion disable; permission denial/device swap; suspend/resume; renderer/helper crash backoff; privacy-indicator correctness; shutdown idempotence; and proactivity suppression. Add helper protocol fuzz/size/sequence tests, deterministic PCM fixtures for customizable phrases and endpointing, speaker-loopback false-wake tests on macOS/Windows/Linux (including the Ubuntu VM), and packaged-app smoke tests for binary/model/license integrity.

## Investigation Log

### Implementation slice - accepted

The architecture decision is accepted. The first buildable slice now establishes
the user-facing Abilities surface, removes typed/PTT Control Center affordances,
migrates wake enablement out of Voice settings, adds truthful wake
health/snapshot and power lifecycle hooks, defines bounded helper/PCM/activation
contracts, suppresses proactivity during host speech and future wake activity,
and documents Vision as a single unavailable capability with its agreed
24-hour/privacy/pause contract.

The slice does not open a persistent microphone, spawn Sherpa-ONNX, or capture
screenshots. Wake and Vision remain unavailable until their actual runtime,
model, license, packaging, storage, privacy, and empirical release gates pass.

### Coordinator implementation slice - accepted

The next dependency-first slice implements the main-process wake coordinator
behind injected runtime and capture boundaries. It accepts bounded keyword/VAD
events, assembles in-memory pre-roll and speech, encodes one finite PCM WAV,
reuses `VoiceTranscriptionService`, sends one default-pet voice turn through
`CompanionOrchestrator` with spoken output enabled, suppresses wake acceptance
during output and cooldown, and tears down across suspend, resume, disable, and
shutdown.

Behavior tests use fake persistent capture and wake-runtime adapters to prove
valid activation, no-speech discard, single-turn dispatch, output suppression,
cooldown, restart, and disposal without shipping an ambient listener. At that
stage production still had no persistent AudioWorklet capture adapter or Sherpa
binary/models, so the Listen setting remained disabled and no new microphone
stream was opened.

### Persistent PCM capture bridge slice - accepted

The next prerequisite keeps `VoiceCaptureService` as the one microphone owner
while adding an unwired `VoiceWakeCaptureSource`. A pure core arbitrates plugin
one-shot WebM and wake PCM sessions; the Electron adapter creates a fresh hidden,
sandboxed renderer with media-only permission and a dedicated narrow preload.
An AudioWorklet mixes and resamples input into exact mono 16 kHz f32 frames, with
a three-frame droppable renderer queue and no main-process backlog. Main accepts
frames only from the current renderer sender with the current generation, random
session token, frame duration, timestamp, typed-array shape, and exact sample
count.

Tests prove 20/30 ms worklet framing, preload rejection, sender/token/generation
validation, listener isolation, WebM/PCM mutual exclusion, cancellation during
pending acquisition, acquisition recovery, device/renderer-loss notification
into the coordinator, required output suppression, single-flight startup,
stale-async safety, privacy balance, shutdown, and packaged preload presence.
At that stage the production platform deliberately continued to construct an
unavailable wake service without capture/runtime injection. Therefore settings
could not start the stream and no ambient microphone was opened.

### Sherpa host runtime boundary slice - accepted

The next dependency-first slice implements the TypeScript side of the isolated
Sherpa-ONNX boundary without pretending the native release exists. A strict
manifest validator resolves the current macOS/Windows/Linux x64/arm64 helper,
rejects unsafe paths and symlinks, verifies roles/cardinality, exact sizes,
streaming SHA-256 checksums, legal files, and platform executable rules before
spawn. A versioned NDJSON adapter serializes bounded mono 16 kHz PCM as explicit
little-endian f32 base64 and accepts only bounded, sanitized helper events.

The process runtime owns the ready handshake, one-session rule, abort, graceful
stop/forced teardown, unexpected exits, bounded stdout/stderr, and drop-on-
backpressure behavior. Deterministic fake-process tests protect those observable
contracts, and the packaging check rejects wake resources while the gate is
closed. Production now calls the fail-closed runtime factory, but
`voiceWakeRuntimePackaged` remains false, no native helper/models or wake
`extraResources` entry ships, and capture/transcription/output are injected only
when both the reviewed packaging gate and runtime health are true. Consequently
this slice still opens no ambient microphone. The helper protocol, manifest, and
release checklist are documented under `apps/desktop/wake-helper/`.

### Initial assessment - hypotheses

**Hypotheses:**

1. Persistent capture is necessary for a true local wake phrase, but persistent transcription is not.
2. OpenPets should own one long-lived PCM microphone stream and route frames through a state machine; Sherpa-ONNX should run keyword spotting and possibly VAD in an isolated sidecar, not own the entire product voice pipeline.
3. The existing transcription, Companion orchestration, AI provider, and TTS services should remain downstream provider-neutral boundaries.
4. Vision should be independent of the audio runtime while sharing Companion context, 24-hour memory, consent, pause, and proactive policy.
5. Alternatives such as OS speech recognition, hotkeys, intermittent polling, or cloud-realtime always-on audio may reduce packaging work but conflict with cross-platform, privacy, customization, or cost requirements.

## Root Cause

The earlier design named Sherpa-ONNX without assigning clear system ownership. OpenPets already has strong provider-neutral boundaries after audio capture, but its only microphone primitive is a one-shot hidden-renderer `MediaRecorder` that returns a completed WebM file. A customizable spoken wake phrase cannot be layered onto that blob-oriented path: it requires an always-available local PCM stream, a wake/turn state machine, and explicit recovery behavior. Without those boundaries, “persistent listening” can be mistaken for persistent recording or cloud transcription, and a native runtime can accidentally absorb responsibilities already owned by the host.

## Recommendations

1. Treat the feature as **always armed locally**, not always recording: while enabled, a single Electron-owned microphone track feeds ephemeral mono PCM to local keyword spotting. Do not persist, transcribe, upload, or retain idle audio.
2. Replace the wake path—not necessarily the current PTT path immediately—with a persistent sandboxed AudioWorklet capture origin. Keep Electron/OpenPets as the sole microphone, permission, device, and privacy-indicator authority.
3. Add a main-process activation coordinator that owns the capture/turn state machines, bounded RAM pre-roll, cues, utterance assembly, cancellation, TTS suppression/cooldown, recovery, and teardown. The pre-roll belongs here because it is activation policy; the generic capture source should only own tracks and frames.
4. Package Sherpa-ONNX as a thin signed C/C++ helper using its C ABI. It receives framed 16 kHz mono PCM and owns only model/session health, KWS, and post-wake VAD signals. It must not open the microphone or own pre-roll, ASR, TTS, AI dispatch, consent, memory, or proactivity.
5. Run KWS continuously while armed. Use Silero VAD after a wake hit for command endpointing. Do not hard-gate KWS with idle VAD unless measured corpus results later prove that it improves false accepts without increasing false rejects.
6. After endpointing, reuse the existing finite path: `VoiceTranscriptionService` → `HostAiGateway` → `CompanionOrchestrator` → `VoiceOutputService`. Suppress KWS acceptance during OpenPets-owned cues/speech and briefly afterward, then require the wake phrase again.
7. Build Vision as an independent host service using explicit consent, a single on/off setting, 30/60/90-minute pauses, a separate rolling screenshot store, 24-hour deletion, derived summaries, provider routing, and the existing Companion proactive policy. Do not couple Vision to Sherpa or store image bytes in text conversation memory.
8. Implement in this order: persistent PCM prototype; activation coordinator; helper protocol/health; KWS; post-wake VAD and finite utterance encoding; existing transcription/Companion/TTS wiring; self-trigger suppression and recovery; packaging and empirical acceptance gates; Vision afterward as a parallel capability.

## Preventive Measures

- Keep wake disabled unless the packaged helper, exact OS/architecture binary, models, tokens/BPE assets, checksums, provenance, notices, and redistribution licenses all pass release validation.
- Require tests proving one microphone owner, no disk/network use while merely armed, correct privacy-indicator lifetime, bounded pre-roll and utterances, no-speech discard, one transcription per valid activation, TTS self-trigger protection, cancellation, suspend/resume, device change, renderer/helper crash recovery, and idempotent shutdown.
- Require a representative recorded and live acceptance corpus before default enablement, measuring false accepts per hour, false rejects, wake and endpoint latency, first-word clipping, idle CPU/memory, dropped frames, and behavior during pet speech, meetings, music, typing, fans, Bluetooth changes, and multiple microphones.
- Keep Voice, Companion, Vision, provider, storage, and proactivity responsibilities behind their existing service boundaries so changing a model/runtime does not silently change consent or retention behavior.
