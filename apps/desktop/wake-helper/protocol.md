# Wake helper protocol v2

The helper is an isolated inference process. The host launches the manifest-selected
executable by absolute path, with the bundle as its working directory and a
minimal allowlisted environment (`LANG`/`LC_ALL`, temporary-directory
variables, and Windows system-root variables only).

```text
--protocol 2
--kws-encoder <absolute path>
--kws-decoder <absolute path>
--kws-joiner <absolute path>
--kws-bpe-model <absolute path>
--kws-tokens <absolute path>
--vad-model <absolute path>
```

The BPE model tokenizes the user-configured phrase when `configure` is received.
Communication is newline-delimited JSON (NDJSON): host commands on stdin and
helper events on stdout. Event lines must be valid UTF-8 JSON objects no larger
than 8 KiB. Unknown, malformed, oversized, or wrong-version messages are terminal
protocol failures. Human diagnostics belong on stderr; the host bounds and
sanitizes them.

## Host commands

Every command has `"version": 2`.

- `configure`: `{"type":"configure","phrase":"Hey OpenPet","variants":[]}`.
  The primary phrase is trimmed, non-empty, and at most 120 characters. Up to
  eight optional locally learned text variants may be included; unsupported
  optional variants are skipped without invalidating the primary phrase.
- `pcm`: 16 kHz mono finite samples in `[-1, 1]`, encoded as explicit
  little-endian float32 bytes in `samplesBase64`. A frame contains 1–16,000
  samples and a finite `capturedAt`.
- `reset`: clears keyword and VAD inference state between turns.
- `stop`: requests graceful shutdown. The host closes stdin and force-kills
  only after the bounded grace period.

## Helper events

Every event has `"version": 2`.

- `ready`: models loaded and the configured phrase was accepted. Host startup
  does not complete before this event.
- `keyword`: includes a finite score from 0 through 1.
- `vad`: includes `state: "speech-start" | "speech-end"` and a finite score.
- `error`: terminal session failure with a bounded generic message. The optional
  allowlisted `code: "phrase-not-supported"` tells the host that a different
  phrase may be tried without marking the reviewed runtime bundle unhealthy.
- `log`: bounded `debug`, `info`, or `warn` diagnostic.

The helper must never echo PCM, phrases, model contents, local paths, or secrets.

## Flow control and lifecycle

Node stream backpressure is authoritative. Once a PCM write returns `false`,
the host drops later PCM frames instead of growing an unbounded queue. A drain
event resumes delivery; a bounded timeout turns prolonged backpressure into a
terminal error.

Only one helper session may run per runtime. Abort before `ready`, disposal
during startup, malformed output, spawn failure, unexpected exit, protocol
failure, or timeout rejects pending startup, terminates the helper, and surfaces
a safe unavailable reason. A `phrase-not-supported` configuration failure stops
only that session; saving a supported phrase starts a fresh helper without an app
restart. Graceful stop is bounded; stop and dispose are idempotent.
