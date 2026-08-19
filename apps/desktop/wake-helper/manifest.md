# Sherpa wake bundle manifest v2

A prepared target bundle lives at
`wake-helper/bundle/<platform>-<arch>/`. The staging step validates it and
copies only declared files to `wake-helper/package-resource/`; electron-builder
places that directory at `resources/voice-wake/sherpa-onnx/`.

Each target gets its own manifest and must declare exactly one platform, one
helper, and only the runtime libraries referenced by that platform. A Windows or
Linux package cannot reuse or hide inside a macOS staging directory.

## Shape

```json
{
  "version": 2,
  "runtime": "sherpa-onnx",
  "sherpaOnnxVersion": "1.13.4",
    "protocolVersion": 2,
  "bundleId": "openpets-sherpa",
  "bundleVersion": "1.0.0",
  "modelId": "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01",
  "buildInputSha256": "<64 hex characters>",
  "platforms": {
    "darwin-arm64": {
      "helper": "bin/openpets-wake-helper",
      "runtimeLibraries": [
        "lib/libsherpa-onnx-c-api.dylib",
        "lib/libonnxruntime.1.27.0.dylib"
      ]
    }
  },
  "keyword": {
    "encoder": "models/kws/encoder.onnx",
    "decoder": "models/kws/decoder.onnx",
    "joiner": "models/kws/joiner.onnx",
    "bpeModel": "models/kws/bpe.model",
    "tokens": "models/kws/tokens.txt"
  },
  "vad": { "model": "models/vad/silero_vad.onnx" },
  "sources": [
    {
      "id": "source-id",
      "version": "pinned-version",
      "url": "https://example.invalid/artifact",
      "sha256": "<64 hex characters>",
      "license": "SPDX-like-id"
    }
  ],
  "files": [
    {
      "role": "helper",
      "path": "bin/openpets-wake-helper",
      "sha256": "<64 hex characters>",
      "bytes": 123,
      "sourceId": "source-id"
    }
  ]
}
```

Supported platform keys are `darwin-x64`, `darwin-arm64`, `win32-x64`,
`win32-arm64`, `linux-x64`, and `linux-arm64`.

## Roles and cardinality

The selected target must declare one helper and one or more runtime libraries.
The keyword map must resolve to exactly one file of each
`kws-encoder`, `kws-decoder`, `kws-joiner`, `kws-bpe-model`, and
`kws-tokens` role. The VAD map resolves to exactly one `vad-model`.
At least one `license` and `notice`, plus exactly one `provenance`, are
required. Every file references a declared source record.

Windows helpers end in `.exe`; non-Windows helpers must be executable.
License and notice files are capped at 1 MiB, each declared file at 512 MiB, and
the declared bundle total at 1 GiB. The manifest is capped at 96 KiB and the
file list at 96 entries.

## Integrity rules

Paths are normalized relative POSIX paths. Absolute paths, backslashes, control
characters, empty/`.`/`..` segments, duplicates, symlinks, directories,
missing files, and real paths outside the root are rejected. Every file is
measured and streaming-SHA-256 hashed before the helper can spawn. Validation
errors are generic and never expose local paths.

The build lock is the reproducible source of artifact URLs and checksums. The
manifest/provenance pair records exactly what entered a target bundle. Its
`buildInputSha256` deterministically covers the helper source, CMake definition,
lock, protocol/manifest contracts, notices, and bundle scripts. Native smoke
evidence repeats that digest plus the exact manifest/helper hashes; staging
rejects evidence from another checkout. Packaging and post-builder output QA
both revalidate the selected target.
