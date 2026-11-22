/**
 * Tier 1 Formal Verification: Recording Studio Explicit-State BFS Model Check
 * & Automated Positive + Negative Conformance against real `RecordingEngine`.
 *
 * Runs on every `npm test` (~<1s, zero WASM overhead).
 * Verifies:
 *   1. Exhaustive BFS exploration over 100% of reachable Studio states:
 *      - All 12 safety invariants (□ I) from shared `STUDIO_INVARIANT_IR`
 *      - All 6 reachability goals (◇ G) proving non-vacuity
 *   2. Automated Positive + Negative Differential Conformance (`verifyConformance`):
 *      - Replays BFS-harvested maximal traces covering 100% of reachable Studio states
 *        directly against the real `RecordingEngine` class (including exact `undoDuration`!)
 *      - Probes EVERY disabled action (e.g. `seek_start` during `recording`, `pause` during
 *        `idle`, `play_preview` when empty, `undo_trim` without snapshot) to prove production
 *        guards really reject illegal transitions as strict no-ops!
 *   3. Async Cancellation Safety: proves `discard()`/`pause()` mid-`await acquireMicStream`
 *      stops the late-arriving MediaStream track and never enters `'recording'`.
 *   4. IEEE-754 boundary safety for `seekToMs(NaN / ±Infinity / out-of-range)`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecordingEngine } from '../../audio/recordingEngine';
import { resetDbConnectionForTests } from '../../storage/db';
import { DEFAULT_AUDIO_QUALITY } from '../../storage/settings';
import { modelCheck, verifyConformance } from '../core/modelChecker';
import {
  createStudioLts,
  type StudioAction,
  type StudioFormalState,
} from '../specs/studioStateMachineSpec';

interface MockAudioHarness {
  emitChunk: (durationSec: number) => Promise<void>;
  advancePreviewClockSec: (deltaSec: number) => void;
  triggerPreviewEnded: () => void;
  isMicStreamActive: () => boolean;
  isPreviewNodeActive: () => boolean;
  useTrackProcessor: boolean;
  cleanup: () => void;
}

function installDeterministicAudioHarness(useTrackProcessor = false): MockAudioHarness {
  const SAMPLE_RATE = 1000; // 1000 Hz => 1000 frames === 1000 ms (exact integer math!)
  let activeTrackStopped = true;
  let lastCtx: { currentTime: number } | null = null;
  let lastWorkletPort: {
    onmessage?: (ev: { data: unknown }) => void;
    postMessage: ReturnType<typeof vi.fn>;
  } | null = null;
  let lastTrackController: ReadableStreamDefaultController<unknown> | null = null;
  let timestampUs = 0;
  let activePreviewSource: {
    onended: (() => void) | null;
    stop: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  } | null = null;

  class MockAudioContext {
    sampleRate = SAMPLE_RATE;
    currentTime = 0;
    state: AudioContextState = 'running';
    destination = { kind: 'destination' };
    audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
    constructor() {
      lastCtx = this;
    }
    resume = vi.fn(async () => {
      this.state = 'running';
    });
    suspend = vi.fn(async () => {
      this.state = 'suspended';
    });
    close = vi.fn(async () => {
      this.state = 'closed';
    });
    createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
    createBiquadFilter = vi.fn(() => ({
      type: '',
      frequency: { value: 0 },
      Q: { value: 0 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    }));
    createGain = vi.fn(() => ({
      gain: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    }));
    createDynamicsCompressor = vi.fn(() => ({
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 0 },
      attack: { value: 0 },
      release: { value: 0 },
      reduction: 0,
      connect: vi.fn(),
      disconnect: vi.fn(),
    }));
    createWaveShaper = vi.fn(() => ({
      curve: null,
      oversample: 'none',
      connect: vi.fn(),
      disconnect: vi.fn(),
    }));
    createBuffer = vi.fn((channels: number, length: number, sampleRate: number) => ({
      numberOfChannels: channels,
      length,
      sampleRate,
      copyToChannel: vi.fn(),
    }));
    createBufferSource = vi.fn(() => {
      const src = {
        buffer: null as unknown,
        onended: null as (() => void) | null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(() => {
          activePreviewSource = src;
        }),
        stop: vi.fn(() => {
          if (activePreviewSource === src) activePreviewSource = null;
        }),
      };
      return src;
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

  class MockMediaStreamTrackProcessor {
    readable: ReadableStream<unknown>;
    discardedFrames = 0;
    constructor() {
      this.readable = new ReadableStream({
        start(controller) {
          lastTrackController = controller;
        },
        cancel() {
          lastTrackController = null;
        },
      });
    }
  }

  const getUserMedia = vi.fn().mockImplementation(async () => {
    activeTrackStopped = false;
    const track = {
      kind: 'audio',
      label: 'Formal Test Mic',
      readyState: 'live',
      stop: vi.fn(() => {
        activeTrackStopped = true;
        track.readyState = 'ended';
      }),
      getSettings: () => ({
        deviceId: 'default',
        sampleRate: SAMPLE_RATE,
        channelCount: 1,
      }),
    };
    return {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    };
  });

  const originalMediaDevices = navigator.mediaDevices;
  vi.stubGlobal('AudioContext', MockAudioContext);
  vi.stubGlobal('AudioWorkletNode', MockAudioWorkletNode);
  if (useTrackProcessor) {
    vi.stubGlobal('MediaStreamTrackProcessor', MockMediaStreamTrackProcessor);
  } else {
    vi.stubGlobal('MediaStreamTrackProcessor', undefined);
  }
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });

  return {
    useTrackProcessor,
    async emitChunk(durationSec: number) {
      const frames = Math.round(durationSec * SAMPLE_RATE);
      if (useTrackProcessor) {
        const durUs = Math.round(durationSec * 1_000_000);
        const startUs = timestampUs;
        timestampUs += durUs;
        const audioData = {
          format: 'f32-planar',
          sampleRate: SAMPLE_RATE,
          numberOfFrames: frames,
          numberOfChannels: 1,
          timestamp: startUs,
          duration: durUs,
          copyTo(dest: Float32Array) {
            dest.fill(0.4);
          },
          close: vi.fn(),
        };
        lastTrackController?.enqueue(audioData);
        for (let i = 0; i < 6; i += 1) {
          await Promise.resolve();
        }
        return;
      }
      const pcm = new Float32Array(frames).fill(0.4);
      lastWorkletPort?.onmessage?.({
        data: {
          type: 'chunk',
          pcm: pcm.buffer,
          peaks: Array.from({ length: Math.round(durationSec * 50) }, () => 0.4),
          liveLevel: 0.4,
        },
      });
    },
    advancePreviewClockSec(deltaSec: number) {
      if (lastCtx) lastCtx.currentTime += deltaSec;
    },
    triggerPreviewEnded() {
      const src = activePreviewSource;
      activePreviewSource = null;
      src?.onended?.();
    },
    isMicStreamActive: () => !activeTrackStopped,
    isPreviewNodeActive: () => activePreviewSource !== null,
    cleanup() {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: originalMediaDevices,
      });
      vi.unstubAllGlobals();
    },
  };
}

/**
 * Abstraction function α(realEngine) -> StudioFormalState
 * Includes exact inspection of the real timeline's undo snapshot duration AND capture backend state!
 */
function abstractEngineState(
  engine: RecordingEngine,
  harness: MockAudioHarness,
): StudioFormalState {
  const snap = engine.getSnapshot();
  const live = engine.getLiveRenderState();
  const diag = engine.getCaptureBackendDiagnostics();
  const internals = engine as unknown as {
    timeline: {
      sampleRate: number;
      undoSnapshot: { totalFrames: number } | null;
    } | null;
  };
  const undoFrames = internals.timeline?.undoSnapshot?.totalFrames ?? 0;
  const undoRate = internals.timeline?.sampleRate ?? 1000;
  const undoDuration = snap.canUndoTrim ? Math.round(undoFrames / undoRate) : 0;

  return {
    phase: snap.phase,
    duration: Math.round(snap.durationMs / 1000),
    playhead: Math.round(live.playheadMs / 1000),
    micActive: harness.isMicStreamActive(),
    useTrackProcessor: harness.useTrackProcessor,
    trackProcessorActive: diag.trackProcessorActive,
    workletActive: diag.workletActive,
    outputCtxRunning: diag.outputCtxRunning,
    previewActive: harness.isPreviewNodeActive(),
    canUndoTrim: snap.canUndoTrim,
    undoDuration,
    hasDraft: snap.draftId !== null,
  };
}

describe('Tier 1 Formal Proofs: Recording Studio State Machine & Automated Conformance', () => {
  beforeEach(async () => {
    await resetDbConnectionForTests();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('storytape-db');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exhaustively BFS model-checks 100% of reachable Studio states across BOTH TrackProcessor and AudioWorklet modes', () => {
    const lts = createStudioLts(3);
    const cert = modelCheck(lts);

    expect(cert.statesExplored).toBeGreaterThan(50);
    expect(cert.transitionsExplored).toBeGreaterThan(300);
    expect(cert.reachedGoals).toHaveLength(6);
  });

  for (const useTrackProcessor of [false, true]) {
    it(`automatically verifies positive + negative conformance of real RecordingEngine across 100% of BFS-reachable states (${useTrackProcessor ? 'MediaStreamTrackProcessor / Chromium' : 'AudioWorklet / Safari-Firefox'})`, async () => {
      const lts = createStudioLts(2, useTrackProcessor);
      const cert = modelCheck(lts);

      const harness = installDeterministicAudioHarness(useTrackProcessor);
      const device = { deviceId: 'default', deviceLabel: 'Formal Test Mic' };
      const quality = {
        ...DEFAULT_AUDIO_QUALITY,
        format: 'wav' as const,
        channels: 1 as const,
        sampleRate: 1000 as 44100,
      };
      let traceCounter = 0;

      try {
        const conf = await verifyConformance<StudioFormalState, StudioAction, RecordingEngine>(
          lts,
          cert,
          {
            createImpl: () =>
              new RecordingEngine(
                `book-conf-${useTrackProcessor ? 'tp' : 'wk'}-${++traceCounter}`,
              ),
            destroyImpl: async (engine) => {
              await engine.dispose();
            },
            observe: (engine) => abstractEngineState(engine, harness),
            negativeProbeActions: [
              'pause',
              'seek_start',
              'seek_end',
              'play_preview',
              'pause_preview',
              'trim_to_playhead',
              'undo_trim',
              'finalize',
            ],
            execute: async (engine, action) => {
              switch (action) {
                case 'start_or_resume':
                  await engine.startOrResumeFromEnd(device, quality, false);
                  break;
                case 'capture_chunk':
                  await harness.emitChunk(1);
                  break;
                case 'pause':
                  await engine.pause();
                  break;
                case 'seek_start':
                  engine.seekToMs(0);
                  if (engine.getSnapshot().phase === 'playing') {
                    await Promise.resolve();
                    await Promise.resolve();
                  }
                  break;
                case 'seek_mid':
                  engine.seekToMs(Math.floor(engine.getSnapshot().durationMs / 2000) * 1000);
                  if (engine.getSnapshot().phase === 'playing') {
                    await Promise.resolve();
                    await Promise.resolve();
                  }
                  break;
                case 'seek_end':
                  engine.seekToMs(engine.getSnapshot().durationMs);
                  if (engine.getSnapshot().phase === 'playing') {
                    await Promise.resolve();
                    await Promise.resolve();
                  }
                  break;
                case 'play_preview':
                  await engine.playPreviewFromPlayhead();
                  break;
                case 'preview_tick':
                  harness.advancePreviewClockSec(1);
                  break;
                case 'preview_ended':
                  harness.triggerPreviewEnded();
                  break;
                case 'pause_preview':
                  engine.pausePreview();
                  break;
                case 'punch_in':
                  await engine.punchInFromPlayhead(device, quality, false);
                  break;
                case 'trim_to_playhead':
                  await engine.trimToPlayhead();
                  break;
                case 'undo_trim':
                  await engine.undoLastTrim();
                  break;
                case 'finalize':
                  try {
                    await engine.finalizeAndEncode(quality);
                  } catch {
                    // Disabled finalize (duration === 0) rejects cleanly without mutating state
                  }
                  break;
                case 'discard':
                  await engine.discard();
                  break;
              }
            },
          },
        );

        // Proves 100% of reachable BFS states were covered on the REAL RecordingEngine!
        expect(conf.distinctStatesCovered).toBe(cert.statesExplored);
        expect(conf.enabledStepsVerified).toBeGreaterThan(30);
        expect(conf.disabledGuardsVerified).toBeGreaterThan(50);
      } finally {
        harness.cleanup();
      }
    });
  }

  it('proves async cancellation safety: discard() mid-await acquireMicStream stops leaked track and never enters recording', async () => {
    let resolveMic!: (stream: MediaStream) => void;
    const stopSpy = vi.fn();

    class MockAudioContext {
      sampleRate = 1000;
      state: AudioContextState = 'running';
      destination = {};
      audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
      resume = vi.fn().mockResolvedValue(undefined);
      close = vi.fn().mockResolvedValue(undefined);
    }

    const originalMediaDevices = navigator.mediaDevices;
    vi.stubGlobal('AudioContext', MockAudioContext);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(
          () =>
            new Promise<MediaStream>((resolve) => {
              resolveMic = resolve;
            }),
        ),
      },
    });

    try {
      const engine = new RecordingEngine('book-async-cancel');
      const startPromise = engine.startOrResumeFromEnd(
        { deviceId: 'default', deviceLabel: 'Mic' },
        { ...DEFAULT_AUDIO_QUALITY, channels: 1 },
        false,
      );

      // User cancels/discards while OS mic permission dialog is still pending!
      await engine.discard();

      // OS finally resolves getUserMedia with a live track
      const fakeTrack = { label: 'Late Mic', stop: stopSpy };
      resolveMic({
        getTracks: () => [fakeTrack],
        getAudioTracks: () => [fakeTrack],
      } as unknown as MediaStream);

      await startPromise;

      // Invariant: late-arriving track MUST be stopped immediately and phase MUST remain 'idle'
      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(engine.getSnapshot().phase).toBe('idle');
      expect(engine.getSnapshot().durationMs).toBe(0);
      await engine.dispose();
    } finally {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: originalMediaDevices,
      });
      vi.unstubAllGlobals();
    }
  });

  it('proves RecordingEngine.seekToMs enforces closed playhead bounds for all IEEE-754 edge inputs', async () => {
    const harness = installDeterministicAudioHarness();
    const device = { deviceId: 'default', deviceLabel: 'Formal Test Mic' };
    const quality = { ...DEFAULT_AUDIO_QUALITY, channels: 1 as const, sampleRate: 1000 as 44100 };

    try {
      const engine = new RecordingEngine('book-seek-bounds');
      await engine.startOrResumeFromEnd(device, quality, false);
      harness.emitChunk(2);
      await engine.pause();

      const edgeInputs = [
        Number.NaN,
        Number.NEGATIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        -10_000,
        -0.001,
        0,
        500,
        2000,
        999_999,
      ];

      for (const ms of edgeInputs) {
        engine.seekToMs(ms);
        const snap = engine.getSnapshot();
        expect(Number.isFinite(snap.playheadMs)).toBe(true);
        expect(snap.playheadMs).toBeGreaterThanOrEqual(0);
        expect(snap.playheadMs).toBeLessThanOrEqual(snap.durationMs);
      }

      await engine.dispose();
    } finally {
      harness.cleanup();
    }
  });
});
