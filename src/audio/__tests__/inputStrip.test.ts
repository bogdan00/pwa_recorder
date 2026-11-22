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

  it('SoftwareAutoGainController boosts quiet raw iPhone speech, yields to limiter compression, holds steady during silence, and tames loud shouts', () => {
    const agc = new SoftwareAutoGainController();
    expect(agc.getGain()).toBe(SOFTWARE_AGC_INITIAL_GAIN); // +10 dB starting boost (3.16x)

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

    // 2. Quiet iPhone speech (~-41 dBFS raw RMS = 0.009) -> smoothly boosts toward -21 dBFS (~10x max)
    const quietSpeechChunk = new Float32Array(1200);
    for (let step = 0; step < 120; step += 1) {
      const g = agc.getGain();
      for (let i = 0; i < quietSpeechChunk.length; i += 1) {
        quietSpeechChunk[i] = 0.009 * Math.SQRT2 * g * Math.sin((i / 48) * Math.PI * 2);
      }
      agc.processSamples(quietSpeechChunk, 0.025);
    }
    expect(agc.getGain()).toBeGreaterThan(8.5);
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

    // 4. Active limiter gain reduction (-4 dB) forces AGC to back off even when post-limiter RMS looks moderate
    const moderatePostLimiter = new Float32Array(1200).fill(0.08);
    const beforeReduction = agc.getGain();
    const afterReduction = agc.processSamples(moderatePostLimiter, 0.025, -4.0);
    expect(afterReduction).toBeLessThan(beforeReduction);

    // 5. Sudden loud speech near mic (raw peak = 0.45, limited at -1 dBFS = 0.89) -> fast attack pulls gain down
    const loudChunk = new Float32Array(1200);
    for (let step = 0; step < 30; step += 1) {
      const g = agc.getGain();
      for (let i = 0; i < loudChunk.length; i += 1) {
        const raw = 0.45 * Math.sin((i / 48) * Math.PI * 2);
        loudChunk[i] = softLimitSample(raw * g);
      }
      agc.processSamples(loudChunk, 0.025);
    }
    expect(agc.getGain()).toBeLessThan(2.0);
  });

  it('buildStudioInputStrip applies discrete mono channel config, transparent vocal limiter, and auto-plumbs compressor.reduction into AGC', () => {
    const order: string[] = [];
    const createdNodes: Array<{
      kind: string;
      channelCount?: number;
      channelCountMode?: string;
      channelInterpretation?: string;
    }> = [];
    const setTargetAtTime = vi.fn();
    const cancelScheduledValues = vi.fn();
    const setValueAtTime = vi.fn();
    let compReduction = 0;
    let createdComp: {
      threshold: { value: number };
      knee: { value: number };
      ratio: { value: number };
      attack: { value: number };
      release: { value: number };
    } | null = null;

    const mockCtx = {
      currentTime: 1.25,
      createBiquadFilter: () => {
        order.push('hpf');
        const node = {
          kind: 'hpf',
          type: '',
          frequency: { value: 0 },
          Q: { value: 0 },
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
        createdNodes.push(node);
        return node;
      },
      createGain: () => {
        order.push('gain');
        const node = {
          kind: 'gain',
          gain: { value: 1, setTargetAtTime, cancelScheduledValues, setValueAtTime },
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
        createdNodes.push(node);
        return node;
      },
      createDynamicsCompressor: () => {
        order.push('comp');
        const node = {
          kind: 'comp',
          threshold: { value: 0 },
          knee: { value: 0 },
          ratio: { value: 0 },
          attack: { value: 0 },
          release: { value: 0 },
          get reduction() {
            return compReduction;
          },
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
        createdComp = node;
        createdNodes.push(node);
        return node;
      },
      createWaveShaper: () => {
        order.push('shaper');
        const node = {
          kind: 'shaper',
          curve: null,
          oversample: 'none',
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
        createdNodes.push(node);
        return node;
      },
    } as unknown as AudioContext;
    const mockSource = { connect: vi.fn(), disconnect: vi.fn() } as unknown as AudioNode;

    const withoutAgc = buildStudioInputStrip(mockCtx, mockSource, DEFAULT_AUDIO_QUALITY, {
      channels: 1,
    });
    expect(withoutAgc.autoGainNode).toBeNull();
    expect(withoutAgc.compressorNode).not.toBeNull();
    expect(order).toEqual(['hpf', 'gain', 'comp', 'shaper']);
    // Transparent vocal limiter params (-3 dBFS / 6 dB knee / 4:1 / 5 ms / 120 ms)
    expect(createdComp!.threshold.value).toBe(-3);
    expect(createdComp!.knee.value).toBe(6);
    expect(createdComp!.ratio.value).toBe(4);
    expect(createdComp!.attack.value).toBe(0.005);
    expect(createdComp!.release.value).toBe(0.12);
    // Every strip node enforces discrete mono channel extraction so (L, 0) never halves to -6 dB
    for (const n of createdNodes) {
      expect(n.channelCount).toBe(1);
      expect(n.channelCountMode).toBe('explicit');
      expect(n.channelInterpretation).toBe('discrete');
    }

    order.length = 0;
    const withAgc = buildStudioInputStrip(mockCtx, mockSource, DEFAULT_AUDIO_QUALITY, {
      enableSoftwareAgc: true,
      channels: 1,
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

    // Subsequent update anchors to previously applied gain (nextGain)
    const nextGain2 = withAgc.updateAutoGain(samples, 0.025);
    expect(nextGain2).toBeGreaterThan(nextGain);
    expect(setValueAtTime).toHaveBeenLastCalledWith(nextGain, 1.25);
    expect(setTargetAtTime).toHaveBeenLastCalledWith(nextGain2, 1.25, 0.03);

    // When DynamicsCompressorNode reports active limiting (-4.5 dB), updateAutoGain backs off
    compReduction = -4.5;
    const backedOff = withAgc.updateAutoGain(samples, 0.025);
    expect(backedOff).toBeLessThan(nextGain2);
  });

  it('PcmInputStripProcessor applies 80 Hz HPF, inputGain, transparent limiter, and soft-clip ceiling cleanly', async () => {
    const { PcmInputStripProcessor } = await import('../inputStrip');
    const strip = new PcmInputStripProcessor(48000, 1, {
      ...DEFAULT_AUDIO_QUALITY,
      highPassFilter: true,
      softLimiter: true,
      inputGain: 1.0,
    }, false);

    // 1. DC / sub-20Hz rumble is attenuated by the 80 Hz high-pass filter
    const dcBuf = new Float32Array(4800).fill(0.5);
    strip.processBlock([dcBuf], dcBuf.length);
    expect(Math.abs(dcBuf[dcBuf.length - 1])).toBeLessThan(0.01);

    // 2. Normal 440 Hz sine passes transparently near unity gain
    const sine = new Float32Array(4800);
    for (let i = 0; i < sine.length; i += 1) {
      sine[i] = 0.25 * Math.sin((2 * Math.PI * 440 * i) / 48000);
    }
    strip.processBlock([sine], sine.length);
    let maxMid = 0;
    for (let i = 2400; i < sine.length; i += 1) {
      maxMid = Math.max(maxMid, Math.abs(sine[i]));
    }
    expect(maxMid).toBeGreaterThan(0.22);
    expect(maxMid).toBeLessThan(0.28);

    // 3. Extreme overload (+12 dB peak = 4.0) is smoothly bounded below SOFT_CLIP_CEILING (-1 dBFS)
    const hot = new Float32Array(1200);
    for (let i = 0; i < hot.length; i += 1) {
      hot[i] = 4.0 * Math.sin((2 * Math.PI * 440 * i) / 48000);
    }
    const res = strip.processBlock([hot], hot.length);
    let maxHot = 0;
    for (let i = 0; i < hot.length; i += 1) {
      maxHot = Math.max(maxHot, Math.abs(hot[i]));
    }
    expect(maxHot).toBeLessThanOrEqual(Math.fround(SOFT_CLIP_CEILING));
    expect(res.reductionDb).toBeLessThan(0);
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
