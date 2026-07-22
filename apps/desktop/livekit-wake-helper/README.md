# OpenPets LiveKit wake helper

This helper performs local, wake-only inference for the fixed OpenPets phrase
`Hey Pedra`. It receives 16 kHz mono PCM from the Electron host over stdin and
never opens the microphone, uses the network, records audio, or transcribes it.

Stdin capture and classifier inference run on separate threads. The bounded
inference worker drains queued PCM to the newest two-second window before each
prediction, preventing slow model calls from turning into multi-second live
audio backlog. Keyword events include `capturedAt`, `windowMs`, and `strideMs`
so the Electron host can distinguish helper transport delay from true
phrase-end recognition time.

The classifier is phrase-specific. A missing or unverified classifier is a hard
packaging failure; the helper must not fall back to transcript matching.

## Release inputs

The helper source can be compiled independently, but OpenPets packaging remains
blocked until `training/release/` contains both:

- `hey_pedra.onnx` — a classifier trained for the exact fixed phrase.
- `classifier-provenance.json` — the pinned training commit/config, evaluated
  strict/balanced/easy thresholds, recall, and false positives per hour.

The production training configuration is `training/hey-pedra.yaml`. Standard
LiveKit training uses a large general-negative speech corpus; do not use
`--skip-acav` for a release classifier merely to reduce the download. Training
should run on a machine with enough disposable storage and acceleration, and
evaluation must include voices and recordings that were not used to train the
model.

Once those inputs exist, run `pnpm livekit-wake:prepare`, build the desktop main
process, and run `pnpm livekit-wake:stage`. The prepare and stage commands reject
the wrong phrase identity, unpinned provenance, thresholds outside the evaluated
ordering, recall below `0.75`, false positives above `0.5` per hour, damaged
files, symlinks, and a bundle built for another target.

The first production **Hey Pedra** bundle uses evaluated thresholds `0.16`
(Easy), `0.21` (Balanced), and `0.30` (Strict). Easy is the default for new
installs; its held-out evaluation recall is `0.929` at `0.489` false positives
per hour, and its local microphone acceptance run detected 10/10 normal,
10/10 farther-away, and 10/10 fan-noise utterances without retaining audio.
