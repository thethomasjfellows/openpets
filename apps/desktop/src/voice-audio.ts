export type VoiceFiniteAudioCapture = {
  readonly bytes: Uint8Array;
  readonly mimeType: "audio/webm" | "audio/wav";
  readonly durationMs: number;
};

const wavHeaderBytes = 44;
const maximumWakeDurationSeconds = 30;

export function encodePcm16Wav(samples: Float32Array, sampleRate = 16_000): VoiceFiniteAudioCapture {
  if (!(samples instanceof Float32Array) || samples.length === 0) throw new Error("Voice audio is empty.");
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 48_000) throw new Error("Voice sample rate is invalid.");
  if (samples.length > sampleRate * maximumWakeDurationSeconds) throw new Error("Voice audio exceeds the 30 second limit.");

  const bytesPerSample = 2;
  const dataBytes = samples.length * bytesPerSample;
  const bytes = new Uint8Array(wavHeaderBytes + dataBytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, dataBytes, true);

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, Number.isFinite(samples[index]) ? samples[index] : 0));
    const pcm = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
    view.setInt16(wavHeaderBytes + index * bytesPerSample, pcm, true);
  }

  return {
    bytes,
    mimeType: "audio/wav",
    durationMs: Math.round(samples.length / sampleRate * 1_000),
  };
}

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) target[offset + index] = value.charCodeAt(index);
}
