# Sherpa-ONNX wake helper

This directory owns OpenPets' local wake-word boundary. The Electron host captures
16 kHz mono PCM, validates a target-specific bundle, launches the native helper,
and receives only bounded keyword/VAD events. A separate one-shot invocation of
the same validated executable can transcribe a host-provided WAV with an
explicitly downloaded Whisper model. The helper never opens the microphone,
contacts an AI provider, speaks output, captures the screen, or downloads
dependencies or models itself.

Persistent local listening is intentional for a natural wake-phrase experience:
when the user explicitly enables Listen, the one shared microphone capture stays
active and the operating-system microphone indicator remains visible. Audio
before the wake phrase is processed locally in memory, is not recorded or
transcribed, and is not sent to a provider. After each spoken answer, another
turn requires the wake phrase again.

## Build and test

All third-party inputs are pinned by URL and SHA-256 in
`openpets-voice-wake.lock.json`. Downloads happen only during an explicit build.

```sh
pnpm --filter @open-pets/desktop wake:prepare
pnpm --filter @open-pets/desktop wake:smoke
pnpm --filter @open-pets/desktop build:main
pnpm --filter @open-pets/desktop wake:stage
```

`wake:prepare` compiles the C++20 helper and assembles
`bundle/<platform>-<arch>/`. `wake:smoke` feeds the official model fixture
through the real helper and requires recoverable unsupported-phrase handling,
ready, keyword, VAD start/end, reset, silence, and clean-stop behavior. A successful run writes target-specific smoke
evidence bound to the exact manifest/helper hashes and a deterministic digest
of the current helper build inputs. `wake:stage` imports the compiled TypeScript
validators, rejects evidence from an older checkout plus missing or stale smoke
evidence, revalidates every declared file, and copies only declared regular
files into the ignored `package-resource/` directory consumed by
electron-builder.

Supported manifest targets are macOS, Windows, and Linux on x64 and ARM64. Native
helpers must be built on the target OS; macOS can build both macOS architectures.
Release assembly refuses a missing, wrong-target, unsmoked, stale, or invalid
bundle instead of silently packaging another platform's helper. Ordinary
`package` commands are locked to the current host and architecture; the release
workflow stages the matching attested bundle immediately before each explicit
cross-platform target.

## Ownership and privacy

- `VoiceCaptureService` owns permission, the visible privacy indicator,
  suspend/lock handling, and one global microphone track.
- The persistent helper mode owns Sherpa-ONNX keyword spotting and Silero VAD
  inference only. The independent one-shot mode owns bounded local Whisper
  inference after activation and exits after returning one JSON transcript.
- The host owns phrase normalization, post-keyword utterance assembly, turn
  orchestration, transcription provider selection/model installation,
  backpressure, timeouts, crash handling, and shutdown. Pre-keyword PCM is never
  included in transcription.
- Runtime availability comes from validating the actual packaged bundle. A
  missing or damaged bundle reports Listen as unavailable and never arms the
  microphone.
- The packaged wake bundle never downloads or falls back to another executable.
  The local transcription model is a separate explicit user action: the host
  downloads immutable files, verifies exact sizes and SHA-256 values, installs
  them atomically under user data, and then local inference works offline.

See [protocol.md](protocol.md) for the stdio contract,
[manifest.md](manifest.md) for bundle v2, and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for included dependencies.
