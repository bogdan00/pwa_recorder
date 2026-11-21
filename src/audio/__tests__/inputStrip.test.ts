import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  applyPeakCeilingToChannels,
  buildSoftClipCurve,
  KEEPALIVE_AMPLITUDE,
  SOFT_CLIP_CEILING,
  SOFT_CLIP_THRESHOLD,
  softLimitSample,
  writeNyquistKeepalive,
} from '../inputStrip';

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
