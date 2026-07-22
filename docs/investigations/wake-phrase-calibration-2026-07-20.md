# Investigation: Wake-Phrase Calibration

## Summary

OpenPets hears the user's speech through VAD but its Sherpa custom-keyword matcher does not recognize the configured phrase reliably. The recommended v1 is a guided, local calibration flow modeled on FluidVoice: three explicit recordings produce phrase-bound text variants for Sherpa, while audio is never retained and ambient wake listening remains KWS/VAD-only.

## Symptoms

- The installed microphone capture and Sherpa helper are healthy and remain active.
- A synthetic “Hey Pedro” sample triggers repeatedly, while the user's natural pronunciation produces VAD start/end events but no keyword event.
- Lowering the keyword threshold did not fix the user's real attempt.
- Repackaging the ad-hoc-signed development app causes macOS to request microphone permission again.

## Background / Prior Research

- The installed app is FluidVoice 1.6.4 (`com.FluidApp.app`) and matches the official [`altic-dev/FluidVoice` v1.6.4 source](https://github.com/altic-dev/FluidVoice/tree/v1.6.4).
- FluidVoice's **Train by Voice** flow asks for the intended text, captures 3 valid VAD-bounded samples automatically, and caps a training run at 20 attempts.
- Each sample bypasses existing dictionary corrections. The raw ASR variants become normalized triggers for the intended replacement; duplicate/equal variants are discarded and competing mappings are reconciled.
- With its supported Parakeet provider, FluidVoice also stores pronunciation embeddings: at least 3 make a usable profile and at most 10 recent embeddings are retained per entry/model.
- Training audio is held as temporary 16 kHz mono samples, then cleared. Persisted data contains transcript triggers and optional numeric embeddings, not audio.
- Relevant official source: `CustomDictionaryView.swift` (training loop and merge), `PronunciationDictionaryStore.swift` (profile persistence), `FluidAudioProvider.swift` (embedding enrollment/matching), and `ASRService.swift` (audio lifecycle and runtime replacements).

## Investigator Findings

### Verdict

The proposed product boundary is sound with two corrections:

1. Calibration must be a dedicated main-process `VoiceWakeCalibrationService`, not an extension of the plugin-facing `VoiceListeningService`.
2. Calibration can reuse the existing microphone PCM path and the native helper's VAD events, but it cannot reuse `VoiceWakeActivation` itself because that collector is deliberately keyword-gated. A small calibration-only VAD collector with pre-roll is required.

The smallest useful implementation is transcript-variant enrollment: three accepted, local-only Whisper transcripts become bounded variants for the intended phrase. Pronunciation embeddings are not part of the current Sherpa KWS/VAD + Whisper stack and would require a new model/runtime/storage architecture, so they are out of scope for the forward-only first version.

### 1. Service boundary: dedicated calibration service is confirmed

- `initializeVoicePlatform()` creates one `VoiceCaptureService`, separately obtains `LocalTranscriptionService`, wraps normal transcription in the settings-driven router, and injects the shared capture into wake and plugin listening (`apps/desktop/src/voice-platform.ts:43-58`, `apps/desktop/src/voice-platform.ts:109-135`).
- `VoiceListeningService` explicitly documents that it preserves the plugin SDK's one-shot microphone contract and that Companion wake has a separate activation/consent boundary. Its only owner is `"plugin-listen"`; it performs one finite WAV capture, routes that WAV through the user's selected transcription provider, and resumes wake afterward (`apps/desktop/src/voice-listening-service.ts:8-35`, `apps/desktop/src/voice-listening-service.ts:40-77`).
- Wake listening instead owns an hours-long 20 ms PCM stream, native KWS/VAD events, post-keyword endpointing, transcription, and Companion dispatch (`apps/desktop/src/voice-wake-word-service.ts:279-303`, `apps/desktop/src/voice-wake-word-service.ts:392-519`).

**Conclusion:** extending `VoiceListeningService` would mix a product-owned, multi-sample enrollment lifecycle into a public plugin one-shot contract. Add `VoiceWakeCalibrationService` beside the listening and wake services, wire it from `voice-platform.ts`, and expose it on the internal `VoicePlatform` object.

### 2. Microphone owner, arbitration, and three-sample VAD behavior

#### Current owner and arbitration

- The only capture owners are `"plugin-listen" | "wake"` (`apps/desktop/src/voice-capture-core.ts:8-14`).
- A single private `#active` capture is authoritative; `#assertAvailable()` rejects any concurrent capture (`apps/desktop/src/voice-capture-core.ts:101-110`, `apps/desktop/src/voice-capture-core.ts:232-236`).
- Finite plugin capture and persistent wake PCM are separate modes. The PCM API and active session currently hard-code owner `"wake"` (`apps/desktop/src/voice-capture-core.ts:79-89`, `apps/desktop/src/voice-capture-core.ts:148-207`, `apps/desktop/src/voice-capture-core.ts:263-277`; `apps/desktop/src/voice-wake-runtime.ts:23-34`).
- Wake already supplies a reference-counted suspension/restart boundary for external microphone users (`apps/desktop/src/voice-wake-word-service.ts:348-371`). Calibration should use that boundary, then acquire the shared capture as `"wake-calibration"`. If plugin listening already owns capture, the existing single-owner guard should reject calibration; calibration must never steal or cancel another owner.

The smallest capture change is to add `"wake-calibration"` and generalize the PCM start method so only `"wake"` and `"wake-calibration"` can request `wake-pcm` mode. One continuous PCM session should cover the entire run; do not open and close the device three times.

#### Exact endpoint behavior

- Native Silero VAD currently uses threshold `0.5`, minimum speech `0.15 s`, minimum silence `0.35 s`, and maximum speech `20 s` (`apps/desktop/wake-helper/native/src/main.cc:344-355`).
- After each PCM block is accepted, the helper emits only transitions: `speech-start` when detection begins and `speech-end` when detection clears or a completed VAD segment is available (`apps/desktop/wake-helper/native/src/main.cc:410-457`).
- The existing `VoiceWakeActivation` is not a reusable calibration collector. It appends audio only after `keywordDetected()` changes the state from idle, and its VAD transitions are accepted only in `activated/collecting` states (`apps/desktop/src/voice-wake-activation.ts:42-79`). Tests explicitly protect the contract that idle/pre-keyword audio never reaches transcription (`apps/desktop/tests/voice-wake-activation.test.ts:15-27`).

A calibration-only collector should therefore:

1. Keep a bounded 500 ms PCM pre-roll while waiting. This is necessary because the native helper can announce `speech-start` only after it has already processed speech; starting the sample at the event would clip the wake phrase onset.
2. On `speech-start`, increment the attempt count, seed the candidate with the pre-roll, and continue appending incoming frames.
3. On `speech-end`, finalize immediately. The native endpoint already follows its 350 ms silence rule, so a second host-side post-roll timer is unnecessary.
4. Enter `transcribing`, stop forwarding/collecting PCM, and ignore late VAD events while the local transcript runs. After success or sample rejection, clear the candidate and pre-roll, send helper `reset`, return to `listening`, and only then accept the next attempt. This makes the three samples sequential without reopening the microphone.
5. Reject too-short/no-energy/empty-transcript candidates. Accepted and rejected speech attempts both count toward the 20-attempt cap; only a non-empty local transcript increments the accepted-sample count.
6. Accept exactly three non-empty locally transcribed samples, then stop capture/helper and enter review. Cap the run at 20 speech attempts, matching the researched training contract.
7. Apply a 20-second host failsafe aligned with native VAD's maximum speech duration. Hold audio only in memory until WAV encoding; `encodePcm16Wav()` already produces bounded 16 kHz mono WAV (`apps/desktop/src/voice-audio.ts:1-47`).
8. On success, error, cancellation, Control Center close, or app shutdown: abort transcription, stop helper and capture, clear PCM/WAV buffers, and invoke the one-shot wake resume callback exactly once.

### 3. Calibration transcription must be local-only

- Normal transcription is not a privacy boundary: `VoiceTranscriptionRouter.transcribe()` reads current settings on every call and can select local, OpenAI, or disabled (`apps/desktop/src/voice-transcription-router.ts:18-52`). Wake commands currently call the injected router-backed service (`apps/desktop/src/voice-wake-word-service.ts:483-495`).
- The local service already has the required direct boundary. `LocalTranscriptionService.transcribe()` health-checks the reviewed bundle, accepts WAV only, creates a private temporary job, invokes the helper's one-shot Whisper mode, and recursively deletes the job in `finally` (`apps/desktop/src/voice-local-transcription.ts:143-174`).

**Conclusion:** inject `LocalTranscriptionService` directly into calibration and call it directly. Never pass calibration audio through `VoiceTranscriptionService` or `VoiceTranscriptionRouter`.

There is one UI/IPC trap: the current local-model install handler also changes the user's selected provider to local (`apps/desktop/src/windows.ts:649-660`). For calibration while post-wake STT remains OpenAI, installation must not mutate that preference. The smallest forward-only cleanup is to make the local install endpoint install only; the Listen UI already selects a provider explicitly, while calibration can use the installed model without changing `providerId`.

### 4. Helper protocol, calibrated variants, and unsupported input

#### Current behavior

- Protocol v1 has only `configure { phrase }`, `pcm`, `reset`, and `stop`; there is no variants field or validation command (`apps/desktop/src/voice-wake-helper-protocol.ts:3-18`, `apps/desktop/src/voice-wake-helper-wire.ts:12-25`, `apps/desktop/wake-helper/protocol.md:1-42`).
- The runtime normalizes one phrase, starts one helper, sends that single configure command, and waits for `ready` (`apps/desktop/src/voice-wake-sherpa-runtime.ts:173-213`, `apps/desktop/src/voice-wake-sherpa-runtime.ts:262-292`).
- Native code ASCII-uppercases the phrase, SentencePiece-tokenizes it, rejects empty/`<unk>`/missing/newline tokens, and supplies newline-separated token sequences to Sherpa (`apps/desktop/wake-helper/native/src/main.cc:359-399`, `apps/desktop/wake-helper/native/src/main.cc:474-491`).
- The only aliases are the exact `HEY PEDRO` special case: `A PAY DRILL` and `HEY PAY DRILL` (`apps/desktop/wake-helper/native/src/main.cc:463-471`). The real-bundle smoke test proves only `HEY PEDRO` reaches `ready`; it does not prove either alias detects speech (`apps/desktop/wake-helper/scripts/smoke-test.mjs:57-58`, `apps/desktop/wake-helper/scripts/smoke-test.mjs:196-217`).

A phrase/variant is unsupported when it is empty/too long, SentencePiece fails or yields no pieces, a piece is empty or `<unk>`, a piece is missing from the KWS token vocabulary, or a piece contains CR/LF (`apps/desktop/wake-helper/native/src/main.cc:359-363`, `apps/desktop/wake-helper/native/src/main.cc:474-491`). There is also a current boundary mismatch: TypeScript truncates by JavaScript characters while native limits UTF-8 bytes (`apps/desktop/src/voice-wake-helper-protocol.ts:3-4`, `apps/desktop/src/voice-wake-helper-protocol.ts:21-23`, `apps/desktop/wake-helper/native/src/main.cc:359-363`).

Today any unsupported configured sequence terminates that helper session, but `phrase-not-supported` deliberately does **not** poison bundle/runtime health; a fresh supported phrase can start a new process (`apps/desktop/src/voice-wake-sherpa-runtime.ts:441-452`, `apps/desktop/src/voice-wake-sherpa-runtime.ts:483-514`; regression proof at `apps/desktop/tests/voice-wake-runtime-process.test.ts:131-169`).

#### Smallest forward-only variant design

- After the three samples, normalize/collapse whitespace, compare case-insensitively, discard empty variants, the intended phrase itself, and duplicates.
- Stop the calibration helper session, then preflight each remaining candidate serially through the existing single-phrase runtime. Unsupported candidates are dropped and counted; because `phrase-not-supported` is non-poisoning, no new validation protocol is needed.
- Persist only supported candidates. The review snapshot may expose normalized candidates and an unsupported count, never audio or paths.
- Replace the exact `HEY PEDRO` branch with general intended-phrase-plus-variants tokenization. The intended phrase remains mandatory; optional variants are independently tokenized and an unsupported optional variant is skipped rather than aborting an otherwise valid wake session. This also protects a saved profile if a future bundled model changes token support.
- Treat the calibrated configure shape as helper protocol v2, not an undocumented v1 extension. Update the TypeScript protocol/wire/runtime, native `kProtocolVersion`, helper spawn/STT arguments, generated manifest protocol, smoke test, and protocol/manifest docs together (`apps/desktop/src/voice-wake-helper-protocol.ts:3-18`; `apps/desktop/src/voice-wake-sherpa-manifest.ts:353-357`; `apps/desktop/src/voice-local-transcription.ts:158-166`; `apps/desktop/wake-helper/native/src/main.cc:27-29`, `apps/desktop/wake-helper/native/src/main.cc:241-245`; `apps/desktop/wake-helper/scripts/prepare-bundle.mjs:226-234`; `apps/desktop/wake-helper/scripts/smoke-test.mjs:39-43`).

No nonterminal “variant rejected” helper event is needed in the first version: save-time preflight supplies user feedback, and runtime-side optional skipping is defensive. Do not keep the Pedro aliases as compatibility code.

For calibration-time VAD before the user's phrase is known to be supported, use a separate helper session configured with a neutral bundle-smoked internal phrase (prefer the existing default `HEY OPENPET`, and update the smoke test to prove it) and ignore keyword events. A new native VAD-only mode is unnecessary for the first implementation, and no Pedro-specific string should remain in runtime code.

### 5. Persistence and concise renderer/IPC state

Voice settings already own `wake.phrase`, normalize it, persist atomically, and intentionally leave always-armed consent to Companion settings (`apps/desktop/src/voice-settings.ts:28-35`, `apps/desktop/src/voice-settings.ts:106-142`, `apps/desktop/src/voice-settings.ts:169-181`). Store calibration there and bump settings to v3:

- `wake.phrase`
- optional `wake.calibration = { phrase, variants, updatedAt }`
- apply variants only when the stored calibration phrase equals the current configured phrase after the same normalization; editing the phrase makes old calibration inert.
- persist no PCM, WAV, sample path, raw helper event, embedding, or model-private data.

The existing Control Center contract is already narrow: renderer types include voice/transcription/wake/permission snapshots (`apps/desktop/src/renderer/src/main.tsx:53-78`, `apps/desktop/src/renderer/src/main.tsx:167-203`); preload maps methods to named IPC invokes (`apps/desktop/control-center-preload.cjs:40-76`); every main handler validates the sender (`apps/desktop/src/windows.ts:622-661`, `apps/desktop/src/windows.ts:715-726`, `apps/desktop/src/windows.ts:786-794`).

Add only four actions, with the renderer polling the snapshot while active:

- `voice-wake-calibration-snapshot`
- `voice-wake-calibration-start` (returns immediately after scheduling/preflight)
- `voice-wake-calibration-cancel`
- `voice-wake-calibration-save` (no renderer-supplied variants; save the service-held reviewed result)

A sufficient snapshot is: `state` (`idle | preparing | listening | transcribing | review | saving | complete | cancelled | error`), normalized intended `phrase`, `acceptedSamples`, `requiredSamples: 3`, `attempts`, `maxAttempts: 20`, review-only `variants`, optional `unsupportedVariantCount`, bounded `lastIssue`, and a sanitized `reason`. Raw transcripts should appear only after normalization in the review state. PCM/WAV/base64/temp paths remain main-process-only.

### 6. macOS microphone re-prompts under current signing

The re-prompt is a code-identity issue, not a wake/calibration lifecycle bug.

- Runtime status and requests are thin Electron adapters: `getMediaAccessStatus("microphone")` and `askForMediaAccess("microphone")` (`apps/desktop/src/desktop-permissions-electron.ts:23-31`). A denied explicit request opens the Microphone settings pane (`apps/desktop/src/desktop-permissions.ts:103-116`). Starting either finite or PCM capture also calls browser `getUserMedia`, which lets macOS enforce/prompt at actual device access (`apps/desktop/src/voice-capture.ts:194-200`, `apps/desktop/src/voice-capture.ts:282-288`).
- Packaging supplies `NSMicrophoneUsageDescription` but explicitly uses the ad-hoc identity `"-"`; hardened runtime and Gatekeeper assessment are disabled (`apps/desktop/electron-builder.yml:34-55`).
- Apple's code-signing guidance states that macOS records an app's designated requirement for microphone authorization and that an ad-hoc-signed app's requirement is tied to that exact code version. Rebuilding therefore changes the identity macOS can match, even when `appId: dev.openpets.app` stays the same. See [Apple TN3127: Inside Code Signing — Requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements) and [Applying Code Requirements](https://developer.apple.com/documentation/security/applying-code-requirements).
- The existing “exact app build” copy is directionally correct (`apps/desktop/src/i18n/locales/en.ts:450-459`), but location classification is path-only: a packaged ad-hoc build under `/Applications` is classified as `applications`, not `development` (`apps/desktop/src/desktop-permissions.ts:138-142`). The UI can therefore imply stability that the current signature does not provide.
- Current code marks microphone `requiresRestartAfterGrant: false` while only screen capture is restart-required (`apps/desktop/src/desktop-permissions.ts:71-92`; test locks this in at `apps/desktop/tests/desktop-permissions.test.ts:31-35`). Electron documents that if microphone access was denied and later changed in System Settings, the app must restart for the new permission to take effect. See [Electron `systemPreferences`](https://www.electronjs.org/docs/latest/api/system-preferences).

**Conclusion:** calibration should preflight permission and reuse the existing permission UI; it should not reset TCC, force prompts, or invent a runtime workaround. Stable Developer ID signing with a version-stable designated requirement is the production fix for grants surviving upgrades. Separately, the microphone recovery snapshot should offer restart after the denied-to-Settings path, and signing-aware UI should not infer permission identity from installation path alone.

### Minimal forward-only implementation sequence

1. Add pure behavior tests first for the contracts that can regress: calibration never uses the selected OpenAI route; a second microphone owner is rejected; onset pre-roll and VAD end produce one bounded sample; three accepted samples finish while rejected samples count toward 20; cancellation releases capture and resumes wake exactly once.
2. Add `VoiceWakeCalibrationService` plus a pure calibration collector. Wire the already-shared capture, direct local transcription service, helper runtime, and wake suspend/resume callback in `voice-platform.ts`.
3. Add `"wake-calibration"` and generalize the PCM owner/session types without creating a second microphone implementation. Keep one continuous capture/helper session for the run.
4. Make local-model installation provider-neutral, then gate calibration on local health and transcribe each VAD-bounded WAV directly through `LocalTranscriptionService`.
5. Bump voice settings to v3 and add phrase-bound, normalized, supported variant persistence. Three samples may yield fewer than three unique variants; that is valid.
6. Preflight candidate variants serially with the existing non-poisoning single-phrase helper behavior.
7. Bump the helper wire contract to v2; add bounded `variants` to configure, tokenize optional variants independently, remove all hard-coded `HEY PEDRO` aliases, and update manifest generation, smoke checks, native/package validation, and helper docs in the same change.
8. Add the four sender-validated Control Center IPC/preload methods and the small polling renderer flow. Keep audio and temporary paths out of IPC.
9. Fix the permission recovery truth: suggest restart after microphone access is changed in System Settings, and describe ad-hoc versus stable signing accurately. A separate release task should introduce Developer ID signing/notarization; calibration itself must not own this.
10. Run the focused voice/capture/helper/permission tests, native real-model smoke test, full desktop check, and packaging validation before shipping.

## Investigation Log

### Initial triage — live wake path
**Hypothesis:** The failure is caused by microphone permission, stopped capture, or failure to reset after the first turn.
**Findings:** Eliminated. PCM and VAD remained live, the helper reset worked twice in a controlled test, and no keyword event was emitted for the user's later attempts.
**Conclusion:** The current textual KWS configuration does not adequately model the user's pronunciation.

## Root Cause

The microphone, persistent capture, VAD, helper reset, and wake lifecycle are working. The failure is that Sherpa receives one textual keyword plus a hard-coded Pedro-specific workaround, neither of which represents the user's natural acoustic/ASR variants reliably. Synthetic audio matches while the user's real pronunciation generates only VAD events.

Repeated macOS microphone prompts after rebuilt development installs are separate: the app is ad-hoc signed, so rebuilding changes the code identity used by TCC. Calibration must not attempt to work around that packaging problem.

## Recommendations

1. Add a dedicated `VoiceWakeCalibrationService` and a `wake-calibration` microphone owner; do not expand the plugin-facing one-shot listening contract.
2. Capture one continuous local PCM session with native VAD, a 500 ms pre-roll, three accepted samples, and a 20-attempt cap.
3. Transcribe calibration samples directly through `LocalTranscriptionService`, regardless of the user's normal post-wake provider. Keep audio only in memory/temporary local-STT storage and delete it immediately.
4. Persist only normalized, phrase-bound, supported transcript variants. Editing the intended wake phrase makes prior calibration inert.
5. Bump the helper contract to v2 with `configure { phrase, variants }`, keep the primary phrase mandatory, skip unsupported optional variants defensively, and remove all hard-coded Pedro aliases.
6. Add four internal Control Center actions: snapshot, start, cancel, and save. Never expose audio, temporary paths, or renderer-supplied variants.
7. Put one concise card below **Wake phrase**: **Improve wake phrase recognition**. Explain local setup-only transcription and text-only storage; show sample progress, cancel, review/save, and reset.
8. Treat Developer ID signing/notarization and stable permission identity as a separate release task. Correct permission recovery copy to request restart after access is changed in System Settings.

## Preventive Measures

- Test recognition using real spoken phrase samples, not configuration readiness alone.
- Protect the ambient-audio privacy boundary with regression tests proving calibration is explicit/local-only and normal wake PCM is never transcribed.
- Test capture arbitration, VAD pre-roll/endpointing, three-sample completion, 20-attempt cap, cancellation/error cleanup, and wake resume exactly once.
- Test settings normalization, phrase binding, helper v2 wire bounds, unsupported optional variants, runtime reconfiguration, native smoke behavior, and packaged resource validation.
- Ship production macOS builds with a stable Developer ID designated requirement so permissions survive app upgrades.
