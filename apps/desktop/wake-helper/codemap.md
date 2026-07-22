# apps/desktop/wake-helper/

## Responsibility

Build, validate, test, and document the target-specific native Sherpa-ONNX
keyword-spotting, Silero VAD, and bounded one-shot local Whisper boundary used
by Companion Listen.

## Flow

```text
openpets-voice-wake.lock.json + build-input-digest.mjs
→ prepare-bundle.mjs downloads and SHA-256 verifies pinned sources/models
→ CMake builds native/src/main.cc with SentencePiece and the Sherpa C API
→ bundle/<target>/ receives helper, runtime libraries, explicit KWS/VAD assets,
  licenses, notices, provenance, and manifest v2
→ smoke-test.mjs drives the real official audio fixture through NDJSON and
  writes hash-bound target smoke evidence outside the bundle
→ stage-package-resource.mjs imports the compiled production validators, requires
  matching smoke evidence, and copies
  only declared regular files to package-resource/
→ electron-builder copies that target bundle to resources/voice-wake/sherpa-onnx
```

## Invariants

- No downloads occur in the installed app.
- The helper never opens a microphone or performs network/provider work. Wake
  mode receives bounded 16 kHz mono f32le PCM over stdin; one-shot local
  transcription reads only an explicitly supplied bounded WAV.
- Unsupported phrases stop only their helper session and can be corrected in
  Settings without poisoning the reviewed runtime or restarting OpenPets.
- Every bundled file has an explicit role, source record, byte size, and SHA-256.
- Wrong-platform, multi-platform, missing, symlinked, undeclared, oversized, or
  modified assets fail closed before spawn and before packaging.
- Preparing a target invalidates its previous smoke evidence; staging requires a
  successful native smoke bound to the exact manifest/helper hashes and the
  current checkout's deterministic helper build-input digest.
- Native builds and real-helper smoke tests run on the target OS. macOS may build
  both macOS architectures; Windows/Linux require their own native artifacts.
- Generated cache/build/bundle/package-resource directories are ignored.

## Key files

- `native/CMakeLists.txt`: C++20 helper build and target runtime RPATH.
- `native/src/main.cc`: strict CLI/NDJSON adapter, phrase tokenization, KWS, VAD.
- `openpets-voice-wake.lock.json`: pinned artifact URLs, hashes, target runtime
  layout, model file map, and legal inputs.
- `scripts/build-input-digest.mjs`: cross-OS-stable digest of native source,
  build/contract files, notices, lock, and bundle scripts.
- `scripts/prepare-bundle.mjs`: verified download, native build, target assembly,
  macOS ad-hoc signing, manifest/provenance generation.
- `scripts/smoke-test.mjs`: real helper/model QA for unsupported-phrase recovery,
  HEY PEDRO configuration readiness, keyword/VAD/reset/stop behavior, and
  hash-bound evidence.
- `scripts/stage-package-resource.mjs`: compiled-validator and smoke-evidence
  staging boundary.
- `manifest.md` and `protocol.md`: maintained runtime contracts.
- `THIRD_PARTY_NOTICES.md`: dependency/model attribution.
