import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AUDIO_QUALITY } from '../../storage/settings';
import {
  attachTrackProcessorCapture,
  supportsAudioTrackProcessor,
  teardownTrackProcessorCapture,
  TRACK_PROCESSOR_MAX_BUFFER_SIZE,
  type AudioDataLike,
  type TrackProcessorCaptureChunk,
} from '../trackProcessorCapture';

function makeFakeAudioData(opts: {
  sampleRate?: number;
  frames?: number;
  channels?: number;
  timestampUs: number;
  plane0Value?: number;
  plane1Value?: number;
  onClose?: () => void;
}): AudioDataLike {
  const sr = opts.sampleRate ?? 48000;
  const frames = opts.frames ?? 480;
  const channels = opts.channels ?? 2;
  const p0 = new Float32Array(frames).fill(opts.plane0Value ?? 0.35);
  const p1 = new Float32Array(frames).fill(opts.plane1Value ?? 0);

  return {
    format: 'f32-planar',
    sampleRate: sr,
    numberOfFrames: frames,
    numberOfChannels: channels,
    timestamp: opts.timestampUs,
    duration: Math.round((frames / sr) * 1_000_000),
    copyTo: (dest, { planeIndex }) => {
      const target =
        dest instanceof Float32Array
          ? dest
          : new Float32Array(
              (dest as ArrayBufferView).buffer,
              (dest as ArrayBufferView).byteOffset,
              (dest as ArrayBufferView).byteLength / 4,
            );
      target.set(planeIndex === 0 ? p0 : p1);
    },
    close: () => {
      opts.onClose?.();
    },
  };
}

describe('trackProcessorCapture', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports capability accurately and returns null cleanly when unsupported or constructor throws', () => {
    vi.stubGlobal('MediaStreamTrackProcessor', undefined);
    expect(supportsAudioTrackProcessor()).toBe(false);

    const fakeTrack = { kind: 'audio' } as MediaStreamTrack;
    const unsupported = attachTrackProcessorCapture(fakeTrack, {
      channels: 1,
      quality: DEFAULT_AUDIO_QUALITY,
      enableSoftwareAgc: false,
      isActive: () => true,
      onChunk: vi.fn(),
    });
    expect(unsupported).toBeNull();

    class ThrowingMSTP {
      constructor() {
        throw new Error('Unsupported track');
      }
    }
    vi.stubGlobal('MediaStreamTrackProcessor', ThrowingMSTP);
    expect(supportsAudioTrackProcessor()).toBe(true);
    const failed = attachTrackProcessorCapture(fakeTrack, {
      channels: 1,
      quality: DEFAULT_AUDIO_QUALITY,
      enableSoftwareAgc: false,
      isActive: () => true,
      onChunk: vi.fn(),
    });
    expect(failed).toBeNull();
  });

  it('uses maxBufferSize=100, extracts mono plane 0 at unity gain without speakers halving, closes every AudioData, batches 20ms chunks, and tracks timestamp gaps', async () => {
    const receivedInit: Array<{ track: MediaStreamTrack; maxBufferSize?: number }> = [];
    let closedCount = 0;

    // 4 frames of 480 samples (10 ms each @ 48 kHz) -> 2 batched 20ms chunks
    // Frames 2 & 3 stay shifted forward by +40 ms (60,000 us & 70,000 us vs expected 20,000 & 30,000) to verify sustained OS HAL drop detection.
    // All frames carry (L=0.3, R=0.0) to prove mono plane-0 discrete extraction preserves full unity gain!
    const framesQueue: AudioDataLike[] = [
      makeFakeAudioData({ timestampUs: 0, plane0Value: 0.3, plane1Value: 0, onClose: () => { closedCount += 1; } }),
      makeFakeAudioData({ timestampUs: 10_000, plane0Value: 0.3, plane1Value: 0, onClose: () => { closedCount += 1; } }),
      makeFakeAudioData({ timestampUs: 60_000, plane0Value: 0.3, plane1Value: 0, onClose: () => { closedCount += 1; } }),
      makeFakeAudioData({ timestampUs: 70_000, plane0Value: 0.3, plane1Value: 0, onClose: () => { closedCount += 1; } }),
    ];

    class MockMSTP {
      readable: ReadableStream<AudioDataLike>;
      discardedFrames = 0;
      constructor(init: { track: MediaStreamTrack; maxBufferSize?: number }) {
        receivedInit.push(init);
        let idx = 0;
        this.readable = new ReadableStream<AudioDataLike>({
          pull(controller) {
            if (idx < framesQueue.length) {
              controller.enqueue(framesQueue[idx++]);
            } else {
              controller.close();
            }
          },
        });
      }
    }

    vi.stubGlobal('MediaStreamTrackProcessor', MockMSTP);

    const chunks: TrackProcessorCaptureChunk[] = [];
    const onSampleRateDetected = vi.fn();
    const fakeTrack = { kind: 'audio' } as MediaStreamTrack;

    const handle = attachTrackProcessorCapture(fakeTrack, {
      channels: 1,
      quality: {
        ...DEFAULT_AUDIO_QUALITY,
        highPassFilter: false,
        softLimiter: false,
        inputGain: 1.0,
      },
      enableSoftwareAgc: false,
      isActive: () => true,
      onSampleRateDetected,
      onChunk: (chunk) => chunks.push(chunk),
    });

    expect(handle).not.toBeNull();
    expect(receivedInit[0].maxBufferSize).toBe(TRACK_PROCESSOR_MAX_BUFFER_SIZE);

    // Wait reactively for stream drain
    await vi.waitFor(() => {
      expect(chunks.length).toBe(2);
    });

    // Every single AudioData frame MUST be closed (zero native memory leaks)
    expect(closedCount).toBe(4);
    expect(onSampleRateDetected).toHaveBeenCalledWith(48000);

    // Each batched chunk is 960 frames (20 ms @ 48 kHz) with 1 peak (50 peaks/sec)
    expect(chunks[0].pcm.length).toBe(960);
    expect(chunks[0].peaks.length).toBe(1);
    // Unity gain preserved on (L=0.3, R=0.0): must be ~0.3, NOT 0.15!
    expect(chunks[0].pcm[0]).toBeCloseTo(0.3, 5);
    expect(chunks[0].liveLevel).toBeCloseTo(0.3, 5);

    const stats = handle!.getStats();
    expect(stats.sampleRate).toBe(48000);
    expect(stats.framesReceived).toBe(1920);
    expect(stats.timestampGapCount).toBe(1);
    expect(stats.maxTimestampGapMs).toBeCloseTo(40, 1);

    teardownTrackProcessorCapture(handle);
  });

  it('TimestampContinuityTracker ignores Android 20 ms DMA bursts, transient 80 ms callback spikes, and 30-min crystal skew while catching genuine sustained >= 40 ms drops without cascading', async () => {
    const { TimestampContinuityTracker } = await import('../trackProcessorCapture');

    // 1. Android Chrome 20 ms DMA bursts split into back-to-back 10 ms AudioData frames
    const burstTracker = new TimestampContinuityTracker();
    let burstGaps = 0;
    for (let i = 0; i < 1000; i += 1) {
      const pairBaseUs = Math.floor(i / 2) * 20_000;
      const burstJitterUs = i % 2 === 1 ? 200 : (i % 6 === 0 ? 2200 : 0);
      const res = burstTracker.observe(pairBaseUs + burstJitterUs, 10_000);
      if (res.isGap) burstGaps += 1;
    }
    expect(burstGaps).toBe(0);

    // 2. Single-frame 80 ms OS scheduling hiccup (no audio lost) -> 0 false gaps
    const spikeTracker = new TimestampContinuityTracker();
    let spikeGaps = 0;
    for (let i = 0; i < 30; i += 1) {
      const spikeUs = i === 15 ? 80_000 : 0;
      if (spikeTracker.observe(i * 10_000 + spikeUs, 10_000).isGap) spikeGaps += 1;
    }
    expect(spikeGaps).toBe(0);

    // 3. 30-minute take (180,000 frames) with +200 ppm ADC-vs-CPU crystal oscillator skew
    const skewTracker = new TimestampContinuityTracker();
    let skewGaps = 0;
    for (let i = 0; i < 180_000; i += 1) {
      const tsUs = i * 10_002;
      if (skewTracker.observe(tsUs, 10_000).isGap) skewGaps += 1;
    }
    expect(skewGaps).toBe(0);

    // 4. Genuine sustained +40 ms OS HAL drop -> exact 1 gap, immediately re-locked (0 cascading duplicates)
    const dropTracker = new TimestampContinuityTracker();
    const detected: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const dropOffsetUs = i >= 10 ? 40_000 : 0;
      const res = dropTracker.observe(i * 10_000 + dropOffsetUs, 10_000);
      if (res.isGap) detected.push(res.gapMs);
    }
    expect(detected).toEqual([40]);
  });
});
