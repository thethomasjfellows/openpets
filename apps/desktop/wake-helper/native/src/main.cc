#include <algorithm>
#include <bit>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

#include "nlohmann/json.hpp"
#include "sentencepiece_processor.h"
#include "sherpa-onnx/c-api/c-api.h"

namespace {

using Json = nlohmann::json;

constexpr int32_t kProtocolVersion = 2;
constexpr int32_t kSampleRate = 16000;
constexpr std::size_t kMaxCommandLineBytes = 128 * 1024;
constexpr std::size_t kMaxPhraseBytes = 480;
constexpr std::size_t kMaxSamplesPerFrame = 16000;

struct Arguments {
  enum class Mode { kWake, kTranscribe };
  Mode mode = Mode::kWake;
  std::string encoder;
  std::string decoder;
  std::string joiner;
  std::string tokens;
  std::string bpe_model;
  std::string vad_model;
  std::string wav_file;
};

struct OfflineRecognizerDeleter {
  void operator()(const SherpaOnnxOfflineRecognizer* value) const {
    if (value != nullptr) SherpaOnnxDestroyOfflineRecognizer(value);
  }
};

struct OfflineStreamDeleter {
  void operator()(const SherpaOnnxOfflineStream* value) const {
    if (value != nullptr) SherpaOnnxDestroyOfflineStream(value);
  }
};

struct OfflineResultDeleter {
  void operator()(const SherpaOnnxOfflineRecognizerResult* value) const {
    if (value != nullptr) SherpaOnnxDestroyOfflineRecognizerResult(value);
  }
};

struct WaveDeleter {
  void operator()(const SherpaOnnxWave* value) const {
    if (value != nullptr) SherpaOnnxFreeWave(value);
  }
};

struct KeywordSpotterDeleter {
  void operator()(const SherpaOnnxKeywordSpotter* value) const {
    if (value != nullptr) SherpaOnnxDestroyKeywordSpotter(value);
  }
};

struct StreamDeleter {
  void operator()(const SherpaOnnxOnlineStream* value) const {
    if (value != nullptr) SherpaOnnxDestroyOnlineStream(value);
  }
};

struct VadDeleter {
  void operator()(const SherpaOnnxVoiceActivityDetector* value) const {
    if (value != nullptr) SherpaOnnxDestroyVoiceActivityDetector(value);
  }
};

struct KeywordResultDeleter {
  void operator()(const SherpaOnnxKeywordResult* value) const {
    if (value != nullptr) SherpaOnnxDestroyKeywordResult(value);
  }
};

using KeywordSpotterPtr =
    std::unique_ptr<const SherpaOnnxKeywordSpotter, KeywordSpotterDeleter>;
using StreamPtr = std::unique_ptr<const SherpaOnnxOnlineStream, StreamDeleter>;
using VadPtr =
    std::unique_ptr<const SherpaOnnxVoiceActivityDetector, VadDeleter>;
using KeywordResultPtr =
    std::unique_ptr<const SherpaOnnxKeywordResult, KeywordResultDeleter>;
using OfflineRecognizerPtr = std::unique_ptr<const SherpaOnnxOfflineRecognizer,
                                             OfflineRecognizerDeleter>;
using OfflineStreamPtr =
    std::unique_ptr<const SherpaOnnxOfflineStream, OfflineStreamDeleter>;
using OfflineResultPtr = std::unique_ptr<const SherpaOnnxOfflineRecognizerResult,
                                         OfflineResultDeleter>;
using WavePtr = std::unique_ptr<const SherpaOnnxWave, WaveDeleter>;

class UnsupportedPhraseError final : public std::runtime_error {
 public:
  explicit UnsupportedPhraseError(std::string_view message)
      : std::runtime_error(std::string(message)) {}
};

[[noreturn]] void Fail(std::string_view message) {
  throw std::runtime_error(std::string(message));
}

[[noreturn]] void FailUnsupportedPhrase(std::string_view message) {
  throw UnsupportedPhraseError(message);
}

void Emit(const Json& event) {
  std::cout << event.dump() << '\n';
  std::cout.flush();
  if (!std::cout.good()) Fail("Helper output failed.");
}

void EmitError(std::string_view message, std::string_view code = {}) {
  Json event{{"version", kProtocolVersion},
             {"type", "error"},
             {"message", std::string(message).substr(0, 500)}};
  if (!code.empty()) event["code"] = std::string(code);
  Emit(event);
}

std::string TrimAsciiWhitespace(std::string value) {
  const auto not_space = [](unsigned char ch) { return std::isspace(ch) == 0; };
  const auto begin = std::find_if(value.begin(), value.end(), not_space);
  const auto end = std::find_if(value.rbegin(), value.rend(), not_space).base();
  return begin < end ? std::string(begin, end) : std::string();
}

std::string UppercaseAscii(std::string value) {
  for (char& ch : value) {
    const auto byte = static_cast<unsigned char>(ch);
    if (byte >= static_cast<unsigned char>('a') &&
        byte <= static_cast<unsigned char>('z')) {
      ch = static_cast<char>(byte - static_cast<unsigned char>('a') +
                             static_cast<unsigned char>('A'));
    }
  }
  return value;
}

std::vector<std::uint8_t> DecodeBase64(std::string_view value) {
  static constexpr std::string_view alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (value.empty() || value.size() % 4 != 0) Fail("PCM payload is invalid.");

  std::vector<int> lookup(256, -1);
  for (std::size_t index = 0; index < alphabet.size(); ++index) {
    lookup[static_cast<unsigned char>(alphabet[index])] =
        static_cast<int>(index);
  }

  std::vector<std::uint8_t> output;
  output.reserve((value.size() / 4) * 3);
  for (std::size_t index = 0; index < value.size(); index += 4) {
    std::uint32_t packed = 0;
    int padding = 0;
    for (std::size_t offset = 0; offset < 4; ++offset) {
      const unsigned char ch = static_cast<unsigned char>(value[index + offset]);
      if (ch == '=') {
        if (offset < 2 || index + 4 != value.size()) {
          Fail("PCM payload is invalid.");
        }
        ++padding;
        packed <<= 6;
        continue;
      }
      if (padding != 0 || lookup[ch] < 0) Fail("PCM payload is invalid.");
      packed = (packed << 6) | static_cast<std::uint32_t>(lookup[ch]);
    }
    output.push_back(static_cast<std::uint8_t>((packed >> 16) & 0xffU));
    if (padding < 2) {
      output.push_back(static_cast<std::uint8_t>((packed >> 8) & 0xffU));
    }
    if (padding < 1) {
      output.push_back(static_cast<std::uint8_t>(packed & 0xffU));
    }
  }
  return output;
}

std::vector<float> DecodeSamples(const Json& command) {
  if (!command.contains("sampleRate") || command["sampleRate"] != kSampleRate ||
      !command.contains("channels") || command["channels"] != 1 ||
      !command.contains("format") || command["format"] != "f32le" ||
      !command.contains("capturedAt") ||
      !command["capturedAt"].is_number() ||
      !std::isfinite(command["capturedAt"].get<double>()) ||
      !command.contains("samplesBase64") ||
      !command["samplesBase64"].is_string()) {
    Fail("PCM command is invalid.");
  }

  const auto bytes =
      DecodeBase64(command["samplesBase64"].get_ref<const std::string&>());
  if (bytes.empty() || bytes.size() % sizeof(float) != 0 ||
      bytes.size() / sizeof(float) > kMaxSamplesPerFrame) {
    Fail("PCM payload is invalid.");
  }

  std::vector<float> samples(bytes.size() / sizeof(float));
  for (std::size_t index = 0; index < samples.size(); ++index) {
    const std::size_t base = index * sizeof(float);
    const std::uint32_t bits =
        static_cast<std::uint32_t>(bytes[base]) |
        (static_cast<std::uint32_t>(bytes[base + 1]) << 8U) |
        (static_cast<std::uint32_t>(bytes[base + 2]) << 16U) |
        (static_cast<std::uint32_t>(bytes[base + 3]) << 24U);
    samples[index] = std::bit_cast<float>(bits);
    if (!std::isfinite(samples[index]) || samples[index] < -1.0F ||
        samples[index] > 1.0F) {
      Fail("PCM sample is invalid.");
    }
  }
  return samples;
}

struct InMemoryWave {
  int32_t sample_rate = 0;
  std::vector<float> samples;
};

std::uint16_t ReadUint16Le(const std::vector<char>& bytes, std::size_t offset) {
  if (offset + 2 > bytes.size()) Fail("Local transcription audio is invalid.");
  return static_cast<std::uint16_t>(static_cast<unsigned char>(bytes[offset])) |
         (static_cast<std::uint16_t>(static_cast<unsigned char>(bytes[offset + 1])) << 8U);
}

std::uint32_t ReadUint32Le(const std::vector<char>& bytes, std::size_t offset) {
  if (offset + 4 > bytes.size()) Fail("Local transcription audio is invalid.");
  return static_cast<std::uint32_t>(static_cast<unsigned char>(bytes[offset])) |
         (static_cast<std::uint32_t>(static_cast<unsigned char>(bytes[offset + 1])) << 8U) |
         (static_cast<std::uint32_t>(static_cast<unsigned char>(bytes[offset + 2])) << 16U) |
         (static_cast<std::uint32_t>(static_cast<unsigned char>(bytes[offset + 3])) << 24U);
}

bool HasAscii(const std::vector<char>& bytes, std::size_t offset, std::string_view value) {
  return offset + value.size() <= bytes.size() &&
         std::equal(value.begin(), value.end(), bytes.begin() + static_cast<std::ptrdiff_t>(offset));
}

InMemoryWave ReadWaveFromStdin() {
  constexpr std::size_t kMaximumStdinAudioBytes = 16 * 1024 * 1024;
  std::vector<char> bytes;
  bytes.reserve(64 * 1024);
  char buffer[8192];
  while (std::cin) {
    std::cin.read(buffer, sizeof(buffer));
    const std::streamsize count = std::cin.gcount();
    if (count <= 0) break;
    const auto incoming = static_cast<std::size_t>(count);
    if (bytes.size() > kMaximumStdinAudioBytes - incoming) {
      Fail("Local transcription audio is too large.");
    }
    bytes.insert(bytes.end(), buffer, buffer + count);
  }
  if (std::cin.bad()) Fail("Local transcription audio could not be read.");
  if (bytes.size() < 44 ||
      !HasAscii(bytes, 0, "RIFF") || !HasAscii(bytes, 8, "WAVE")) {
    Fail("Local transcription audio is invalid.");
  }
  std::uint16_t audio_format = 0;
  std::uint16_t channels = 0;
  std::uint16_t bits_per_sample = 0;
  std::uint32_t sample_rate = 0;
  std::size_t data_offset = 0;
  std::size_t data_size = 0;
  for (std::size_t offset = 12; offset + 8 <= bytes.size();) {
    const std::uint32_t chunk_size = ReadUint32Le(bytes, offset + 4);
    const std::size_t body = offset + 8;
    if (chunk_size > bytes.size() - body) Fail("Local transcription audio is invalid.");
    if (HasAscii(bytes, offset, "fmt ")) {
      if (chunk_size < 16) Fail("Local transcription audio is invalid.");
      audio_format = ReadUint16Le(bytes, body);
      channels = ReadUint16Le(bytes, body + 2);
      sample_rate = ReadUint32Le(bytes, body + 4);
      bits_per_sample = ReadUint16Le(bytes, body + 14);
    } else if (HasAscii(bytes, offset, "data")) {
      data_offset = body;
      data_size = chunk_size;
    }
    const std::size_t padded = static_cast<std::size_t>(chunk_size) + (chunk_size & 1U);
    if (padded > bytes.size() - body) break;
    offset = body + padded;
  }
  if (audio_format != 1 || channels != 1 || bits_per_sample != 16 ||
      sample_rate < 8000 || sample_rate > 48000 || data_offset == 0 ||
      data_size == 0 || data_size % 2 != 0) {
    Fail("Local transcription audio must be mono PCM16 WAV.");
  }
  InMemoryWave wave{.sample_rate = static_cast<int32_t>(sample_rate)};
  wave.samples.resize(data_size / 2);
  for (std::size_t index = 0; index < wave.samples.size(); ++index) {
    const auto value = static_cast<std::int16_t>(ReadUint16Le(bytes, data_offset + index * 2));
    wave.samples[index] = static_cast<float>(value) / 32768.0F;
  }
  return wave;
}

Arguments ParseArguments(int argc, char** argv) {
  if (argc < 3 || (argc - 1) % 2 != 0) Fail("Helper arguments are invalid.");
  std::unordered_map<std::string, std::string> values;
  for (int index = 1; index < argc; index += 2) {
    const std::string key(argv[index]);
    const std::string value(argv[index + 1]);
    if (!key.starts_with("--") || value.empty() ||
        !values.emplace(key, value).second) {
      Fail("Helper arguments are invalid.");
    }
  }

  if (values["--protocol"] != std::to_string(kProtocolVersion)) {
    Fail("Helper protocol version is unsupported.");
  }

  const auto required = [&values](const char* key) -> std::string {
    const auto found = values.find(key);
    if (found == values.end() || found->second.empty()) {
      Fail("A required helper asset is missing.");
    }
    return found->second;
  };

  if (values.contains("--stt-input")) {
    constexpr std::size_t kExpectedArguments = 5;
    if (values.size() != kExpectedArguments) Fail("Helper arguments are invalid.");
    if (required("--stt-input") != "stdin") Fail("Helper transcription input is invalid.");
    return Arguments{
        .mode = Arguments::Mode::kTranscribe,
        .encoder = required("--stt-encoder"),
        .decoder = required("--stt-decoder"),
        .tokens = required("--stt-tokens"),
        .wav_file = "-",
    };
  }

  constexpr std::size_t kExpectedArguments = 7;
  if (values.size() != kExpectedArguments) Fail("Helper arguments are invalid.");

  return Arguments{
      .mode = Arguments::Mode::kWake,
      .encoder = required("--kws-encoder"),
      .decoder = required("--kws-decoder"),
      .joiner = required("--kws-joiner"),
      .tokens = required("--kws-tokens"),
      .bpe_model = required("--kws-bpe-model"),
      .vad_model = required("--vad-model"),
  };
}

int RunTranscription(const Arguments& arguments) {
  std::cerr << "wake-helper: loading local transcription model" << std::endl;
#ifdef _WIN32
  if (_setmode(_fileno(stdin), _O_BINARY) == -1) {
    Fail("Local transcription audio could not switch to binary input mode.");
  }
#endif
  const InMemoryWave input = ReadWaveFromStdin();
  if (input.samples.empty() || input.sample_rate <= 0) {
    Fail("Local transcription audio could not be read.");
  }
  const int32_t feature_frames = static_cast<int32_t>(
      (static_cast<int64_t>(input.samples.size()) * 100 + input.sample_rate - 1) /
      input.sample_rate);
  constexpr int32_t kWhisperEncoderFrames = 3000;
  if (feature_frames > kWhisperEncoderFrames) {
    Fail("Local transcription audio is too long.");
  }
  SherpaOnnxOfflineRecognizerConfig config{};
  config.feat_config.sample_rate = kSampleRate;
  config.feat_config.feature_dim = 80;
  config.model_config.whisper.encoder = arguments.encoder.c_str();
  config.model_config.whisper.decoder = arguments.decoder.c_str();
  config.model_config.whisper.language = "en";
  config.model_config.whisper.task = "transcribe";
  // The pinned tiny.en encoder has a fixed 3000-frame input. Pad each bounded
  // command to that exact shape; a fixed padding value fails for audio whose
  // duration differs from a model fixture.
  config.model_config.whisper.tail_paddings =
      kWhisperEncoderFrames - feature_frames;
  config.model_config.tokens = arguments.tokens.c_str();
  config.model_config.provider = "cpu";
  config.model_config.num_threads = 2;
  config.decoding_method = "greedy_search";

  OfflineRecognizerPtr recognizer(SherpaOnnxCreateOfflineRecognizer(&config));
  if (!recognizer) Fail("Local transcription model could not be loaded.");
  OfflineStreamPtr stream(SherpaOnnxCreateOfflineStream(recognizer.get()));
  if (!stream) Fail("Local transcription stream could not be created.");
  SherpaOnnxAcceptWaveformOffline(stream.get(), input.sample_rate,
                                  input.samples.data(),
                                  static_cast<int32_t>(input.samples.size()));
  SherpaOnnxDecodeOfflineStream(recognizer.get(), stream.get());
  OfflineResultPtr result(SherpaOnnxGetOfflineStreamResult(stream.get()));
  if (!result || result->text == nullptr) Fail("Local transcription failed.");
  Emit(Json{{"version", kProtocolVersion},
            {"type", "transcript"},
            {"text", std::string(result->text).substr(0, 8000)}});
  return 0;
}

class Engine {
 public:
  explicit Engine(Arguments arguments) : arguments_(std::move(arguments)) {
    std::cerr << "wake-helper: loading VAD" << std::endl;
    SherpaOnnxVadModelConfig vad_config{};
    vad_config.silero_vad.model = arguments_.vad_model.c_str();
    vad_config.silero_vad.threshold = 0.5F;
    vad_config.silero_vad.min_silence_duration = 0.35F;
    vad_config.silero_vad.min_speech_duration = 0.15F;
    vad_config.silero_vad.max_speech_duration = 20.0F;
    vad_config.silero_vad.window_size = 512;
    vad_config.sample_rate = kSampleRate;
    vad_config.num_threads = 1;
    vad_config.provider = "cpu";
    vad_.reset(SherpaOnnxCreateVoiceActivityDetector(&vad_config, 30.0F));
    if (!vad_) Fail("Voice activity detection could not be loaded.");
    std::cerr << "wake-helper: waiting for configuration" << std::endl;
  }

  bool configured() const { return vad_only_ || keyword_stream_ != nullptr; }

  void Configure(std::string phrase, const std::vector<std::string>& variants,
                 bool vad_only) {
    vad_only_ = vad_only;
    if (vad_only_) {
      keyword_stream_.reset();
      SherpaOnnxVoiceActivityDetectorReset(vad_.get());
      vad_speech_ = false;
      return;
    }
    phrase = TrimAsciiWhitespace(std::move(phrase));
    if (phrase.empty() || phrase.size() > kMaxPhraseBytes) {
      FailUnsupportedPhrase("Wake phrase is invalid.");
    }

    const std::string normalized_phrase = UppercaseAscii(phrase);
    EnsureKeywordAssets();
    const std::string tokenized = BuildKeywordBuffer(normalized_phrase, variants);
    if (!keyword_spotter_) {
      std::cerr << "wake-helper: loading keyword model" << std::endl;
      SherpaOnnxKeywordSpotterConfig config{};
      config.feat_config.sample_rate = kSampleRate;
      config.feat_config.feature_dim = 80;
      config.model_config.transducer.encoder = arguments_.encoder.c_str();
      config.model_config.transducer.decoder = arguments_.decoder.c_str();
      config.model_config.transducer.joiner = arguments_.joiner.c_str();
      config.model_config.tokens = arguments_.tokens.c_str();
      config.model_config.num_threads = 1;
      config.model_config.provider = "cpu";
      config.max_active_paths = 4;
      config.num_trailing_blanks = 1;
      // Sherpa's documented English KWS example uses a 3.0 / 0.1 pair. Custom
      // pet names need more margin after real microphone and room coloration.
      // Keep the two-word phrase requirement, but favor recall: a wake phrase
      // that only works occasionally makes the entire voice flow unusable.
      config.keywords_score = 7.0F;
      config.keywords_threshold = 0.03F;
      config.keywords_buf = tokenized.c_str();
      config.keywords_buf_size = static_cast<int32_t>(tokenized.size());
      keyword_spotter_.reset(SherpaOnnxCreateKeywordSpotter(&config));
      if (!keyword_spotter_) Fail("Keyword detection could not be loaded.");
      std::cerr << "wake-helper: keyword model loaded" << std::endl;
      keyword_stream_.reset(
          SherpaOnnxCreateKeywordStream(keyword_spotter_.get()));
    } else {
      keyword_stream_.reset(SherpaOnnxCreateKeywordStreamWithKeywords(
          keyword_spotter_.get(), tokenized.c_str()));
    }

    if (!keyword_stream_) Fail("Wake phrase could not be configured.");
    SherpaOnnxVoiceActivityDetectorReset(vad_.get());
    vad_speech_ = false;
  }

  void Reset() {
    if (!configured()) return;
    if (!vad_only_) {
      SherpaOnnxResetKeywordStream(keyword_spotter_.get(),
                                   keyword_stream_.get());
    }
    SherpaOnnxVoiceActivityDetectorReset(vad_.get());
    vad_speech_ = false;
  }

  void Accept(const std::vector<float>& samples) {
    if (!configured()) Fail("Wake helper is not configured.");

    // Built-in microphones can deliver quiet ambient speech, especially when
    // the user is not directly in front of the laptop. Apply bounded gain only
    // below a conservative peak so normal/loud input stays untouched and room
    // noise can never be amplified by more than 6x. This is intentionally
    // recall-first: a companion wake phrase must work at normal laptop distance.
    std::vector<float> wake_samples(samples);
    float peak = 0.0F;
    for (const float sample : wake_samples) peak = std::max(peak, std::abs(sample));
    if (peak > 0.0F && peak < 0.35F) {
      const float gain = std::min(6.0F, 0.35F / peak);
      for (float& sample : wake_samples) {
        sample = std::clamp(sample * gain, -1.0F, 1.0F);
      }
    }

    if (!vad_only_) {
      SherpaOnnxOnlineStreamAcceptWaveform(
          keyword_stream_.get(), kSampleRate, wake_samples.data(),
          static_cast<int32_t>(wake_samples.size()));
      while (SherpaOnnxIsKeywordStreamReady(keyword_spotter_.get(),
                                            keyword_stream_.get())) {
        SherpaOnnxDecodeKeywordStream(keyword_spotter_.get(),
                                      keyword_stream_.get());
        KeywordResultPtr result(SherpaOnnxGetKeywordResult(
            keyword_spotter_.get(), keyword_stream_.get()));
        if (result && result->keyword != nullptr &&
            std::strlen(result->keyword) > 0) {
          Emit(Json{{"version", kProtocolVersion},
                    {"type", "keyword"},
                    {"score", 1.0}});
          SherpaOnnxResetKeywordStream(keyword_spotter_.get(),
                                       keyword_stream_.get());
        }
      }
    }

    SherpaOnnxVoiceActivityDetectorAcceptWaveform(
        vad_.get(), wake_samples.data(),
        static_cast<int32_t>(wake_samples.size()));
    const bool detected =
        SherpaOnnxVoiceActivityDetectorDetected(vad_.get()) != 0;
    if (detected && !vad_speech_) {
      vad_speech_ = true;
      Emit(Json{{"version", kProtocolVersion},
                {"type", "vad"},
                {"state", "speech-start"},
                {"score", 1.0}});
    }

    if (vad_speech_ &&
        (!detected || !SherpaOnnxVoiceActivityDetectorEmpty(vad_.get()))) {
      vad_speech_ = false;
      Emit(Json{{"version", kProtocolVersion},
                {"type", "vad"},
                {"state", "speech-end"},
                {"score", 1.0}});
    }

    while (!SherpaOnnxVoiceActivityDetectorEmpty(vad_.get())) {
      SherpaOnnxVoiceActivityDetectorPop(vad_.get());
    }
  }

 private:
  void EnsureKeywordAssets() {
    if (keyword_assets_loaded_) return;
    std::cerr << "wake-helper: loading tokenizer" << std::endl;
    const auto status = sentencepiece_.Load(arguments_.bpe_model);
    if (!status.ok()) Fail("Wake phrase tokenizer could not be loaded.");
    std::ifstream token_file(arguments_.tokens);
    if (!token_file) Fail("Wake phrase tokens could not be loaded.");
    std::string token_line;
    while (std::getline(token_file, token_line)) {
      const auto separator = token_line.find_first_of(" \t");
      if (separator != std::string::npos && separator > 0) {
        keyword_tokens_.insert(token_line.substr(0, separator));
      }
    }
    if (keyword_tokens_.empty()) Fail("Wake phrase tokens could not be loaded.");
    keyword_assets_loaded_ = true;
  }

  std::string BuildKeywordBuffer(
      const std::string& phrase,
      const std::vector<std::string>& variants) const {
    std::string keywords = Tokenize(phrase);
    std::unordered_set<std::string> seen{keywords};
    for (const auto& raw_variant : variants) {
      const std::string variant = UppercaseAscii(TrimAsciiWhitespace(raw_variant));
      if (variant.empty() || variant.size() > kMaxPhraseBytes) continue;
      try {
        const std::string tokenized = Tokenize(variant);
        if (seen.insert(tokenized).second) keywords += "\n" + tokenized;
      } catch (const UnsupportedPhraseError&) {
        // Calibration variants are optional hints. The user-facing phrase is
        // still valid when a local transcription contains unsupported pieces.
      }
    }
    return keywords;
  }

  std::string Tokenize(const std::string& phrase) const {
    std::vector<std::string> pieces;
    const auto status = sentencepiece_.Encode(phrase, &pieces);
    if (!status.ok() || pieces.empty()) {
      FailUnsupportedPhrase("Wake phrase is not supported by the bundled model.");
    }

    std::string tokenized;
    for (const auto& piece : pieces) {
      if (piece.empty() || piece == "<unk>" || !keyword_tokens_.contains(piece) ||
          piece.find_first_of("\r\n") != std::string::npos) {
        FailUnsupportedPhrase("Wake phrase is not supported by the bundled model.");
      }
      if (!tokenized.empty()) tokenized.push_back(' ');
      tokenized += piece;
    }
    return tokenized;
  }

  Arguments arguments_;
  sentencepiece::SentencePieceProcessor sentencepiece_;
  std::unordered_set<std::string> keyword_tokens_;
  KeywordSpotterPtr keyword_spotter_;
  StreamPtr keyword_stream_;
  VadPtr vad_;
  bool vad_speech_ = false;
  bool vad_only_ = false;
  bool keyword_assets_loaded_ = false;
};

int Run(int argc, char** argv) {
  Arguments arguments = ParseArguments(argc, argv);
  if (arguments.mode == Arguments::Mode::kTranscribe) {
    return RunTranscription(arguments);
  }
  Engine engine(std::move(arguments));
  bool emitted_ready = false;
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty() || line.size() > kMaxCommandLineBytes) {
      Fail("Helper command is invalid.");
    }
    const Json command = Json::parse(line, nullptr, false, true);
    if (command.is_discarded() || !command.is_object() ||
        !command.contains("version") ||
        command["version"] != kProtocolVersion ||
        !command.contains("type") || !command["type"].is_string()) {
      Fail("Helper command is invalid.");
    }

    const std::string type = command["type"].get<std::string>();
    if (type == "configure") {
      if (!command.contains("phrase") || !command["phrase"].is_string()) {
        Fail("Wake phrase is invalid.");
      }
      std::vector<std::string> variants;
      bool vad_only = false;
      if (command.contains("mode")) {
        if (!command["mode"].is_string()) Fail("Wake helper mode is invalid.");
        const std::string mode = command["mode"].get<std::string>();
        if (mode != "kws-vad" && mode != "vad-only") Fail("Wake helper mode is invalid.");
        vad_only = mode == "vad-only";
      }
      if (command.contains("variants")) {
        if (!command["variants"].is_array() || command["variants"].size() > 15) {
          Fail("Wake phrase variants are invalid.");
        }
        for (const auto& variant : command["variants"]) {
          if (!variant.is_string()) Fail("Wake phrase variants are invalid.");
          variants.push_back(variant.get<std::string>());
        }
      }
      try {
        engine.Configure(command["phrase"].get<std::string>(), variants,
                         vad_only);
      } catch (const UnsupportedPhraseError&) {
        EmitError("This wake phrase is not supported by the bundled model.",
                  "phrase-not-supported");
        return 2;
      }
      if (!emitted_ready) {
        emitted_ready = true;
        Emit(Json{{"version", kProtocolVersion}, {"type", "ready"}});
      }
    } else if (type == "pcm") {
      engine.Accept(DecodeSamples(command));
    } else if (type == "reset") {
      engine.Reset();
    } else if (type == "stop") {
      return 0;
    } else {
      Fail("Helper command type is unsupported.");
    }
  }

  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  try {
    return Run(argc, argv);
  } catch (const std::exception&) {
    try {
      EmitError("Wake helper failed.");
    } catch (...) {
    }
    return 1;
  } catch (...) {
    try {
      EmitError("Wake helper failed.");
    } catch (...) {
    }
    return 1;
  }
}
