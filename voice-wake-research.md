# OpenPets voice activation: Sherpa-ONNX vs a modular stack

Research date: 2026-07-17

## Recommendation

OpenPets should preserve a modular host architecture, but it should not commit its first production wake-word release to a young modular wake engine without a measured bake-off.

The best two implementation candidates are:

1. **Sherpa-ONNX KWS + VAD, with the existing transcription gateway.** This is the safest first ship when OpenPets wants users to type a custom activation phrase. Sherpa's keyword spotting is a constrained streaming recognizer: a phrase can be compiled into tokens at runtime, without training a new model.
2. **A small Rust voice sidecar using LiveKit WakeWord + Silero VAD, with the existing transcription gateway.** This is the most promising genuinely modular design when OpenPets is willing to ship one or several curated wake phrases. It should be prototyped now, but it is too new to select on README benchmarks alone.

My product recommendation is therefore:

- Make the **OpenPets audio pipeline and contracts modular** regardless of which engine ships first.
- Run a short, instrumented bake-off between Sherpa KWS and LiveKit WakeWord.
- Choose **Sherpa for v1** if free-form phrase entry is a launch requirement.
- Choose **LiveKit WakeWord for v1** only if a curated phrase such as “Hey OpenPets” is acceptable and its real-world false-activation results beat Sherpa on the OpenPets test corpus.
- Keep transcription cloud-backed initially. Local transcription is a separate, optional model pack, not a prerequisite for local wake-word privacy.

This is not a recommendation to build a Python distribution. Python is appropriate for training wake models, not as an OpenPets production runtime.

## The decision in one table

| Question | Sherpa-ONNX stack | Best modular stack |
|---|---|---|
| Wake engine | Sherpa KWS | LiveKit WakeWord Rust crate |
| Wake phrase UX | User can type phrases; no retraining | Curated/trained phrase models; changing the phrase means selecting or obtaining another model |
| VAD | Sherpa VAD/TEN/Silero model through one runtime | Silero VAD as an independent component |
| Transcription | Existing cloud gateway initially; Sherpa ASR can be added | Existing cloud gateway initially; whisper.cpp or Moonshine can be added |
| Runtime shape | One broad native runtime, multiple model objects | Small signed Rust sidecar with explicit module interfaces |
| Idle footprint | Likely higher; runtime supports much more than KWS | Potentially lower, but final sidecar size and CPU must be measured |
| Native packaging | Mature cross-platform project, but Node addon creates Electron ABI risk | Sidecar avoids Electron ABI; LiveKit crate itself is only months old |
| Model operations | KWS model plus tokens/BPE; arbitrary keyword text | Embedded front end plus approximately 1 MB classifier per phrase |
| Licensing | Apache-2.0 runtime; each model still needs an audit | Apache-2.0 code; generated classifier data/TTS provenance still needs an audit |
| Failure isolation | Best as a sidecar, not an Electron native addon | Naturally fits a sidecar |
| Best reason to choose it | Free-form phrase setup and mature speech toolbox | Cleaner boundaries, curated wake quality, smaller potential footprint |
| Biggest risk | Larger dependency and a tempting “one engine owns everything” coupling | Young ecosystem plus a model-training and model-QA responsibility |

## What “modular” should mean in OpenPets

It should not mean that Settings exposes five ML libraries. It should mean that the host has stable contracts and can replace implementations:

```text
Chromium microphone capture
  -> AudioWorklet: mono PCM frames + level meter
  -> pre-roll ring buffer
  -> wake detector
  -> VAD / endpoint detector
  -> transcription provider
  -> existing Companion/Codex dispatch
```

The renderer should capture the microphone because OpenPets already has Electron permission handling and a visible capture lifecycle there. A signed sidecar or Electron `utilityProcess` should receive PCM over a `MessagePort`. It should not open a second microphone device. That avoids mic arbitration, preserves one privacy indicator, and permits the exact same stream and pre-roll audio to continue after wake.

The current capture path cannot simply be extended. [`voice-capture.ts`](apps/desktop/src/voice-capture.ts) records one completed `audio/webm` blob with `MediaRecorder`, permits only one active owner, and caps a recording at 8 MiB. Continuous wake detection needs an `AudioWorklet` producing 16 kHz mono PCM (or hardware-rate PCM with one controlled resampler), bounded frame queues, and a rolling pre-roll buffer.

The host-level interfaces should be approximately:

```ts
interface WakeDetector {
  load(model: WakeModel): Promise<void>;
  process(frame: Int16Array): WakeEvent | null;
  reset(): void;
}

interface SpeechSegmenter {
  process(frame: Int16Array): VadEvent[];
  reset(): void;
}

interface Transcriber {
  transcribe(audio: PcmRecording, options: TranscriptionOptions): Promise<Transcript>;
}
```

These contracts belong to the host, not the plugin API. Continuous microphone access is too sensitive to hand to arbitrary plugins.

## Deep dive: modular wake-word choices

### 1. LiveKit WakeWord: the strongest modular prototype

[LiveKit WakeWord](https://github.com/livekit/livekit-wakeword) is the most compelling new option. It is Apache-2.0 and has Python tooling for synthetic-data generation, augmentation, training, export, and evaluation. Production inference is available through Python, Swift, and a [Rust crate](https://docs.rs/crate/livekit-wakeword/0.1.3).

Its pipeline follows openWakeWord's front end—mel features and speech embeddings—but uses a convolution-plus-attention classification head. LiveKit reports, on its own “Hey LiveKit” validation corpus, 0.08 false positives per hour and 86.1% recall at its selected operating point. This is useful evidence, not an independent comparison: the model, corpus, and training system are all from LiveKit, and those figures cannot be compared directly with Sherpa marketing examples.

The Rust runtime is especially relevant to OpenPets:

- It consumes PCM and resamples supported rates to 16 kHz.
- It embeds the mel and embedding ONNX models into the binary and loads phrase classifiers dynamically.
- Inspection of crate 0.1.3 found about 1.09 MB of mel model, 1.33 MB of embedding model, and a 0.95 MB test wake classifier. Those are source-package assets, not the final installed binary size.
- Its default backend uses `ort-tract`; Windows ARM falls back to native ONNX Runtime. Every OpenPets release target still needs a compiled smoke test.
- The classifier can be replaced without rebuilding the app, which maps cleanly to downloadable phrase packs.

The important catch is maturity. The public toolkit and crate appeared in 2026 and are at 0.1.x. OpenPets would be accepting responsibility for training “Hey OpenPets,” maintaining negative/adversarial corpora, testing accents and microphones, and versioning model behavior. The README's production configuration calls for roughly 10,000 generated samples per class and 50,000 training steps; that is a release pipeline, not a setting a user should run locally.

The multilingual pipeline is promising and includes Korean, but synthetic TTS backends, source voices, training data, exported weights, and their licenses must be recorded in a model provenance file. The repository's Apache license alone does not prove that every generated phrase model is unencumbered.

**Verdict:** prototype first. It may be the best OpenPets-specific wake engine, but only after OpenPets trains its own phrase and measures it on representative continuous desktop audio.

### 2. openWakeWord: influential, but a poor direct product dependency

[openWakeWord](https://github.com/dscripka/openWakeWord) is the established ancestor of this family. It accepts 16 kHz PCM, has optional VAD gating, and provides a custom-training notebook. Its code is Apache-2.0.

It is a weak direct fit for OpenPets for three reasons:

- The official runtime is Python-first. Shipping Python, its numerical dependencies, PortAudio assumptions, and a process supervisor is disproportionate for an Electron desktop app.
- Its included pretrained model weights are licensed CC BY-NC-SA, not under the code license. Those weights should not be redistributed as OpenPets defaults.
- The project explicitly says its included models are English-only, and production-quality custom models still require data generation, evaluation, and threshold tuning.

Its architecture and training lessons are valuable, but LiveKit's Rust inference path is a cleaner product candidate.

### 3. microWakeWord: attractive footprint, premature desktop choice

[microWakeWord](https://github.com/kahrendt/microWakeWord) targets TFLite Micro and microcontrollers. Its streaming quantized models can be tiny, which makes it an interesting long-term “minimal idle footprint” direction.

That advantage is less meaningful on desktop than it first appears: OpenPets still needs reliable resampling, capture, pre-roll, endpointing, diagnostics, packaging, and a high-quality custom model. The project describes training as advanced and difficult, and its current generation is early. It is a useful benchmark candidate, not the default implementation.

### 4. Porcupine: polished, but not the open default

[Picovoice Porcupine](https://github.com/Picovoice/porcupine) has good platform coverage, Node/C SDKs, and generated `.ppn` phrase files. It also requires an AccessKey and applies commercial/device/custom-model terms beyond an ordinary open-source runtime.

It could be supported later as a bring-your-own provider. It should not make a no-account open-source OpenPets feature depend on an external vendor entitlement.

### 5. OS speech recognition plus phrase matching

Apple's `SFSpeechRecognizer` can continuously emit partial transcripts, after which an app searches for a phrase. This is broadly how the inspected OpenClaw macOS voice-wake implementation works. It is simple on one platform, but it is not equivalent to acoustic keyword spotting:

- permission and availability differ by OS and locale;
- some recognition paths may use network services;
- the app continually performs general ASR rather than a tiny wake detector;
- Windows and Linux would require different behavior and quality;
- privacy wording becomes conditional and harder to explain.

It is acceptable as a platform-specific experimental provider, not as the cross-platform OpenPets default.

## Deep dive: VAD and endpointing

Wake detection answers “did the phrase occur?” VAD answers “when did the following command start and finish?” They should remain separate modules even if one runtime happens to implement both.

### Silero VAD: recommended default

[Silero VAD](https://github.com/snakers4/silero-vad) is MIT-licensed, supports 8 kHz and 16 kHz audio, provides ONNX models of roughly 2 MB, and is trained across many languages. It is mature enough to be the conservative modular choice. It provides probabilities rather than only binary flags, enabling OpenPets to implement stable onset, hangover, and endpoint rules around it.

It can run in the same Rust sidecar through ONNX/tract, or in a WebAssembly worker for an early prototype. Production should keep both wake and VAD off the renderer's UI thread.

### WebRTC VAD: useful fallback

[WebRTC VAD](https://webrtc.googlesource.com/src/+/refs/heads/main/common_audio/vad/) is tiny and fast, supports 10/20/30 ms PCM frames and multiple aggressiveness levels, and has years of deployment history. Its binary speech decision is less expressive and generally less robust for conversational endpointing in varied desktop noise than a modern neural VAD.

It is valuable as a low-resource fallback and as an independent baseline in the bake-off. Avoid old Node native-addon wrappers; compile the C code into the sidecar if it is selected.

### TEN VAD: technically good, legally unsuitable

[TEN VAD](https://github.com/TEN-framework/ten-vad) reports an unusually small runtime and publishes a reproducible comparison corpus. However, its license adds restrictions to Apache-2.0: it prohibits deployment that competes with Agora or enables third parties to develop/deploy applications. That is incompatible with the intended openness and extensibility of OpenPets.

Do not ship or build a core dependency on TEN VAD without separate legal clearance. Its integration into Sherpa does not make the original TEN license disappear; the provenance of any specific Sherpa-distributed TEN model must be checked.

## Deep dive: modular transcription choices

Local wake-word processing does **not** require local transcription. A privacy-honest first release can say: “The wake phrase is detected on this device. Audio after activation is sent to your selected transcription provider.” This keeps the always-on stream local while reusing [`voice-transcription-service.ts`](apps/desktop/src/voice-transcription-service.ts).

### Existing cloud/provider gateway: recommended first

This is the lowest-risk initial path. On wake, the pipeline retains perhaps 300–700 ms of pre-roll, records until the VAD endpoint, encodes that finite utterance, and sends it through the existing transcriber. It allows OpenPets to validate wake behavior before multiplying model and packaging variables.

### whisper.cpp: best mature optional local pack

[whisper.cpp](https://github.com/ggml-org/whisper.cpp) is MIT-licensed, dependency-light C/C++, broadly cross-platform, quantizable, and optimized for Apple Silicon as well as x86 CPU and several GPU backends. Its published unquantized sizes are approximately 75 MiB/273 MB RAM for Tiny, 142 MiB/388 MB for Base, and 466 MiB/852 MB for Small.

For OpenPets, Base or a quantized Base is the likely quality/size starting point. It should be an on-demand model pack. Whisper is not a wake-word engine, and its example “streaming” mode repeatedly transcribes windows; running it continuously just to find a phrase would waste power and increase false-match complexity.

### Moonshine: a serious streaming-local experiment

[Moonshine Voice](https://github.com/moonshine-ai/moonshine) has a portable C++ core, ONNX Runtime, streaming models, VAD, and event-oriented APIs across macOS, Windows, Linux, mobile, and Raspberry Pi. Its smallest English model is advertised around 26 MB, with larger streaming models available. English code and models are MIT-licensed.

It is attractive for low-latency post-wake streaming transcription. The licensing sharply limits product scope, however: its non-English speech models use a non-commercial Moonshine Community License. OpenPets must not present those as redistributable general-purpose language packs. Moonshine also overlaps multiple modular boundaries, so integrating its high-level “batteries included” API could recreate the same suite coupling the modular design is intended to avoid.

**Verdict:** benchmark English streaming as an experimental local transcriber; do not make it the multilingual default.

### Vosk: small and proven, but no longer the leading quality choice

[Vosk](https://alphacephei.com/vosk/) is Apache-2.0, streaming, broadly portable, and has small per-language models around 30–50 MB. The small US English model is 40 MB and uses about 300 MB runtime memory according to its model page. Model licenses vary by language and release.

Vosk is useful where dynamic vocabulary and low-end CPU matter more than best dictation quality. For natural coding prompts, whisper.cpp or Moonshine deserves priority in a new bake-off.

### faster-whisper: excellent server/Python tool, wrong package shape

[faster-whisper](https://github.com/SYSTRAN/faster-whisper) is an excellent CTranslate2 implementation and a meaningful benchmark reference. Its Python distribution and bundled native/GPU matrix make it less attractive than whisper.cpp for a signed Electron desktop product.

## Settings and setup design

The current persisted schema has only `wake.enabled` and free-text `wake.phrase`. That is insufficient and, for a classifier-based engine, misleading. A phrase field implies that any string immediately works.

### Default Settings UI

The normal Voice page should expose outcomes, not ML internals:

1. **Hands-free activation** — off by default.
2. **Wake phrase** — a selector of installed/available phrases. Show “Custom phrase” only when the selected engine genuinely supports runtime text keywords (Sherpa) or when a trained model has been installed.
3. **Microphone** — system default or device selector, with a live level meter and “Test wake phrase.”
4. **After activation** — target pet/Companion/Codex behavior.
5. **Transcription** — “Selected online provider” or “On this device.” State clearly where post-wake audio goes.
6. **Response while listening** — acknowledgment sound/animation and whether TTS playback temporarily suspends wake detection.

Sensitivity should be three product labels—**Fewer accidental activations**, **Balanced**, **Easier to activate**—mapped to engine- and model-specific calibrated thresholds. Do not persist one universal float: a score of 0.6 has no comparable meaning between Sherpa and LiveKit models.

### First-enable flow

When the user turns Hands-free activation on:

1. Explain that the microphone remains active while OpenPets runs, while wake processing stays local.
2. Request OS microphone permission from the existing OpenPets capture origin.
3. Let the user choose a supported phrase.
4. Download any required model pack with exact size, license link, progress, checksum verification, and retry/cancel.
5. Run a microphone-level check.
6. Ask the user to say the phrase three times. This is calibration/verification, not model training.
7. Play continuous background audio for a short false-trigger check if practical, or at minimum keep a visible test session open.
8. Enable the service only after runtime health, model integrity, microphone input, and a successful detection all pass.

If the user denies permission, the toggle returns to off and Settings links to the relevant OS privacy panel. If a model download fails, OpenPets retains the user's desired phrase but does not report wake as enabled.

### Advanced section

Hide these by default:

- engine: Automatic / Sherpa / LiveKit experimental;
- calibrated sensitivity preset;
- command silence timeout and maximum utterance duration;
- pre-roll duration;
- suspend wake while OpenPets speaks;
- local transcription model, language, disk usage, and hardware acceleration;
- model update channel;
- diagnostic export that contains timings and versions, never raw audio by default.

Raw thresholds can exist behind a developer flag, not in normal Settings.

### Proposed persisted shape

The persisted settings should describe user intent and stable IDs. Runtime health, resolved paths, transient download progress, and raw engine thresholds should not be stored in the same object.

```ts
type VoiceActivationSettings = {
  enabled: boolean;
  engine: "automatic" | "sherpa" | "livekit";
  phraseId: string;              // stable model/keyword-pack ID
  customPhrase?: string;         // valid only for engines supporting it
  sensitivity: "strict" | "balanced" | "easy";
  microphoneDeviceId?: string;   // fall back safely if device disappears
  suspendDuringSpeech: boolean;
  acknowledgement: "pet" | "sound" | "none";
};

type VoiceEndpointSettings = {
  silenceMs: number;
  maxUtteranceMs: number;
};

type VoiceTranscriptionSettings = {
  mode: "provider" | "local";
  localModelId?: string;
};
```

Internally, a signed model manifest should resolve `phraseId` and `localModelId` to engine compatibility, language, version, URLs, compressed/installed size, SHA-256, license/notice files, minimum runtime version, and calibrated sensitivity thresholds.

### Status and diagnostics

Replace the current boolean packaging health with a state machine users and logs can understand:

```text
off
requesting-permission
downloading-model
loading-runtime
listening-for-wake
wake-detected
capturing-command
transcribing
suspended-during-output
recovering
error
```

The tray and Voice page should distinguish “microphone active, waiting locally” from “command audio is being recorded/sent.” That distinction is central to user trust.

Diagnostics should report: selected mic identity (redacted where appropriate), actual sample rate/channel count, dropped-frame count, queue latency, wake engine/model/version, VAD/model/version, last detection score band, time to activation, endpoint latency, transcriber destination, sidecar exit code, and restart count. Never log continuous PCM or complete transcripts by default.

## Model delivery and packaging

OpenPets currently packages Electron with ASAR enabled, unpacks `node_modules/**`, disables npm native rebuilds, and has no general model manager. A Node native addon would therefore add Electron ABI and rebuild complexity. A sidecar is the safer production boundary for either Sherpa or the modular Rust stack.

The release system should:

- build one sidecar per supported OS/architecture;
- place it in `extraResources`, outside ASAR;
- codesign/notarize it as part of the desktop bundle;
- communicate over framed stdio or a private local pipe, with a protocol version handshake;
- terminate it on logout/quit and restart it with a bounded backoff after crashes;
- never allow the sidecar to download arbitrary executable code;
- bundle only a tiny default wake pack if product size permits;
- download large ASR/language packs into an app-owned versioned model directory;
- verify SHA-256 and an OpenPets-signed manifest before activation;
- retain the last known-good model until the new one loads successfully;
- expose storage use and model removal in Settings.

A modular stack does not necessarily mean more user setup, but it does mean more engineering setup: independent version compatibility, licenses, health probes, model manifests, and telemetry for each boundary. That cost is worth paying only where replaceability or footprint is real.

## Recommended proof-of-concept

Build one host audio path and plug both wake candidates into it:

1. Replace the hidden capture renderer's one-shot `MediaRecorder` path for wake sessions with an `AudioWorklet` PCM stream. Keep one-shot recording available for current push-to-talk until the new path can serve both.
2. Add a 500 ms pre-roll ring and explicit backpressure/drop counters.
3. Define a versioned sidecar protocol: `hello`, `configure`, `audio`, `wake`, `speech-start`, `speech-end`, `health`, `reset`, `shutdown`.
4. Implement two sidecar adapters: Sherpa KWS and LiveKit WakeWord. Use the same PCM recordings and orchestration.
5. Use Silero VAD for the modular adapter. Also test WebRTC VAD as the low-resource baseline. For Sherpa, test the selected Sherpa VAD model separately rather than assuming the shared runtime makes it better.
6. After endpointing, send the captured utterance through the existing transcription gateway.
7. Train one “Hey OpenPets” LiveKit classifier; configure the same phrase in Sherpa.

### Acceptance corpus and metrics

Do not select an engine from project-level benchmark claims. Build an OpenPets corpus with consented wake utterances and, more importantly, long negative audio:

- macOS arm64/x64, Windows x64, Ubuntu x64/arm64 where shipped;
- built-in, USB, headset, and Bluetooth microphones;
- near/far field; quiet room, keyboard, music, YouTube, meetings, fans;
- varied genders, accents, speech rates, and non-native English;
- OpenPets TTS playing, to test self-triggering;
- confusing phrases such as “open,” “pets,” and phonetically similar combinations;
- command spoken immediately after the wake phrase, to measure clipped first words.

Release gates should include false accepts per hour, false rejects/recall, wake latency, first-word clipping rate, endpoint latency, idle CPU, peak memory, installed bytes, cold-load time, dropped frames, crash recovery, and suspend/resume behavior. Set the acceptable values before tuning on the final holdout set.

## Staged rollout

### Stage 1: architecture and internal test

- PCM stream, pre-roll, sidecar protocol, privacy states, and model manifest.
- Sherpa and LiveKit adapters behind a developer flag.
- Existing provider transcription only.

### Stage 2: experimental hands-free release

- One curated “Hey OpenPets” model plus, if Sherpa wins, a clearly marked custom phrase field.
- Balanced sensitivity only at first; add presets after measured calibration.
- Test/setup wizard and actionable health diagnostics.
- Opt-in local metrics with no audio retention.

### Stage 3: optional local transcription

- whisper.cpp Base/quantized Base as the conservative downloadable pack.
- Moonshine English streaming as an experimental alternative if its latency and accuracy win.
- Language packs shown only when their model licenses permit OpenPets redistribution and commercial use.

### Stage 4: ecosystem expansion

- Additional signed phrase packs.
- OS-native or vendor engines as optional providers.
- Consider user-submitted phrase models only after model signing, provenance, review, and abuse-resistant distribution exist.

## Bottom line

The modular route is strategically better for OpenPets **as an architecture**. It gives OpenPets a small always-on wake component, an independently replaceable VAD, and optional local transcription without letting one speech toolkit dictate the whole product.

But Sherpa currently has one decisive product advantage: arbitrary wake phrases without a training pipeline. If Settings must contain a real text box where a user types “Hey Pixel” and it works immediately, Sherpa is the practical choice. If OpenPets can begin with “Hey OpenPets” and a phrase-pack selector, the LiveKit Rust + Silero design is the more interesting long-term candidate—subject to a real bake-off and a careful model provenance audit.

The wrong decision would be to expose a free-text phrase setting while shipping a classifier engine that cannot honor it, or to bundle local ASR before the wake path itself is reliable. Build one host-owned PCM pipeline, keep the module contracts stable, measure both engines, and let the product requirement on phrase freedom decide the first default.

## Primary sources

- [Sherpa-ONNX keyword spotting documentation](https://k2-fsa.github.io/sherpa/onnx/kws/index.html)
- [Sherpa-ONNX repository and license](https://github.com/k2-fsa/sherpa-onnx)
- [LiveKit WakeWord toolkit](https://github.com/livekit/livekit-wakeword)
- [LiveKit WakeWord Rust crate 0.1.3](https://docs.rs/crate/livekit-wakeword/0.1.3)
- [openWakeWord repository and model-license warning](https://github.com/dscripka/openWakeWord)
- [microWakeWord repository](https://github.com/kahrendt/microWakeWord)
- [Porcupine repository](https://github.com/Picovoice/porcupine)
- [Silero VAD repository](https://github.com/snakers4/silero-vad)
- [WebRTC VAD source](https://webrtc.googlesource.com/src/+/refs/heads/main/common_audio/vad/)
- [TEN VAD repository and restrictive license](https://github.com/TEN-framework/ten-vad)
- [whisper.cpp repository](https://github.com/ggml-org/whisper.cpp)
- [Moonshine Voice repository and model licensing](https://github.com/moonshine-ai/moonshine)
- [Vosk project and model catalog](https://alphacephei.com/vosk/models)
- [faster-whisper repository](https://github.com/SYSTRAN/faster-whisper)
- [Electron native module guidance](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)
