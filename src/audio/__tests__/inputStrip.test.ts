import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  applyPeakCeilingToChannels,
  buildSoftClipCurve,
  buildStudioInputStrip,
  gainDbToMultiplier,
  gainMultiplierToDb,
  KEEPALIVE_AMPLITUDE,
  MAX_INPUT_GAIN_DB,
  MIN_INPUT_GAIN_DB,
  SOFT_CLIP_CEILING,
  SOFT_CLIP_THRESHOLD,
  SOFTWARE_AGC_INITIAL_GAIN,
  SOFTWARE_AGC_MAX_GAIN,
  SoftwareAutoGainController,
  softLimitSample,
  writeNyquistKeepalive,
} from '../inputStrip';
import { DEFAULT_AUDIO_QUALITY } from '../../storage/settings';

describe('inputStrip DSP & true-peak ceiling', () => {
  it('passes normal voice levels below -3 dBFS at exact 1:1 unity gain and softly bounds extreme peaks below -1 dBFS', () => {
    // Unity gain below threshold
    for (const v of [-0.7, -0.5, -0.1, 0, 0.1, 0.5, 0.7]) {
      expect(softLimitSample(v)).toBe(v);
    }

    // Odd symmetry & smooth monotonic saturation strictly below SOFT_CLIP_CEILING
    const hotInputs = [0.75, 0.85, 1.0, 1.5, 4.0];
    let prev = SOFT_CLIP_THRESHOLD;
    for (const x of hotInputs) {
      const y = softLimitSample(x);
      expect(y).toBeGreaterThan(prev);
      expect(y).toBeLessThan(SOFT_CLIP_CEILING);
      expect(softLimitSample(-x)).toBeCloseTo(-y, 7);
      prev = y;
    }
  });

  it('builds a symmetric WaveShaper soft-clip curve with exact zero center and bounded endpoints', () => {
    const curve = buildSoftClipCurve(1025);
    expect(curve.length).toBe(1025);
    expect(curve[512]).toBe(0);
    expect(Math.abs(curve[0])).toBeLessThan(SOFT_CLIP_CEILING);
    expect(Math.abs(curve[1024])).toBeLessThan(SOFT_CLIP_CEILING);
    expect(curve[0]).toBeCloseTo(-curve[1024], 6);
  });

  it('applyPeakCeilingToChannels is zero-copy below threshold and bounds inter-sample overshoots cleanly', () => {
    const clean = [new Float32Array([0, 0.3, -0.6, 0.84])];
    const untouched = applyPeakCeilingToChannels(clean);
    expect(untouched).toBe(clean); // zero-copy fast path

    const hot = [new Float32Array([0.2, 1.05, -1.2, -0.4])];
    const bounded = applyPeakCeilingToChannels(hot);
    expect(bounded).not.toBe(hot);
    expect(bounded[0][0]).toBeCloseTo(0.2, 6);
    expect(bounded[0][3]).toBeCloseTo(-0.4, 6);
    expect(bounded[0][1]).toBeLessThanOrEqual(Math.fround(SOFT_CLIP_CEILING));
    expect(bounded[0][2]).toBeGreaterThanOrEqual(Math.fround(-SOFT_CLIP_CEILING));
  });

  it('writeNyquistKeepalive emits zero-DC alternating +/-1e-5 ultrasonic tone continuously across calls', () => {
    const a = new Float32Array(4);
    const b = new Float32Array(4);
    const nextSign = writeNyquistKeepalive(a, 1);
    writeNyquistKeepalive(b, nextSign);

    const expected = [
      KEEPALIVE_AMPLITUDE,
      -KEEPALIVE_AMPLITUDE,
      KEEPALIVE_AMPLITUDE,
      -KEEPALIVE_AMPLITUDE,
    ];
    for (let i = 0; i < expected.length; i += 1) {
      expect(a[i]).toBeCloseTo(expected[i], 8);
    }
    expect(b[0]).toBe(-a[3]); // Continuous alternating phase across buffer boundary
    const dc = (a.reduce((s, v) => s + v, 0) + b.reduce((s, v) => s + v, 0)) / 8;
    expect(Math.abs(dc)).toBeLessThan(1e-12);
  });

  it('converts manual input gain cleanly between decibels (-6..+24 dB) and linear multipliers', () => {
    expect(gainMultiplierToDb(1.0)).toBe(0);
    expect(gainDbToMultiplier(0)).toBe(1.0);
    expect(gainMultiplierToDb(0.5)).toBe(MIN_INPUT_GAIN_DB);
    expect(gainMultiplierToDb(16)).toBe(MAX_INPUT_GAIN_DB);
    expect(gainDbToMultiplier(12)).toBeCloseTo(3.9811, 3);
    expect(gainDbToMultiplier(24)).toBeCloseTo(15.8489, 3);
    expect(gainMultiplierToDb(gainDbToMultiplier(18.5))).toBe(18.5);
    expect(gainMultiplierToDb(-1)).toBe(MIN_INPUT_GAIN_DB);
    expect(gainDbToMultiplier(99)).toBeCloseTo(15.8489, 3);
  });

  it('SoftwareAutoGainController boosts quiet raw iPhone speech, holds steady during silence, and tames loud shouts', () => {
    const agc = new SoftwareAutoGainController();
    expect(agc.getGain()).toBe(SOFTWARE_AGC_INITIAL_GAIN); // +12 dB starting boost

    // 1. Quiet room silence (-66 dBFS raw) for 1 second -> gain holds steady (zero noise-floor pumping)
    const silenceChunk = new Float32Array(1200);
    for (let step = 0; step < 40; step += 1) {
      const g = agc.getGain();
      for (let i = 0; i < silenceChunk.length; i += 1) {
        silenceChunk[i] = 0.0005 * g * (i % 2 === 0 ? 1 : -1);
      }
      agc.processSamples(silenceChunk, 0.025);
    }
    expect(agc.getGain()).toBeCloseTo(SOFTWARE_AGC_INITIAL_GAIN, 4);

    // 2. Quiet iPhone speech (~-41 dBFS raw RMS = 0.009) -> smoothly boosts toward -18 dBFS (~13.9x)
    const quietSpeechChunk = new Float32Array(1200);
    for (let step = 0; step < 80; step += 1) {
      const g = agc.getGain();
      for (let i = 0; i < quietSpeechChunk.length; i += 1) {
        // Sine with RMS = 0.009 (peak = 0.0127)
        quietSpeechChunk[i] = 0.009 * Math.SQRT2 * g * Math.sin((i / 48) * Math.PI * 2);
      }
      agc.processSamples(quietSpeechChunk, 0.025);
    }
    expect(agc.getGain()).toBeGreaterThan(12);
    expect(agc.getGain()).toBeLessThanOrEqual(SOFTWARE_AGC_MAX_GAIN);
    const boostedGain = agc.getGain();

    // 3. Pause between sentences -> gain remains frozen without creeping to max
    for (let step = 0; step < 40; step += 1) {
      for (let i = 0; i < silenceChunk.length; i += 1) {
        silenceChunk[i] = 0.0005 * agc.getGain() * (i % 2 === 0 ? 1 : -1);
      }
      agc.processSamples(silenceChunk, 0.025);
    }
    expect(agc.getGain()).toBeCloseTo(boostedGain, 4);

    // 4. Sudden loud speech near mic (raw peak = 0.45, limited at -1 dBFS = 0.89) -> fast attack pulls gain down
    const loudChunk = new Float32Array(1200);
    for (let step = 0; step < 25; step += 1) {
      const g = agc.getGain();
      for (let i = 0; i < loudChunk.length; i += 1) {
        const raw = 0.45 * Math.sin((i / 48) * Math.PI * 2);
        loudChunk[i] = softLimitSample(raw * g);
      }
      agc.processSamples(loudChunk, 0.025);
    }
    expect(agc.getGain()).toBeLessThan(2.0);
  });

  it('buildStudioInputStrip inserts software AGC ahead of the safety limiter only when requested', () => {
    const order: string[] = [];
    const setTargetAtTime = vi.fn();
    const cancelScheduledValues = vi.fn();
    const setValueAtTime = vi.fn();
    const mockCtx = {
      currentTime: 1.25,
      createBiquadFilter: () => {
        order.push('hpf');
        return { type: '', frequency: { value: 0 }, Q: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() };
      },
      createGain: () => {
        order.push('gain');
        return {
          gain: { value: 1, setTargetAtTime, cancelScheduledValues, setValueAtTime },
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
      },
      createDynamicsCompressor: () => {
        order.push('comp');
        return {
          threshold: { value: 0 },
          knee: { value: 0 },
          ratio: { value: 0 },
          attack: { value: 0 },
          release: { value: 0 },
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
      },
      createWaveShaper: () => {
        order.push('shaper');
        return { curve: null, oversample: 'none', connect: vi.fn(), disconnect: vi.fn() };
      },
    } as unknown as AudioContext;
    const mockSource = { connect: vi.fn(), disconnect: vi.fn() } as unknown as AudioNode;

    const withoutAgc = buildStudioInputStrip(mockCtx, mockSource, DEFAULT_AUDIO_QUALITY);
    expect(withoutAgc.autoGainNode).toBeNull();
    expect(order).toEqual(['hpf', 'gain', 'comp', 'shaper']);

    order.length = 0;
    const withAgc = buildStudioInputStrip(mockCtx, mockSource, DEFAULT_AUDIO_QUALITY, {
      enableSoftwareAgc: true,
    });
    expect(withAgc.autoGainNode).not.toBeNull();
    expect(withAgc.autoGainNode!.gain.value).toBe(SOFTWARE_AGC_INITIAL_GAIN);
    expect(order).toEqual(['hpf', 'gain', 'gain', 'comp', 'shaper']);

    // Silence holds gain steady and skips redundant AudioParam scheduling completely
    const silence = new Float32Array(1200);
    withAgc.updateAutoGain(silence, 0.025);
    expect(setTargetAtTime).not.toHaveBeenCalled();

    // Updating with quiet speech cancels superseded automation and schedules smooth update
    const samples = new Float32Array(1200).fill(0.04);
    const nextGain = withAgc.updateAutoGain(samples, 0.025);
    expect(nextGain).toBeGreaterThan(SOFTWARE_AGC_INITIAL_GAIN);
    expect(cancelScheduledValues).toHaveBeenCalledWith(1.25);
    expect(setValueAtTime).toHaveBeenCalledWith(SOFTWARE_AGC_INITIAL_GAIN, 1.25);
    expect(setTargetAtTime).toHaveBeenCalledWith(nextGain, 1.25, 0.03);

    // Subsequent update must anchor to the previously applied gain (nextGain), NOT intrinsic param.value (4.0)
    const nextGain2 = withAgc.updateAutoGain(samples, 0.025);
    expect(nextGain2).toBeGreaterThan(nextGain);
    expect(setValueAtTime).toHaveBeenLastCalledWith(nextGain, 1.25);
    expect(setTargetAtTime).toHaveBeenLastCalledWith(nextGain2, 1.25, 0.03);
  });
});

describe('public/audio/pcm-capture-worklet.js', () => {
  it('emits ultrasonic Nyquist keepalive without mic loopback while active, and silences output when paused', () => {
    const workletPath = path.resolve(
      __dirname,
      '../../../public/audio/pcm-capture-worklet.js',
    );
    const code = fs.readFileSync(workletPath, 'utf8');

    const posted: Array<{ type: string; pcm: Float32Array; peaks: number[] }> = [];
    let RegisteredCtor:
      | (new (options?: { processorOptions?: { channels?: number } }) => {
          port: {
            onmessage?: (ev: { data: unknown }) => void;
            postMessage: (msg: unknown, transfer?: unknown[]) => void;
          };
          process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
        })
      | null = null;

    class MockAudioWorkletProcessor {
      port = {
        onmessage: undefined as ((ev: { data: unknown }) => void) | undefined,
        postMessage: vi.fn((msg: { type: string; pcm: Float32Array; peaks: number[] }) => {
          posted.push(msg);
        }),
      };
    }

    const sandbox = {
      AudioWorkletProcessor: MockAudioWorkletProcessor,
      sampleRate: 48000,
      Float32Array,
      Math,
      Boolean,
      registerProcessor: (_name: string, ctor: typeof RegisteredCtor) => {
        RegisteredCtor = ctor;
      },
    };
    vm.runInNewContext(code, sandbox);
    expect(RegisteredCtor).not.toBeNull();

    const proc = new RegisteredCtor!({ processorOptions: { channels: 1 } });
    const loudMicInput = new Float32Array(128).fill(0.85);
    const out = new Float32Array(128);

    // Process 10 render quanta (~26.7ms @ 48kHz -> triggers 1 flush of 1200 frames)
    for (let q = 0; q < 10; q += 1) {
      proc.process([[loudMicInput]], [[out]]);
      // Output must NEVER contain mic audio — only +/-1e-5 alternating Nyquist keepalive
      for (let i = 0; i < out.length; i += 1) {
        expect(Math.abs(out[i])).toBeCloseTo(KEEPALIVE_AMPLITUDE, 8);
        if (i > 0) {
          expect(Math.sign(out[i])).toBe(-Math.sign(out[i - 1]));
        }
      }
    }

    expect(posted.length).toBeGreaterThanOrEqual(1);
    expect(posted[0].type).toBe('chunk');
    expect(posted[0].pcm[0]).toBeCloseTo(0.85, 5);

    // Pausing silences the keepalive output immediately so hardware sink can sleep
    proc.port.onmessage?.({ data: { type: 'setActive', active: false } });
    out.fill(0.5);
    proc.process([[loudMicInput]], [[out]]);
    expect(Array.from(out).every((v) => v === 0)).toBe(true);
  });
});
