import type { ChannelCountOption } from '../types/models';

export const PEAKS_PER_SECOND = 50; // 20 ms resolution
const CROSSFADE_MS = 15;

interface TruncateUndoSnapshot {
  chunks: Float32Array[];
  totalFrames: number;
  peaks: number[];
}

/**
 * Channel-aware 32-bit Float PCM timeline supporting:
 * - Streaming chunk appends (Mono or Stereo interleaved Float32)
 * - Sample-accurate playback range extraction
 * - Sample-accurate punch-in truncation with 15 ms anti-click fade-out + 15 ms fade-in splice
 * - Single-step undo of the most recent truncation
 */
export class PcmTimeline {
  public readonly sampleRate: number;
  public readonly channels: ChannelCountOption;

  private chunks: Float32Array[] = [];
  private totalFrames = 0;
  private peaks: number[] = [];
  private undoSnapshot: TruncateUndoSnapshot | null = null;
  private pendingFadeInFrames = 0;
  private isTailFaded = false;

  constructor(sampleRate: number, channels: ChannelCountOption = 1) {
    this.sampleRate = sampleRate;
    this.channels = channels;
  }

  getTotalFrames(): number {
    return this.totalFrames;
  }

  getDurationMs(): number {
    if (this.sampleRate <= 0) return 0;
    return (this.totalFrames / this.sampleRate) * 1000;
  }

  getPeaks(): number[] {
    return this.peaks;
  }

  canUndoTruncate(): boolean {
    return this.undoSnapshot !== null;
  }

  clearUndo(): void {
    this.undoSnapshot = null;
  }

  msToFrame(ms: number): number {
    const clampedMs = Math.max(0, Math.min(ms, this.getDurationMs()));
    return Math.min(
      this.totalFrames,
      Math.max(0, Math.round((clampedMs / 1000) * this.sampleRate)),
    );
  }

  /**
   * Marks a Pause boundary by applying a smooth 15 ms raised-cosine tail fade-out
   * (idempotent if already faded) and arming a 15 ms fade-in for resumed audio.
   */
  markPauseBoundary(): void {
    if (this.totalFrames <= 0) return;
    const fadeFrames = Math.min(
      this.totalFrames,
      Math.max(1, Math.round((CROSSFADE_MS / 1000) * this.sampleRate)),
    );
    if (!this.isTailFaded && fadeFrames > 0) {
      this.applyTailFadeOut(fadeFrames);
      this.isTailFaded = true;
    }
    this.armResumeFadeIn();
  }

  /**
   * Arms a 15 ms raised-cosine fade-in for the next appended frames when resuming
   * an existing take (including crash-recovered drafts reloaded from IndexedDB).
   */
  armResumeFadeIn(): void {
    if (this.totalFrames <= 0) {
      this.pendingFadeInFrames = 0;
      return;
    }
    this.pendingFadeInFrames = Math.max(
      1,
      Math.round((CROSSFADE_MS / 1000) * this.sampleRate),
    );
  }

  appendFrames(interleaved: Float32Array, precomputedPeaks?: number[]): void {
    const frameCount = Math.floor(interleaved.length / this.channels);
    if (frameCount <= 0) return;

    const chunk =
      interleaved.length === frameCount * this.channels
        ? new Float32Array(interleaved)
        : interleaved.slice(0, frameCount * this.channels);

    // Apply smooth 15 ms raised-cosine fade-in after pause/resume or punch-in splice
    if (this.pendingFadeInFrames > 0) {
      const fadeTotal = Math.max(
        1,
        Math.round((CROSSFADE_MS / 1000) * this.sampleRate),
      );
      const alreadyDone = fadeTotal - this.pendingFadeInFrames;
      const toProcess = Math.min(frameCount, this.pendingFadeInFrames);
      for (let f = 0; f < toProcess; f += 1) {
        const t = (alreadyDone + f + 1) / fadeTotal;
        const gain = 0.5 * (1 - Math.cos(Math.PI * t));
        const base = f * this.channels;
        for (let ch = 0; ch < this.channels; ch += 1) {
          chunk[base + ch] *= gain;
        }
      }
      this.pendingFadeInFrames -= toProcess;
    }

    this.chunks.push(chunk);
    this.totalFrames += frameCount;
    this.isTailFaded = false;

    if (precomputedPeaks && precomputedPeaks.length > 0) {
      for (let i = 0; i < precomputedPeaks.length; i += 1) {
        this.peaks.push(Math.min(1, Math.max(0, precomputedPeaks[i])));
      }
    } else {
      this.recomputePeaksFromFrame(this.totalFrames - frameCount);
    }
  }

  loadFromChunks(chunks: Float32Array[], savedPeaks?: number[]): void {
    this.chunks = [];
    this.totalFrames = 0;
    this.peaks = [];
    this.undoSnapshot = null;
    this.pendingFadeInFrames = 0;
    this.isTailFaded = false;

    for (const raw of chunks) {
      const frameCount = Math.floor(raw.length / this.channels);
      if (frameCount <= 0) continue;
      this.chunks.push(raw.slice(0, frameCount * this.channels));
      this.totalFrames += frameCount;
    }

    if (savedPeaks && savedPeaks.length > 0) {
      this.peaks = savedPeaks.slice();
    } else {
      this.recomputeAllPeaks();
    }
  }

  /**
   * Truncates all audio after `targetFrame`, applies a 15 ms fade-out at the cut
   * boundary, and arms a 15 ms fade-in for the next appended frames.
   */
  truncateAtFrame(targetFrame: number): {
    trimmedMs: number;
    newDurationMs: number;
  } {
    const clampedFrame = Math.max(0, Math.min(Math.floor(targetFrame), this.totalFrames));
    const previousDurationMs = this.getDurationMs();

    // Save deep-enough snapshot for 1-level undo
    this.undoSnapshot = {
      chunks: this.chunks.map((c) => c.slice()),
      totalFrames: this.totalFrames,
      peaks: this.peaks.slice(),
    };

    const nextChunks: Float32Array[] = [];
    let remaining = clampedFrame;

    for (const chunk of this.chunks) {
      if (remaining <= 0) break;
      const chunkFrames = Math.floor(chunk.length / this.channels);
      if (chunkFrames <= remaining) {
        nextChunks.push(chunk.slice());
        remaining -= chunkFrames;
      } else {
        nextChunks.push(chunk.slice(0, remaining * this.channels));
        remaining = 0;
      }
    }

    this.chunks = nextChunks;
    this.totalFrames = clampedFrame;

    // Apply 15 ms fade-out across the tail to eliminate clicks at splice point
    const fadeFrames = Math.min(
      this.totalFrames,
      Math.max(1, Math.round((CROSSFADE_MS / 1000) * this.sampleRate)),
    );
    if (fadeFrames > 0) {
      this.applyTailFadeOut(fadeFrames);
      this.isTailFaded = true;
    } else {
      this.isTailFaded = false;
    }

    // Arm fade-in for newly recorded punch-in audio
    this.pendingFadeInFrames =
      this.totalFrames > 0
        ? Math.max(1, Math.round((CROSSFADE_MS / 1000) * this.sampleRate))
        : 0;

    // Trim peaks proportionally to match exact frame duration
    const expectedPeakCount = Math.floor(
      (this.totalFrames / this.sampleRate) * PEAKS_PER_SECOND,
    );
    this.peaks = this.peaks.slice(0, expectedPeakCount);

    const newDurationMs = this.getDurationMs();
    return {
      trimmedMs: Math.max(0, previousDurationMs - newDurationMs),
      newDurationMs,
    };
  }

  undoTruncate(): boolean {
    if (!this.undoSnapshot) return false;
    this.chunks = this.undoSnapshot.chunks;
    this.totalFrames = this.undoSnapshot.totalFrames;
    this.peaks = this.undoSnapshot.peaks;
    this.undoSnapshot = null;
    this.pendingFadeInFrames = 0;
    this.isTailFaded = false;
    return true;
  }

  /**
   * Extracts planar Float32Array per channel for [startFrame, endFrame).
   */
  extractChannelData(
    startFrame = 0,
    endFrame = this.totalFrames,
  ): Float32Array[] {
    const start = Math.max(0, Math.min(Math.floor(startFrame), this.totalFrames));
    const end = Math.max(start, Math.min(Math.floor(endFrame), this.totalFrames));
    const length = end - start;

    const outputs: Float32Array[] = [];
    for (let ch = 0; ch < this.channels; ch += 1) {
      outputs.push(new Float32Array(length));
    }
    if (length === 0) return outputs;

    let cursor = 0;
    let outIndex = 0;

    for (const chunk of this.chunks) {
      const chunkFrames = Math.floor(chunk.length / this.channels);
      const chunkStart = cursor;
      const chunkEnd = cursor + chunkFrames;

      if (chunkEnd > start && chunkStart < end) {
        const copyFrom = Math.max(0, start - chunkStart);
        const copyTo = Math.min(chunkFrames, end - chunkStart);
        for (let f = copyFrom; f < copyTo; f += 1) {
          const base = f * this.channels;
          for (let ch = 0; ch < this.channels; ch += 1) {
            outputs[ch][outIndex] = chunk[base + ch];
          }
          outIndex += 1;
        }
      }

      cursor = chunkEnd;
      if (cursor >= end) break;
    }

    return outputs;
  }

  /**
   * Produces consolidated Float32 chunks of roughly `targetChunkSeconds` seconds
   * for efficient IndexedDB draft storage.
   */
  buildStorageBlocks(targetChunkSeconds = 2): Float32Array[] {
    const blockFrames = Math.max(
      1,
      Math.round(this.sampleRate * targetChunkSeconds),
    );
    const blockSamples = blockFrames * this.channels;
    const blocks: Float32Array[] = [];

    let current = new Float32Array(blockSamples);
    let offset = 0;

    for (const chunk of this.chunks) {
      let readPos = 0;
      while (readPos < chunk.length) {
        const space = blockSamples - offset;
        const copyLen = Math.min(space, chunk.length - readPos);
        current.set(chunk.subarray(readPos, readPos + copyLen), offset);
        offset += copyLen;
        readPos += copyLen;
        if (offset === blockSamples) {
          blocks.push(current);
          current = new Float32Array(blockSamples);
          offset = 0;
        }
      }
    }

    if (offset > 0) {
      blocks.push(current.slice(0, offset));
    }
    return blocks;
  }

  private applyTailFadeOut(fadeFrames: number): void {
    let framesLeftToFade = fadeFrames;
    for (let cIdx = this.chunks.length - 1; cIdx >= 0 && framesLeftToFade > 0; cIdx -= 1) {
      const chunk = this.chunks[cIdx];
      const chunkFrames = Math.floor(chunk.length / this.channels);
      for (let f = chunkFrames - 1; f >= 0 && framesLeftToFade > 0; f -= 1) {
        // At very last frame -> gain 0; at start of fade -> gain near 1 (C1-smooth raised cosine)
        const distanceFromEnd = fadeFrames - framesLeftToFade;
        const t = distanceFromEnd / fadeFrames;
        const gain = 0.5 * (1 - Math.cos(Math.PI * t));
        const base = f * this.channels;
        for (let ch = 0; ch < this.channels; ch += 1) {
          chunk[base + ch] *= gain;
        }
        framesLeftToFade -= 1;
      }
    }
  }

  private recomputeAllPeaks(): void {
    this.peaks = [];
    this.recomputePeaksFromFrame(0);
  }

  private recomputePeaksFromFrame(startFrame: number): void {
    const framesPerPeak = Math.max(
      1,
      Math.round(this.sampleRate / PEAKS_PER_SECOND),
    );
    const alignedStart =
      Math.floor(startFrame / framesPerPeak) * framesPerPeak;
    const keepPeakCount = Math.floor(alignedStart / framesPerPeak);
    this.peaks = this.peaks.slice(0, keepPeakCount);

    const channelsData = this.extractChannelData(alignedStart, this.totalFrames);
    const totalExtracted = channelsData[0]?.length ?? 0;

    for (let f = 0; f + framesPerPeak <= totalExtracted; f += framesPerPeak) {
      let maxAbs = 0;
      for (let j = 0; j < framesPerPeak; j += 1) {
        for (let ch = 0; ch < this.channels; ch += 1) {
          const a = Math.abs(channelsData[ch][f + j]);
          if (a > maxAbs) maxAbs = a;
        }
      }
      this.peaks.push(Math.min(1, maxAbs));
    }
  }
}
