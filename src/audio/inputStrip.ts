import type { AudioQualitySettings } from '../types/models';

/**
 * -3.0 dBFS knee start: normal speech below this level passes at exact 1:1 unity gain
 * with zero harmonic coloration.
 */
export const SOFT_CLIP_THRESHOLD = 0.7071;

/**
 * -1.0 dBFS ceiling: leaves 1.0 dB of true-peak headroom so resampling and lossy
 * AAC/Opus inter-sample peaks never exceed 0 dBFS.
 */
export const SOFT_CLIP_CEILING = 0.8913;

/**
 * Inaudible ultrasonic Nyquist keepalive amplitude (-100 dBFS, well below 16-bit DAC LSB).
 * Alternating +/- at sampleRate/2 keeps Chromium's hardware audio output sink active past
 * the 30-second SilentSinkSuspender timeout with zero DC offset and zero audible sound.
 */
export const KEEPALIVE_AMPLITUDE = 1e-5;

/**
 * C1-continuous soft-clipping transfer function:
 * - Exact identity (y = x) for |x| <= threshold
 * - Smooth tanh knee approaching `ceiling` for |x| > threshold
 * Matches both value and first derivative (dy/dx = 1) at |x| = threshold.
 */
export function softLimitSample(
  x: number,
  threshold = SOFT_CLIP_THRESHOLD,
  ceiling = SOFT_CLIP_CEILING,
): number {
  const abs = Math.abs(x);
  if (abs <= threshold) return x;
  const headroom = Math.max(1e-6, ceiling - threshold);
  const limited = threshold + headroom * Math.tanh((abs - threshold) / headroom);
  return x < 0 ? -limited : limited;
}

let cachedSoftClipCurve: Float32Array<ArrayBuffer> | null = null;

/**
 * Builds an odd-length symmetric WaveShaperNode lookup curve over [-1, 1]
 * using `softLimitSample`. Inputs > 1.0 clamp to the curve endpoint (< -1.0 dBFS).
 */
export function buildSoftClipCurve(
  samples = 8193,
  threshold = SOFT_CLIP_THRESHOLD,
  ceiling = SOFT_CLIP_CEILING,
): Float32Array<ArrayBuffer> {
  const isDefault =
    samples === 8193 &&
    threshold === SOFT_CLIP_THRESHOLD &&
    ceiling === SOFT_CLIP_CEILING;
  if (isDefault && cachedSoftClipCurve) {
    return cachedSoftClipCurve;
  }

  const count = samples % 2 === 1 ? samples : samples + 1;
  const curve = new Float32Array(new ArrayBuffer(count * 4));
  const mid = (count - 1) / 2;
  for (let i = 0; i < count; i += 1) {
    const x = (i - mid) / mid; // -1 .. +1, exact 0 at mid
    curve[i] = softLimitSample(x, threshold, ceiling);
  }

  if (isDefault) {
    cachedSoftClipCurve = curve;
  }
  return curve;
}

/**
 * Transparent post-resample true-peak safety ceiling for compressed encoders and
 * integer PCM WAV output. Returns the original arrays untouched (zero-copy) when
 * all samples already sit below `threshold`.
 */
export function applyPeakCeilingToChannels(
  channels: Float32Array[],
  threshold = 0.85,
  ceiling = SOFT_CLIP_CEILING,
): Float32Array[] {
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i += 1) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
    }
  }
  if (peak <= threshold) {
    return channels;
  }

  return channels.map((ch) => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i += 1) {
      out[i] = softLimitSample(ch[i], threshold, ceiling);
    }
    return out;
  });
}

/**
 * Writes an alternating +/- KEEPALIVE_AMPLITUDE Nyquist tone into `output`
 * (used by ScriptProcessorNode fallback to mirror pcm-capture-worklet.js).
 */
export function writeNyquistKeepalive(
  output: Float32Array,
  startSign: 1 | -1 = 1,
): 1 | -1 {
  let sign: 1 | -1 = startSign;
  for (let i = 0; i < output.length; i += 1) {
    output[i] = sign * KEEPALIVE_AMPLITUDE;
    sign = sign === 1 ? -1 : 1;
  }
  return sign;
}

export interface StudioInputStrip {
  tail: AudioNode;
  nodes: AudioNode[];
}

/**
 * Builds the StoryTape studio input strip:
 *   source -> [80Hz HPF] -> Input Gain -> [DynamicsCompressor + Soft-Clip Ceiling (-1 dBFS)]
 *
 * The WaveShaper soft-clipping ceiling compensates for Chromium/WebKit DynamicsCompressorNode's
 * automatic internal makeup gain and 1ms transient overshoot so vocal peaks stay below -1 dBFS.
 */
export function buildStudioInputStrip(
  ctx: AudioContext,
  source: AudioNode,
  quality: AudioQualitySettings,
): StudioInputStrip {
  const nodes: AudioNode[] = [source];
  let tail: AudioNode = source;

  if (quality.highPassFilter) {
    const hpf = ctx.createBiquadFilter();
    hpf.type = 'highpass';
    hpf.frequency.value = 80;
    hpf.Q.value = 0.707;
    tail.connect(hpf);
    tail = hpf;
    nodes.push(hpf);
  }

  const gainNode = ctx.createGain();
  gainNode.gain.value = quality.inputGain;
  tail.connect(gainNode);
  tail = gainNode;
  nodes.push(gainNode);

  if (quality.softLimiter) {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -6;
    comp.knee.value = 6;
    comp.ratio.value = 12;
    comp.attack.value = 0.001;
    comp.release.value = 0.1;
    tail.connect(comp);
    tail = comp;
    nodes.push(comp);

    if (typeof ctx.createWaveShaper === 'function') {
      const shaper = ctx.createWaveShaper();
      shaper.curve = buildSoftClipCurve();
      shaper.oversample = '2x';
      tail.connect(shaper);
      tail = shaper;
      nodes.push(shaper);
    }
  }

  return { tail, nodes };
}
