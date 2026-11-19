/**
 * StoryTape AudioWorkletProcessor
 * Captures 32-bit Float Mono or Stereo interleaved PCM frames off the main thread
 * and computes exact 50 peaks/sec (20 ms buckets) for the live 60fps waveform.
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.channels = opts.channels === 2 ? 2 : 1;
    this.active = true;
    this.peakWindowFrames = Math.max(1, Math.round(sampleRate / 50)); // 50 peaks/sec
    this.flushFrames = Math.max(2048, Math.round(sampleRate * 0.12)); // ~120 ms batches

    this.buffer = new Float32Array(this.flushFrames * this.channels);
    this.bufferedFrames = 0;

    this.currentPeak = 0;
    this.peakFrameCounter = 0;
    this.pendingPeaks = [];

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === 'setActive') {
        const wasActive = this.active;
        this.active = Boolean(msg.active);
        if (wasActive && !this.active) {
          this.flush();
        }
      } else if (msg.type === 'flush') {
        this.flush();
      }
    };
  }

  flush() {
    if (this.bufferedFrames === 0 && this.pendingPeaks.length === 0) return;

    const pcm = this.buffer.slice(0, this.bufferedFrames * this.channels);
    const peaks = this.pendingPeaks.slice();
    this.bufferedFrames = 0;
    this.pendingPeaks = [];

    this.port.postMessage(
      {
        type: 'chunk',
        pcm,
        peaks,
        liveLevel: this.currentPeak,
      },
      [pcm.buffer],
    );
  }

  process(inputs) {
    if (!this.active) return true;
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;

    const ch0 = input[0];
    const ch1 = this.channels === 2 ? input[1] || ch0 : null;
    const frameCount = ch0.length;

    for (let i = 0; i < frameCount; i += 1) {
      const s0 = ch0[i] || 0;
      const offset = this.bufferedFrames * this.channels;
      this.buffer[offset] = s0;

      let absVal = Math.abs(s0);
      if (this.channels === 2) {
        const s1 = ch1 ? ch1[i] || 0 : s0;
        this.buffer[offset + 1] = s1;
        const abs1 = Math.abs(s1);
        if (abs1 > absVal) absVal = abs1;
      }

      if (absVal > this.currentPeak) {
        this.currentPeak = absVal;
      }

      this.peakFrameCounter += 1;
      if (this.peakFrameCounter >= this.peakWindowFrames) {
        this.pendingPeaks.push(Math.min(1, this.currentPeak));
        this.currentPeak = 0;
        this.peakFrameCounter = 0;
      }

      this.bufferedFrames += 1;
      if (this.bufferedFrames >= this.flushFrames) {
        this.flush();
      }
    }

    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
