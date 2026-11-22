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

  it('configures interactive low-latency AudioContext, aligns getUserMedia rate, attaches lightweight soft-clip ceiling, and routes unity keepalive gain', async () => {
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
          oversample: '2x',
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

      expect(createdCtxOptions[0]).toEqual({ latencyHint: 'interactive' });
      expect(getUserMedia).toHaveBeenCalledWith({
        audio: expect.objectContaining({
          sampleRate: { ideal: 48000 },
        }),
      });
      expect(createdWaveShaper).not.toBeNull();
      expect(createdWaveShaper!.oversample).toBe('none');
      // Because mock mediaDevices omits autoGainControl support (like iOS Safari),
      // RecordingEngine engages software AGC (+10 dB initial = 3.16x) ahead of the limiter:
      // createdGains = [manualInputGain (1), softwareAgcGain (3.16), workletOutputGain (1)]
      expect(createdGains).toHaveLength(3);
      expect(createdGains[0].gain.value).toBe(1);
      expect(createdGains[1].gain.value).toBeCloseTo(3.16, 2);
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
      // Loud 0.6 chunk should pull software AGC down cleanly from initial 3.16x
      expect(createdGains[1].gain.value).toBeLessThan(3.16);
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

  it('uses MediaStreamTrackProcessor without creating/running an output AudioContext and accumulates take-wide lastRecordingPerf across pause/resume', async () => {
    const { getLastRecordingPerfSnapshot } = await import('../recordingPerfTelemetry');
    let audioCtxCreated = 0;

    class MockAudioContext {
      sampleRate = 48000;
      state: AudioContextState = 'running';
      currentTime = 0;
      destination = { kind: 'destination' };
      resume = vi.fn().mockImplementation(async () => {
        this.state = 'running';
      });
      suspend = vi.fn().mockImplementation(async () => {
        this.state = 'suspended';
      });
      close = vi.fn().mockImplementation(async () => {
        this.state = 'closed';
      });
      constructor() {
        audioCtxCreated += 1;
      }
      createBuffer = vi.fn(() => ({
        numberOfChannels: 1,
        length: 960,
        sampleRate: 48000,
        copyToChannel: vi.fn(),
      }));
      createBufferSource = vi.fn(() => ({
        buffer: null as unknown,
        onended: null as (() => void) | null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      }));
    }

    const makeFrame = (tsUs: number) => ({
      format: 'f32-planar',
      sampleRate: 48000,
      numberOfFrames: 480,
      numberOfChannels: 1,
      timestamp: tsUs,
      duration: 10_000,
      copyTo: (dest: BufferSource) => {
        const out =
          dest instanceof Float32Array
            ? dest
            : new Float32Array(
                (dest as ArrayBufferView).buffer,
                (dest as ArrayBufferView).byteOffset,
                (dest as ArrayBufferView).byteLength / 4,
              );
        for (let i = 0; i < out.length; i += 1) {
          out[i] = 0.25 * Math.sin((2 * Math.PI * 440 * i) / 48000);
        }
      },
      close: vi.fn(),
    });

    let controllerRef: ReadableStreamDefaultController<ReturnType<typeof makeFrame>> | null = null;
    class MockMSTP {
      readable: ReadableStream<ReturnType<typeof makeFrame>>;
      discardedFrames = 0;
      constructor() {
        this.readable = new ReadableStream({
          start(c) {
            controllerRef = c;
          },
        });
      }
    }

    const fakeTrack = {
      kind: 'audio',
      label: 'Android Built-in Mic',
      stop: vi.fn(),
      getSettings: () => ({
        deviceId: 'default',
        sampleRate: 48000,
        channelCount: 1,
        autoGainControl: true,
        echoCancellation: false,
      }),
    };
    const getUserMedia = vi.fn().mockResolvedValue({
      getTracks: () => [fakeTrack],
      getAudioTracks: () => [fakeTrack],
    });

    const originalMediaDevices = navigator.mediaDevices;
    vi.stubGlobal('AudioContext', MockAudioContext);
    vi.stubGlobal('MediaStreamTrackProcessor', MockMSTP);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia,
        getSupportedConstraints: () => ({
          autoGainControl: true,
          echoCancellation: true,
          sampleRate: true,
          channelCount: true,
        }),
      },
    });

    try {
      const engine = new RecordingEngine('book-tp-perf');
      await engine.startOrResumeFromEnd(
        { deviceId: 'default', deviceLabel: 'System Default Microphone' },
        DEFAULT_AUDIO_QUALITY,
        false,
      );

      // Zero duplex output AudioContext created during pure TrackProcessor recording!
      expect(audioCtxCreated).toBe(0);
      expect(engine.getCaptureBackendDiagnostics()).toMatchObject({
        trackProcessorActive: true,
        workletActive: false,
        scriptProcessorActive: false,
        outputCtxRunning: false,
      });

      // Push 2 frames (20ms = 1 chunk)
      controllerRef!.enqueue(makeFrame(0));
      controllerRef!.enqueue(makeFrame(10_000));
      await vi.waitFor(() => {
        expect(engine.getSnapshot().durationMs).toBeGreaterThanOrEqual(20);
      });

      await engine.pause();
      const perf1 = getLastRecordingPerfSnapshot();
      expect(perf1?.captureMode).toBe('trackProcessor');
      expect(perf1?.takeSegments).toBe(1);
      expect(perf1?.chunkCount).toBe(1);

      // Start preview playback (creates & runs output AudioContext), then resume recording -> must suspend AudioContext!
      await engine.playPreviewFromPlayhead();
      expect(audioCtxCreated).toBe(1);
      expect(engine.getCaptureBackendDiagnostics().outputCtxRunning).toBe(true);

      await engine.startOrResumeFromEnd(
        { deviceId: 'default', deviceLabel: 'System Default Microphone' },
        DEFAULT_AUDIO_QUALITY,
        false,
      );
      expect(engine.getCaptureBackendDiagnostics()).toMatchObject({
        trackProcessorActive: true,
        workletActive: false,
        scriptProcessorActive: false,
        outputCtxRunning: false,
      });

      // Push 2 more frames in segment 2
      controllerRef!.enqueue(makeFrame(0));
      controllerRef!.enqueue(makeFrame(10_000));
      await vi.waitFor(() => {
        expect(engine.getSnapshot().durationMs).toBeGreaterThanOrEqual(40);
      });

      await engine.pause();
      const perf2 = getLastRecordingPerfSnapshot();
      expect(perf2?.captureMode).toBe('trackProcessor');
      expect(perf2?.takeSegments).toBe(2);
      expect(perf2?.chunkCount).toBe(2);
      expect(perf2?.deviceLabel).toBe('Android Built-in Mic');
      expect(perf2?.nativeAgcActive).toBe(true);
      expect(perf2?.trackSettings).toEqual(
        expect.objectContaining({ sampleRate: 48000, channelCount: 1, autoGainControl: true }),
      );

      await engine.dispose();
    } finally {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: originalMediaDevices,
      });
    }
  });

  it('transitions to paused immediately on pause(), detaches worklet onmessage, and ignores late chunks', async () => {
    const engine = new RecordingEngine('book-pause-test');
    const timeline = new PcmTimeline(1000, 1);
    const phases: string[] = [];
    engine.subscribe((s) => phases.push(s.phase));

    let disconnected = false;
    const port = {
      onmessage: (() => {}) as ((ev: MessageEvent) => void) | null,
      postMessage: () => {},
    };
    const fakeWorklet = {
      port,
      disconnect: () => {
        disconnected = true;
      },
    };

    const internals = engine as unknown as {
      draftId: string;
      timeline: PcmTimeline;
      phase: string;
      workletNode: unknown;
      ingestCapturedChunk: (buf: Float32Array, peaks: number[], level: number) => void;
    };
    internals.draftId = 'draft-pause-test';
    internals.timeline = timeline;
    internals.phase = 'recording';
    internals.workletNode = fakeWorklet;

    internals.ingestCapturedChunk(new Float32Array(500).fill(0.4), [0.4], 0.4);
    expect(engine.getSnapshot().durationMs).toBe(500);

    // Pause should transition synchronously before awaiting IndexedDB flush
    const pausePromise = engine.pause();
    expect(engine.getSnapshot().phase).toBe('paused');
    expect(phases[phases.length - 1]).toBe('paused');
    expect(port.onmessage).toBeNull();
    expect(disconnected).toBe(true);

    // Late queued PCM chunk arriving after pause must be ignored
    internals.ingestCapturedChunk(new Float32Array(500).fill(0.8), [0.8], 0.8);
    expect(engine.getSnapshot().durationMs).toBe(500);

    await pausePromise;
    expect(engine.getSnapshot().phase).toBe('paused');
  });

  it('serializes discard() draft deletion after any in-flight chunk flush so deleted drafts never resurrect', async () => {
    const { getDraft } = await import('../../storage/db');
    const engine = new RecordingEngine('book-discard-race');
    const timeline = new PcmTimeline(1000, 1);

    const internals = engine as unknown as {
      draftId: string;
      timeline: PcmTimeline;
      phase: string;
      ingestCapturedChunk: (buf: Float32Array, peaks: number[], level: number) => void;
    };
    internals.draftId = 'draft-discard-race';
    internals.timeline = timeline;
    internals.phase = 'recording';

    // Exceed 5-second flush threshold to kick off an async IndexedDB draft write
    internals.ingestCapturedChunk(new Float32Array(5000).fill(0.3), [0.3], 0.3);

    // Immediately discard before the background flush resolves
    await engine.discard();

    // Draft must remain deleted after the serialized queue drains
    const persisted = await getDraft('draft-discard-race');
    expect(persisted).toBeUndefined();
  });

  it('starts preview playback from 00:00.0 when paused at the end of a recording, and from the scrubbed position when scrubbed back', async () => {
    const createdBuffers: Array<{ length: number; sampleRate: number }> = [];

    class MockAudioContext {
      sampleRate = 1000;
      state: AudioContextState = 'running';
      currentTime = 0;
      destination = { kind: 'destination' };
      resume = vi.fn().mockResolvedValue(undefined);
      close = vi.fn().mockResolvedValue(undefined);
      createBuffer = vi.fn((channels: number, length: number, sampleRate: number) => {
        createdBuffers.push({ length, sampleRate });
        return {
          numberOfChannels: channels,
          length,
          sampleRate,
          copyToChannel: vi.fn(),
        };
      });
      createBufferSource = vi.fn(() => ({
        buffer: null as unknown,
        onended: null as (() => void) | null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      }));
    }

    vi.stubGlobal('AudioContext', MockAudioContext);
    try {
      const engine = new RecordingEngine('book-preview-from-start');
      // 6.5 seconds of recorded audio (> 5s so any 5s rewind heuristic would land at 1.5s, NOT 0s)
      const timeline = new PcmTimeline(1000, 1);
      timeline.appendFrames(new Float32Array(6500).fill(0.25), []);

      const internals = engine as unknown as {
        draftId: string;
        timeline: PcmTimeline;
        phase: string;
        playheadMs: number;
      };
      internals.draftId = 'draft-preview-from-start';
      internals.timeline = timeline;
      internals.phase = 'paused';
      internals.playheadMs = 6500;

      // 1. Tapping Play while paused at the end must restart at 0 ms (full 6500 frames)
      await engine.playPreviewFromPlayhead();
      expect(engine.getSnapshot().phase).toBe('playing');
      expect(engine.getSnapshot().playheadMs).toBe(0);
      expect(createdBuffers[0]).toEqual({ length: 6500, sampleRate: 1000 });

      // 2. Scrubbing back to 2500 ms and tapping Play must play from 2500 ms (4000 remaining frames)
      engine.pausePreview();
      engine.seekToMs(2500);
      await engine.playPreviewFromPlayhead();
      expect(engine.getSnapshot().phase).toBe('playing');
      expect(engine.getSnapshot().playheadMs).toBe(2500);
      expect(createdBuffers[1]).toEqual({ length: 4000, sampleRate: 1000 });

      await engine.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
