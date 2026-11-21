import { afterEach, describe, expect, it, vi } from 'vitest';
import { AbComparePlayer } from '../abComparePlayer';
import type { DecodedPcmAudio } from '../audioExporter';

interface MockSourceNode {
  buffer: AudioBuffer | null;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  onended: (() => void) | null;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

function makeTestPcm(durationSec: number, sampleRate = 1000): DecodedPcmAudio {
  const frames = Math.round(durationSec * sampleRate);
  return {
    sampleRate,
    channels: [new Float32Array(frames).fill(0.25)],
    durationMs: durationSec * 1000,
    bitDepth: 32,
  };
}

function installMockAudioContext(opts?: {
  initialState?: AudioContextState;
  resumePromiseFactory?: () => Promise<void>;
}) {
  const sources: MockSourceNode[] = [];
  let ctxInstance: MockAudioContext | null = null;

  class MockAudioContext {
    currentTime = 0;
    state: AudioContextState = opts?.initialState ?? 'running';
    destination = { kind: 'destination' };
    resume = vi.fn(() => {
      if (opts?.resumePromiseFactory) {
        return opts.resumePromiseFactory().then(() => {
          this.state = 'running';
        });
      }
      this.state = 'running';
      return Promise.resolve();
    });
    close = vi.fn().mockResolvedValue(undefined);

    constructor() {
      ctxInstance = this;
    }

    createBuffer(numChannels: number, numFrames: number, sampleRate: number) {
      const channels = Array.from(
        { length: numChannels },
        () => new Float32Array(numFrames),
      );
      return {
        numberOfChannels: numChannels,
        length: numFrames,
        sampleRate,
        duration: numFrames / sampleRate,
        copyToChannel: (src: Float32Array, ch: number) => {
          channels[ch].set(src);
        },
      } as unknown as AudioBuffer;
    }

    createBufferSource() {
      const node: MockSourceNode = {
        buffer: null,
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        onended: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      sources.push(node);
      return node as unknown as AudioBufferSourceNode;
    }

    createGain() {
      return {
        gain: {
          value: 1,
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
      } as unknown as GainNode;
    }
  }

  vi.stubGlobal('AudioContext', MockAudioContext);
  return {
    getCtx: () => ctxInstance!,
    sources,
  };
}

describe('AbComparePlayer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('toggles Play/Pause on the same sample and resumes from the paused offset', async () => {
    const { getCtx, sources } = installMockAudioContext();
    const player = new AbComparePlayer();
    player.loadBuffers(makeTestPcm(10), makeTestPcm(10));

    expect(player.getIsPlaying()).toBe(false);
    expect(player.getActiveSlot()).toBeNull();
    expect(player.getDurationSec()).toBe(10);

    // 1. Start Master from 0:00
    const playing1 = await player.toggle('master');
    expect(playing1).toBe(true);
    expect(player.getIsPlaying()).toBe(true);
    expect(player.getActiveSlot()).toBe('master');
    expect(sources).toHaveLength(1);
    expect(sources[0].start).toHaveBeenCalledWith(0.01, 0);

    // Advance AudioContext clock to 3.21s (3.20s after startAt=0.01)
    getCtx().currentTime = 3.21;
    expect(player.getCurrentTimeSec()).toBeCloseTo(3.2, 4);

    // 2. Toggle Master again -> pauses at 3.20s and stops audio source
    const playing2 = await player.toggle('master');
    expect(playing2).toBe(false);
    expect(player.getIsPlaying()).toBe(false);
    expect(player.getActiveSlot()).toBe('master');
    expect(player.getCurrentTimeSec()).toBeCloseTo(3.2, 4);
    expect(sources[0].stop).toHaveBeenCalledTimes(1);

    // 3. Toggle Master again -> resumes from 3.20s
    getCtx().currentTime = 5.0;
    const playing3 = await player.toggle('master');
    expect(playing3).toBe(true);
    expect(player.getIsPlaying()).toBe(true);
    expect(sources).toHaveLength(2);
    expect(sources[1].start).toHaveBeenCalledWith(5.01, expect.closeTo(3.2, 4));

    player.dispose();
  });

  it('stops the first sample and replays the second sample from 0:00 when switching (whether playing or paused)', async () => {
    const { getCtx, sources } = installMockAudioContext();
    const player = new AbComparePlayer();
    player.loadBuffers(makeTestPcm(10), makeTestPcm(10));

    // Start Master and advance to 4.0s
    await player.toggle('master');
    getCtx().currentTime = 4.01;
    expect(player.getCurrentTimeSec()).toBeCloseTo(4.0, 4);

    // Switch directly to Candidate while Master is playing -> stops Master and starts Candidate at 0:00
    await player.toggle('candidate');
    expect(sources[0].stop).toHaveBeenCalledTimes(1);
    expect(sources).toHaveLength(2);
    expect(sources[1].start).toHaveBeenCalledWith(4.02, 0);
    expect(player.getIsPlaying()).toBe(true);
    expect(player.getActiveSlot()).toBe('candidate');
    expect(player.getCurrentTimeSec()).toBe(0);

    // Advance Candidate to 2.5s and pause it
    getCtx().currentTime = 6.52;
    await player.toggle('candidate');
    expect(player.getIsPlaying()).toBe(false);
    expect(player.getCurrentTimeSec()).toBeCloseTo(2.5, 4);

    // Now tap Master while Candidate is paused -> starts Master from 0:00 (not 2.5s!)
    await player.toggle('master');
    expect(sources).toHaveLength(3);
    expect(sources[2].start).toHaveBeenCalledWith(expect.closeTo(6.53, 4), 0);
    expect(player.getIsPlaying()).toBe(true);
    expect(player.getActiveSlot()).toBe('master');
    expect(player.getCurrentTimeSec()).toBe(0);

    player.dispose();
  });

  it('drops superseded async play calls when switching samples during AudioContext.resume()', async () => {
    const firstResume: { resolve: (() => void) | null } = { resolve: null };
    let resumeCount = 0;
    const { sources } = installMockAudioContext({
      initialState: 'suspended',
      resumePromiseFactory: () => {
        resumeCount += 1;
        if (resumeCount === 1) {
          return new Promise<void>((resolve) => {
            firstResume.resolve = resolve;
          });
        }
        return Promise.resolve();
      },
    });

    const player = new AbComparePlayer();
    player.loadBuffers(makeTestPcm(8), makeTestPcm(8));

    const firstPlay = player.play('master');
    const secondPlay = player.play('candidate');
    await secondPlay;

    // Now resolve the stale first resume promise — it must NOT spawn a leaked source
    firstResume.resolve?.();
    await firstPlay;

    expect(sources).toHaveLength(1);
    expect(player.getActiveSlot()).toBe('candidate');
    expect(player.getIsPlaying()).toBe(true);

    player.dispose();
  });
});
