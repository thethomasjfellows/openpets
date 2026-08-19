export const voiceCaptureWorkletProcessorName = "openpets-voice-pcm";

export function createVoiceCaptureWorkletSource(): string {
  return `
class OpenPetsVoicePcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const requestedFrameSamples = options?.processorOptions?.frameSamples;
    this.frameSamples = requestedFrameSamples === 480 ? 480 : 320;
    this.sourceRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
    this.sourceStep = this.sourceRate / 16000;
    this.sourceSamples = [];
    this.sourcePosition = 0;
    this.frame = new Float32Array(this.frameSamples);
    this.frameOffset = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0 || !channels[0]) return true;
    const inputLength = channels[0].length;
    for (let index = 0; index < inputLength; index += 1) {
      let mixed = 0;
      for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
        const channel = channels[channelIndex];
        const value = channel && index < channel.length ? channel[index] : 0;
        mixed += Number.isFinite(value) ? value : 0;
      }
      mixed /= channels.length;
      this.sourceSamples.push(Math.max(-1, Math.min(1, mixed)));
    }

    while (this.sourcePosition + 1 < this.sourceSamples.length) {
      const lowerIndex = Math.floor(this.sourcePosition);
      const fraction = this.sourcePosition - lowerIndex;
      const lower = this.sourceSamples[lowerIndex];
      const upper = this.sourceSamples[lowerIndex + 1];
      this.frame[this.frameOffset] = lower + (upper - lower) * fraction;
      this.frameOffset += 1;
      this.sourcePosition += this.sourceStep;

      if (this.frameOffset === this.frameSamples) {
        const complete = this.frame;
        this.port.postMessage(complete, [complete.buffer]);
        this.frame = new Float32Array(this.frameSamples);
        this.frameOffset = 0;
      }
    }

    const consumed = Math.floor(this.sourcePosition);
    if (consumed > 0) {
      this.sourceSamples = this.sourceSamples.slice(consumed);
      this.sourcePosition -= consumed;
    }
    return true;
  }
}

registerProcessor("openpets-voice-pcm", OpenPetsVoicePcmProcessor);
`;
}
