import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDbConnectionForTests } from '../../storage/db';
import { DEFAULT_AUDIO_QUALITY } from '../../storage/settings';
import { PcmTimeline } from '../pcmTimeline';
import { RecordingEngine } from '../recordingEngine';

describe('RecordingEngine.trimToPlayhead', () => {
  beforeEach(async () => {
    await resetDbConnectionForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('truncates audio at the scrubbed playhead, stays paused, and supports 1-step undo', async () => {
    const engine = new RecordingEngine('book-trim-test');
    const timeline = new PcmTimeline(1000, 1);
    timeline.appendFrames(new Float32Array(3000).fill(0.5)); // 3.0s

    // Seed internal paused state as if a 3s recording was paused
    const internals = engine as unknown as {
      timeline: PcmTimeline;
      phase: string;
      playheadMs: number;
    };
    internals.timeline = timeline;
    internals.phase = 'paused';
    internals.playheadMs = 3000;

    // Scrub back to 1.5s
    engine.seekToMs(1500);
    expect(engine.getSnapshot().playheadMs).toBe(1500);
    expect(engine.getSnapshot().durationMs).toBe(3000);

    // Stop here -> trims trailing 1.5s with undo available
    const trimmed = await engine.trimToPlayhead();
    expect(trimmed.trimmedMs).toBe(1500);
    expect(trimmed.newDurationMs).toBe(1500);

    const afterTrim = engine.getSnapshot();
    expect(afterTrim.phase).toBe('paused');
    expect(afterTrim.durationMs).toBe(1500);
    expect(afterTrim.playheadMs).toBe(1500);
    expect(afterTrim.canUndoTrim).toBe(true);

    // Undo restores original 3.0s duration cleanly
    const undone = await engine.undoLastTrim();
    expect(undone).toBe(true);
    const afterUndo = engine.getSnapshot();
    expect(afterUndo.durationMs).toBe(3000);
    expect(afterUndo.playheadMs).toBe(3000);
    expect(afterUndo.canUndoTrim).toBe(false);
  });

  it('configures playback latencyHint, aligns getUserMedia rate to AudioContext, attaches soft-clip ceiling, and routes unity keepalive gain', async () => {
    const createdCtxOptions: AudioContextOptions[] = [];
    const createdGains: Array<{ gain: { value: number }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
    let createdWaveShaper: { curve: Float32Array | null; oversample: string; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> } | null = null;
    const addModuleSpy = vi.fn().mockResolvedValue(undefined);
    let lastWorkletPort: { onmessage?: (ev: { data: unknown }) => void; postMessage: ReturnType<typeof vi.fn> } | null = null;

    class MockAudioContext {
      sampleRate = 48000;
      state: AudioContextState = 'running';
      destination = { kind: 'destination' };
      audioWorklet = { addModule: addModuleSpy };
      constructor(opts?: AudioContextOptions) {
        if (opts) createdCtxOptions.push(opts);
      }
      resume = vi.fn().mockResolvedValue(undefined);
      close = vi.fn().mockResolvedValue(undefined);
      createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
      createBiquadFilter = vi.fn(() => ({
        type: '',
        frequency: { value: 0 },
        Q: { value: 0 },
        connect: vi.fn(),
        disconnect: vi.fn(),
      }));
      createGain = vi.fn(() => {
        const g = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
        createdGains.push(g);
        return g;
      });
      createDynamicsCompressor = vi.fn(() => ({
        threshold: { value: 0 },
        knee: { value: 0 },
        ratio: { value: 0 },
        attack: { value: 0 },
        release: { value: 0 },
        connect: vi.fn(),
        disconnect: vi.fn(),
      }));
      createWaveShaper = vi.fn(() => {
        createdWaveShaper = {
          curve: null,
          oversample: 'none',
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
        return createdWaveShaper;
      });
    }

    class MockAudioWorkletNode {
      port = {
        onmessage: undefined as ((ev: { data: unknown }) => void) | undefined,
        postMessage: vi.fn(),
      };
      connect = vi.fn();
      disconnect = vi.fn();
      constructor() {
        lastWorkletPort = this.port;
      }
    }

    const fakeTrack = {
      label: 'Built-in Mic',
      stop: vi.fn(),
      getSettings: () => ({ deviceId: 'default', sampleRate: 48000, channelCount: 1 }),
    };
    const getUserMedia = vi.fn().mockResolvedValue({
      getTracks: () => [fakeTrack],
      getAudioTracks: () => [fakeTrack],
    });

    const originalMediaDevices = navigator.mediaDevices;
    vi.stubGlobal('AudioContext', MockAudioContext);
    vi.stubGlobal('AudioWorkletNode', MockAudioWorkletNode);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });

    try {
      const engine = new RecordingEngine('book-capture-stability');
      // Even when user selects 44.1 kHz export target, live capture aligns to AudioContext (48 kHz)
      await engine.startOrResumeFromEnd(
        { deviceId: 'default', deviceLabel: 'System Default Microphone' },
        { ...DEFAULT_AUDIO_QUALITY, sampleRate: 44100, softLimiter: true },
        false,
      );

      expect(createdCtxOptions[0]).toEqual({ latencyHint: 'playback' });
      expect(getUserMedia).toHaveBeenCalledWith({
        audio: expect.objectContaining({
          sampleRate: { ideal: 48000 },
        }),
      });
      expect(createdWaveShaper).not.toBeNull();
      expect(createdWaveShaper!.oversample).toBe('2x');
      // Last GainNode is the worklet keepalive output gain — must be 1 (not 0!) to defeat SilentSinkSuspender
      const workletOutputGain = createdGains[createdGains.length - 1];
      expect(workletOutputGain.gain.value).toBe(1);

      // Feed a chunk, pause, verify tail fade-out was applied cleanly
      lastWorkletPort!.onmessage?.({
        data: {
          type: 'chunk',
          pcm: new Float32Array(2400).fill(0.6), // 50ms @ 48kHz
          peaks: [0.6, 0.6],
          liveLevel: 0.6,
        },
      });
      await engine.pause();
      const internals = engine as unknown as { timeline: PcmTimeline };
      const [samples] = internals.timeline.extractChannelData();
      expect(samples[0]).toBeCloseTo(0.6, 5);
      expect(samples[samples.length - 1]).toBeCloseTo(0, 5);

      await engine.dispose();
    } finally {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: originalMediaDevices,
      });
    }
  });
});
