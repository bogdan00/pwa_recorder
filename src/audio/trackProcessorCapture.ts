import type { AudioQualitySettings, ChannelCountOption } from '../types/models';
import { PcmInputStripProcessor } from './inputStrip';
import type { PcmCaptureChunk } from './pcmCapture';
import { PEAKS_PER_SECOND } from './pcmTimeline';

/** Minimal WebCodecs AudioData shape for strict TypeScript portability */
export interface AudioDataLike {
  readonly format: string | null;
  readonly sampleRate: number;
  readonly numberOfFrames: number;
  readonly numberOfChannels: number;
  readonly timestamp: number; // microseconds
  readonly duration: number; // microseconds
  copyTo: (
    destination: AllowSharedBufferSource,
    options: { planeIndex: number; format?: string },
  ) => void;
  close: () => void;
}

export interface MediaStreamTrackProcessorLike {
  readonly readable: ReadableStream<AudioDataLike>;
  readonly discardedFrames?: number;
}

type MediaStreamTrackProcessorCtor = new (init: {
  track: MediaStreamTrack;
  maxBufferSize?: number;
}) => MediaStreamTrackProcessorLike;

export const TRACK_PROCESSOR_MAX_BUFFER_SIZE = 100; // 100 x 10ms = 1,000 ms lossless jitter queue
/**
 * Positive cumulative clock-drift threshold (35 ms) beyond EMA-tracked wall-clock offset,
 * requiring 2 consecutive frames to confirm a permanent timeline shift.
 *
 * Why 2 consecutive frames + 35 ms?
 * - A transient OS callback scheduling hiccup (1 late frame followed by on-time frames)
 *   loses ZERO audio and resets on the next frame -> 0 false positives.
 * - Android Chrome 20 ms hardware DMA bursts split into back-to-back 10 ms AudioData frames
 *   with ±12 ms wall-clock jitter stay strictly inside the band -> 0 false positives.
 * - A genuine OS HAL audio drop permanently shifts ALL subsequent frames forward by +Δt,
 *   so frame k+1 immediately confirms the drop, emits 1 exact gap, and re-locks the offset.
 */
export const TIMESTAMP_DRIFT_GAP_THRESHOLD_US = 35_000;
export const TIMESTAMP_OFFSET_EMA_ALPHA = 0.02; // ~0.5 s time constant @ 10 ms frames

export class TimestampContinuityTracker {
  private initialized = false;
  private emittedDurationUs = 0;
  private clockOffsetUs = 0;
  private consecutivePositiveDrifts = 0;
  private consecutiveNegativeDrifts = 0;

  observe(
    timestampUs: number,
    durationUs: number,
  ): { isGap: boolean; gapMs: number } {
    if (
      !Number.isFinite(timestampUs) ||
      !Number.isFinite(durationUs) ||
      durationUs <= 0
    ) {
      return { isGap: false, gapMs: 0 };
    }

    const instantOffsetUs = timestampUs - this.emittedDurationUs;
    this.emittedDurationUs += durationUs;

    if (!this.initialized) {
      this.initialized = true;
      this.clockOffsetUs = instantOffsetUs;
      return { isGap: false, gapMs: 0 };
    }

    const driftUs = instantOffsetUs - this.clockOffsetUs;

    if (driftUs > TIMESTAMP_DRIFT_GAP_THRESHOLD_US) {
      this.consecutiveNegativeDrifts = 0;
      this.consecutivePositiveDrifts += 1;
      if (this.consecutivePositiveDrifts >= 2) {
        // Confirmed permanent positive timeline shift (genuine dropped audio):
        // re-lock immediately so subsequent normal frames never cascade into duplicate alerts.
        this.clockOffsetUs = instantOffsetUs;
        this.consecutivePositiveDrifts = 0;
        return { isGap: true, gapMs: Math.round((driftUs / 1000) * 10) / 10 };
      }
      return { isGap: false, gapMs: 0 };
    }

    if (driftUs < -TIMESTAMP_DRIFT_GAP_THRESHOLD_US) {
      this.consecutivePositiveDrifts = 0;
      this.consecutiveNegativeDrifts += 1;
      if (this.consecutiveNegativeDrifts >= 2) {
        // Sustained backward clock adjustment: re-lock cleanly without false drop.
        this.clockOffsetUs = instantOffsetUs;
        this.consecutiveNegativeDrifts = 0;
      }
      return { isGap: false, gapMs: 0 };
    }

    // Normal DMA burst jitter or smooth ADC-vs-CPU crystal skew: gently slew baseline.
    this.consecutivePositiveDrifts = 0;
    this.consecutiveNegativeDrifts = 0;
    this.clockOffsetUs += driftUs * TIMESTAMP_OFFSET_EMA_ALPHA;
    return { isGap: false, gapMs: 0 };
  }
}

export interface TrackProcessorCaptureStats {
  sampleRate: number;
  framesReceived: number;
  timestampGapCount: number;
  maxTimestampGapMs: number;
  discardedFrames: number | null;
  lastCompressorReductionDb: number;
  minCompressorReductionDb: number;
  autoGainDb: number | null;
}

export interface TrackProcessorCaptureChunk extends PcmCaptureChunk {
  sampleRate: number;
  compressorReductionDb: number;
  timestampGapsDelta: number;
  maxTimestampGapMs: number;
}

export interface TrackProcessorCaptureHandle {
  readonly processor: MediaStreamTrackProcessorLike;
  readonly getStats: () => TrackProcessorCaptureStats;
  readonly stop: () => void;
}

export interface AttachTrackProcessorOptions {
  channels: ChannelCountOption;
  quality: AudioQualitySettings;
  enableSoftwareAgc: boolean;
  initialSampleRate?: number;
  isActive: () => boolean;
  isAborted?: () => boolean;
  onSampleRateDetected?: (sampleRate: number) => void;
  onChunk: (chunk: TrackProcessorCaptureChunk) => void;
}

function getMediaStreamTrackProcessorCtor(): MediaStreamTrackProcessorCtor | null {
  if (typeof globalThis === 'undefined') return null;
  const ctor = (
    globalThis as unknown as {
      MediaStreamTrackProcessor?: MediaStreamTrackProcessorCtor;
    }
  ).MediaStreamTrackProcessor;
  return typeof ctor === 'function' ? ctor : null;
}

/**
 * Returns true when the current browser exposes `MediaStreamTrackProcessor` on the global
 * scope (Chrome, Edge, Chrome for Android 94+). Safari/iOS and Firefox return false and
 * cleanly fall back to `AudioWorkletNode`.
 */
export function supportsAudioTrackProcessor(): boolean {
  return getMediaStreamTrackProcessorCtor() !== null;
}

/**
 * Extracts planar f32 channels from a WebCodecs `AudioData` frame into reusable scratch
 * buffers. When `targetChannels === 1`, always extracts plane 0 directly at 1.0x unity gain
 * (discrete mono extraction — never speakers-downmixing `(L, 0)` by -6 dB).
 */
function extractPlanarFloat32(
  audioData: AudioDataLike,
  targetChannels: ChannelCountOption,
  scratchPlanes: Float32Array[],
): void {
  const frames = audioData.numberOfFrames;
  const srcChannels = Math.max(1, audioData.numberOfChannels);
  const fmt = audioData.format;

  // Fast path: native f32-planar (Chrome / Chrome Android default)
  if (fmt === 'f32-planar') {
    audioData.copyTo(scratchPlanes[0].subarray(0, frames), { planeIndex: 0 });
    if (targetChannels === 2) {
      if (srcChannels > 1) {
        audioData.copyTo(scratchPlanes[1].subarray(0, frames), {
          planeIndex: 1,
        });
      } else {
        scratchPlanes[1].set(scratchPlanes[0].subarray(0, frames), 0);
      }
    }
    return;
  }

  // Try WebCodecs built-in format conversion to f32-planar first
  try {
    audioData.copyTo(scratchPlanes[0].subarray(0, frames), {
      planeIndex: 0,
      format: 'f32-planar',
    });
    if (targetChannels === 2) {
      if (srcChannels > 1) {
        audioData.copyTo(scratchPlanes[1].subarray(0, frames), {
          planeIndex: 1,
          format: 'f32-planar',
        });
      } else {
        scratchPlanes[1].set(scratchPlanes[0].subarray(0, frames), 0);
      }
    }
    return;
  } catch {
    // Fall through to manual de-interleave from native interleaved format
  }

  if (fmt === 'f32') {
    const interleaved = new Float32Array(frames * srcChannels);
    audioData.copyTo(interleaved, { planeIndex: 0 });
    for (let i = 0; i < frames; i += 1) {
      const s0 = interleaved[i * srcChannels];
      scratchPlanes[0][i] = s0;
      if (targetChannels === 2) {
        scratchPlanes[1][i] =
          srcChannels > 1 ? interleaved[i * srcChannels + 1] : s0;
      }
    }
    return;
  }

  if (fmt === 's16' || fmt === 's16-planar') {
    if (fmt === 's16-planar') {
      const i16 = new Int16Array(frames);
      audioData.copyTo(i16, { planeIndex: 0 });
      for (let i = 0; i < frames; i += 1) scratchPlanes[0][i] = i16[i] / 32768;
      if (targetChannels === 2) {
        if (srcChannels > 1) {
          audioData.copyTo(i16, { planeIndex: 1 });
          for (let i = 0; i < frames; i += 1)
            scratchPlanes[1][i] = i16[i] / 32768;
        } else {
          scratchPlanes[1].set(scratchPlanes[0].subarray(0, frames), 0);
        }
      }
      return;
    }
    const i16 = new Int16Array(frames * srcChannels);
    audioData.copyTo(i16, { planeIndex: 0 });
    for (let i = 0; i < frames; i += 1) {
      const s0 = i16[i * srcChannels] / 32768;
      scratchPlanes[0][i] = s0;
      if (targetChannels === 2) {
        scratchPlanes[1][i] =
          srcChannels > 1 ? i16[i * srcChannels + 1] / 32768 : s0;
      }
    }
    return;
  }

  // Last-resort silence to guarantee no uninitialized samples leak
  scratchPlanes[0].fill(0, 0, frames);
  if (targetChannels === 2) {
    scratchPlanes[1].fill(0, 0, frames);
  }
}

/**
 * Attaches direct push-stream PCM capture onto an audio `MediaStreamTrack` using
 * `MediaStreamTrackProcessor` (`maxBufferSize: 100` = 1,000 ms lossless jitter queue).
 *
 * Completely bypasses `MediaStreamAudioSourceNode` and `AudioContext` on Chrome/Android,
 * eliminating the 480-sample clock-crossing FIFO underrun/overflow glitches and Android
 * full-duplex AAudio/AudioFlinger contention.
 *
 * Returns `null` cleanly if `MediaStreamTrackProcessor` is unavailable or rejects audio
 * tracks so callers can seamlessly fall back to `AudioWorkletNode`.
 */
export function attachTrackProcessorCapture(
  track: MediaStreamTrack,
  options: AttachTrackProcessorOptions,
): TrackProcessorCaptureHandle | null {
  const Ctor = getMediaStreamTrackProcessorCtor();
  if (!Ctor || track.kind !== 'audio') {
    return null;
  }

  let processor: MediaStreamTrackProcessorLike;
  let reader: ReadableStreamDefaultReader<AudioDataLike>;
  try {
    processor = new Ctor({
      track,
      maxBufferSize: TRACK_PROCESSOR_MAX_BUFFER_SIZE,
    });
    if (!processor || !processor.readable) {
      return null;
    }
    reader = processor.readable.getReader();
  } catch {
    return null;
  }

  const {
    channels,
    quality,
    enableSoftwareAgc,
    initialSampleRate = quality.sampleRate || 48000,
    isActive,
    isAborted = () => false,
    onSampleRateDetected,
    onChunk,
  } = options;

  let stopped = false;
  let detectedSampleRate = initialSampleRate;
  let hasDetectedRate = false;
  let dsp: PcmInputStripProcessor | null = null;
  let scratchPlanes: Float32Array[] = [];

  // 20 ms flush batching (= 960 frames @ 48 kHz = 50 chunks/sec, 1:1 with PEAKS_PER_SECOND)
  let flushFrames = Math.max(480, Math.round(detectedSampleRate * 0.02));
  let framesPerPeak = Math.max(
    1,
    Math.round(detectedSampleRate / PEAKS_PER_SECOND),
  );
  let batchInterleaved = new Float32Array(flushFrames * channels);
  let batchFrameOffset = 0;
  let peakAccum = 0;
  let peakFrames = 0;
  let pendingPeaks: number[] = [];
  let batchLivePeak = 0;
  let batchMinReductionDb = 0;

  // Continuity & health stats
  let framesReceived = 0;
  const continuityTracker = new TimestampContinuityTracker();
  let lastDiscardedFrames =
    typeof processor.discardedFrames === 'number' &&
    Number.isFinite(processor.discardedFrames)
      ? processor.discardedFrames
      : 0;
  let timestampGapCount = 0;
  let pendingTimestampGaps = 0;
  let maxTimestampGapMs = 0;

  const ensureScratch = (frameCount: number) => {
    if (
      scratchPlanes.length === channels &&
      scratchPlanes[0].length >= frameCount
    ) {
      return;
    }
    const allocLen = Math.max(frameCount, 1024);
    scratchPlanes = Array.from(
      { length: channels },
      () => new Float32Array(allocLen),
    );
  };

  const ensureBatchCapacity = (neededFrames: number) => {
    const neededSamples = neededFrames * channels;
    if (batchInterleaved.length >= neededSamples) return;
    const grown = new Float32Array(neededSamples);
    if (batchFrameOffset > 0) {
      grown.set(batchInterleaved.subarray(0, batchFrameOffset * channels), 0);
    }
    batchInterleaved = grown;
  };

  const flushBatch = () => {
    if (batchFrameOffset === 0) return;
    const outSamples = batchFrameOffset * channels;
    const pcm = batchInterleaved.slice(0, outSamples);
    const peaks = pendingPeaks;
    const liveLevel = batchLivePeak;
    const reductionDb = batchMinReductionDb;
    const gapsDelta = pendingTimestampGaps;

    batchFrameOffset = 0;
    pendingPeaks = [];
    batchLivePeak = 0;
    batchMinReductionDb = 0;
    pendingTimestampGaps = 0;

    if (!stopped && !isAborted() && isActive()) {
      onChunk({
        pcm,
        peaks,
        liveLevel,
        sampleRate: detectedSampleRate,
        compressorReductionDb: reductionDb,
        timestampGapsDelta: gapsDelta,
        maxTimestampGapMs,
      });
    }
  };

  const drainLoop = async () => {
    try {
      while (!stopped && !isAborted()) {
        const result = await reader.read();
        if (result.done || !result.value) break;
        const audioData = result.value;
        try {
          const nFrames = audioData.numberOfFrames;
          if (nFrames <= 0) continue;

          if (!hasDetectedRate) {
            hasDetectedRate = true;
            if (
              Number.isFinite(audioData.sampleRate) &&
              audioData.sampleRate >= 8000
            ) {
              detectedSampleRate = audioData.sampleRate;
            }
            flushFrames = Math.max(480, Math.round(detectedSampleRate * 0.02));
            framesPerPeak = Math.max(
              1,
              Math.round(detectedSampleRate / PEAKS_PER_SECOND),
            );
            batchInterleaved = new Float32Array(flushFrames * channels * 2);
            dsp = new PcmInputStripProcessor(
              detectedSampleRate,
              channels,
              quality,
              enableSoftwareAgc,
            );
            onSampleRateDetected?.(detectedSampleRate);
          }

          framesReceived += nFrames;

          // 1. Authoritative ring-buffer overflow check (MediaStreamTrackProcessor.discardedFrames)
          if (
            typeof processor.discardedFrames === 'number' &&
            Number.isFinite(processor.discardedFrames) &&
            processor.discardedFrames > lastDiscardedFrames
          ) {
            const deltaDiscarded = Math.floor(
              processor.discardedFrames - lastDiscardedFrames,
            );
            lastDiscardedFrames = processor.discardedFrames;
            if (deltaDiscarded > 0) {
              timestampGapCount += deltaDiscarded;
              pendingTimestampGaps += deltaDiscarded;
            }
          }

          // 2. Cumulative EMA-tracked timestamp continuity (immune to Android 20 ms DMA bursts,
          //    ±12 ms callback jitter, and long-take crystal skew; catches real > 25 ms drops)
          const gapCheck = continuityTracker.observe(
            audioData.timestamp,
            audioData.duration,
          );
          if (gapCheck.isGap) {
            timestampGapCount += 1;
            pendingTimestampGaps += 1;
            if (gapCheck.gapMs > maxTimestampGapMs) {
              maxTimestampGapMs = gapCheck.gapMs;
            }
          }

          if (stopped || isAborted() || !isActive()) {
            // Keep DSP filter state warm & discard inactive audio cleanly
            continue;
          }

          ensureScratch(nFrames);
          extractPlanarFloat32(audioData, channels, scratchPlanes);

          const dspResult = dsp
            ? dsp.processBlock(scratchPlanes, nFrames)
            : { peak: 0, reductionDb: 0 };
          if (dspResult.peak > batchLivePeak) {
            batchLivePeak = dspResult.peak;
          }
          if (dspResult.reductionDb < batchMinReductionDb) {
            batchMinReductionDb = dspResult.reductionDb;
          }

          ensureBatchCapacity(batchFrameOffset + nFrames);
          const ch0 = scratchPlanes[0];
          const ch1 = channels === 2 ? scratchPlanes[1] : null;

          for (let i = 0; i < nFrames; i += 1) {
            const s0 = ch0[i];
            const outIdx = (batchFrameOffset + i) * channels;
            batchInterleaved[outIdx] = s0;
            let frameAbs = Math.abs(s0);
            if (ch1) {
              const s1 = ch1[i];
              batchInterleaved[outIdx + 1] = s1;
              const a1 = Math.abs(s1);
              if (a1 > frameAbs) frameAbs = a1;
            }
            if (frameAbs > peakAccum) peakAccum = frameAbs;
            peakFrames += 1;
            if (peakFrames >= framesPerPeak) {
              pendingPeaks.push(peakAccum);
              peakAccum = 0;
              peakFrames = 0;
            }
          }
          batchFrameOffset += nFrames;

          if (batchFrameOffset >= flushFrames) {
            flushBatch();
          }
        } finally {
          try {
            audioData.close();
          } catch {
            // Ignore double-close
          }
        }
      }
    } catch {
      // Stream cancelled or track ended cleanly
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Ignore if already released
      }
    }
  };

  void drainLoop();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    void reader.cancel().catch(() => {});
  };

  const getStats = (): TrackProcessorCaptureStats => ({
    sampleRate: detectedSampleRate,
    framesReceived,
    timestampGapCount,
    maxTimestampGapMs,
    discardedFrames:
      typeof processor.discardedFrames === 'number' &&
      Number.isFinite(processor.discardedFrames)
        ? processor.discardedFrames
        : null,
    lastCompressorReductionDb: dsp ? dsp.getLastReductionDb() : 0,
    minCompressorReductionDb: dsp ? dsp.getMinReductionDb() : 0,
    autoGainDb: dsp?.autoGainController
      ? Math.round(dsp.autoGainController.getGainDb() * 10) / 10
      : null,
  });

  return {
    processor,
    getStats,
    stop,
  };
}

export function teardownTrackProcessorCapture(
  handle: TrackProcessorCaptureHandle | null,
): void {
  if (!handle) return;
  try {
    handle.stop();
  } catch {
    // Ignore teardown errors
  }
}
