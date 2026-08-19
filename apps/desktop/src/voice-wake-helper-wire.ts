import {
  isValidVoiceWakePcmFrame,
  maxVoiceWakePhraseCharacters,
  maxVoiceWakeVariants,
  normalizeVoiceWakePhrase,
  parseVoiceWakeHelperEvent,
  voiceWakeProtocolVersion,
  type VoiceWakeHelperCommand,
  type VoiceWakeHelperEvent,
} from "./voice-wake-helper-protocol.js";

export const maxVoiceWakeHelperEventLineBytes = 8 * 1024;

type VoiceWakeHelperWireCommand =
  | { readonly version: 2; readonly type: "configure"; readonly mode?: "kws-vad" | "vad-only"; readonly phrase: string; readonly variants: readonly string[] }
  | {
      readonly version: 2;
      readonly type: "pcm";
      readonly sampleRate: 16_000;
      readonly channels: 1;
      readonly format: "f32le";
      readonly capturedAt: number;
      readonly samplesBase64: string;
    }
  | { readonly version: 2; readonly type: "reset" }
  | { readonly version: 2; readonly type: "stop" };

export function serializeVoiceWakeHelperCommand(command: VoiceWakeHelperCommand): string {
  const wireCommand = toWireCommand(command);
  return JSON.stringify(wireCommand) + "\n";
}

export function parseVoiceWakeHelperEventLine(line: string): VoiceWakeHelperEvent | null {
  if (typeof line !== "string" || Buffer.byteLength(line, "utf8") > maxVoiceWakeHelperEventLineBytes) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  return parseVoiceWakeHelperEvent(value);
}

function toWireCommand(command: VoiceWakeHelperCommand): VoiceWakeHelperWireCommand {
  if (command.version !== voiceWakeProtocolVersion) throw new Error("Wake helper command version is unsupported.");
  if (command.type === "configure") {
    const phrase = normalizeVoiceWakePhrase(command.phrase);
    if (!phrase || phrase.length > maxVoiceWakePhraseCharacters) throw new Error("Wake phrase is invalid.");
    if (!Array.isArray(command.variants) || command.variants.length > maxVoiceWakeVariants) throw new Error("Wake phrase variants are invalid.");
    const variants = command.variants.map((variant) => normalizeVoiceWakePhrase(variant));
    if (variants.some((variant) => !variant)) throw new Error("Wake phrase variants are invalid.");
    const mode = command.mode;
    if (mode !== undefined && mode !== "kws-vad" && mode !== "vad-only") throw new Error("Wake helper mode is invalid.");
    return { version: 2, type: "configure", ...(mode === "vad-only" ? { mode } : {}), phrase, variants };
  }
  if (command.type === "pcm") {
    if (!isValidVoiceWakePcmFrame(command.frame)) throw new Error("Wake PCM frame is invalid.");
    const bytes = new Uint8Array(command.frame.samples.length * Float32Array.BYTES_PER_ELEMENT);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < command.frame.samples.length; index += 1) {
      const sample = command.frame.samples[index];
      if (!Number.isFinite(sample) || sample < -1 || sample > 1) throw new Error("Wake PCM sample is invalid.");
      view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, sample, true);
    }
    return {
      version: 2,
      type: "pcm",
      sampleRate: 16_000,
      channels: 1,
      format: "f32le",
      capturedAt: command.frame.capturedAt,
      samplesBase64: Buffer.from(bytes).toString("base64"),
    };
  }
  if (command.type === "reset") return { version: 2, type: "reset" };
  if (command.type === "stop") return { version: 2, type: "stop" };
  throw new Error("Wake helper command type is unsupported.");
}
