# OpenPets wake runtime third-party notices

This bundle contains only local keyword spotting and voice activity detection assets.

- OpenPets wake helper: OpenPets project license.
- sherpa-onnx 1.13.4: Apache License 2.0.
- sherpa-onnx KWS Zipformer GigaSpeech 3.3M model (2024-01-01): model metadata declares Apache License 2.0.
- sherpa-onnx Whisper tiny.en int8 model (optional, explicitly downloaded at runtime): model metadata declares Apache License 2.0; its notice is installed beside the model.
- SentencePiece 0.2.1: Apache License 2.0.
- ONNX Runtime 1.27.0: MIT License.
- Silero VAD model/runtime assets: MIT License.
- nlohmann/json 3.12.0: MIT License; used only to build the helper and statically linked.

Source URLs, immutable versions, archive SHA-256 values, and selected filenames are recorded in `openpets-voice-wake.lock.json`. The assembled manifest records SHA-256 and byte length for every shipped file.
