/**
 * Formal Specification: PCM Audio Timeline Mathematical Contract
 *
 * Related ADR: adr/ADR-03-off-main-thread-pcm-capture-and-timeline.md
 * Related ADR: adr/ADR-11-two-tier-formal-verification.md
 * Production implementation: src/audio/pcmTimeline.ts
 *
 * Formal Properties Specified:
 *   1. Closed-Interval Frame Clamping:
 *        ∀ ms ∈ ℝ ∪ {±∞, NaN}, sampleRate > 0, totalFrames ≥ 0:
 *          0 ≤ msToFrame(ms) ≤ totalFrames
 *   2. Monotonicity of Time-to-Frame Mapping:
 *        ∀ ms1 ≤ ms2: msToFrame(ms1) ≤ msToFrame(ms2)
 *   3. Exact Extraction Window Bounds:
 *        ∀ start, end:
 *          let s = clamp(floor(start), 0, N), e = clamp(floor(end), s, N)
 *          extractChannelData(start, end) returns `channels` arrays of length `e - s`
 *   4. Raised-Cosine Anti-Click Splice Continuity:
 *        g(t) = 0.5 * (1 - cos(π * t)) satisfies:
 *          - g(0) = 0 (zero amplitude at cut edge → no DC step click)
 *          - g(1) = 1 (unity gain away from cut)
 *          - ∀ t ∈ [0, 1]: 0 ≤ g(t) ≤ 1
 *          - g is monotonically non-decreasing on [0, 1]
 *   5. 1-Step Truncate / Undo Left-Inverse:
 *        undoTruncate(truncateAtFrame(timeline, k)) ≡ timeline (bit-for-bit!)
 *   6. Storage-Block Round-Trip Conservation:
 *        loadFromChunks(buildStorageBlocks(timeline, blockSec)) ≡ timeline (bit-for-bit!)
 */

import type { ChannelCountOption } from '../../types/models';

export const PCM_CROSSFADE_MS = 15;
export const PCM_PEAKS_PER_SECOND = 50;

export function specRaisedCosineGain(t: number): number {
  return 0.5 * (1 - Math.cos(Math.PI * t));
}

export function specExpectedFadeFrames(
  totalFrames: number,
  sampleRate: number,
): number {
  if (totalFrames <= 0 || sampleRate <= 0) return 0;
  return Math.min(
    totalFrames,
    Math.max(1, Math.round((PCM_CROSSFADE_MS / 1000) * sampleRate)),
  );
}

export function specClampFrame(raw: number, totalFrames: number): number {
  const safe = Number.isFinite(raw)
    ? Math.floor(raw)
    : raw === Number.POSITIVE_INFINITY
      ? totalFrames
      : 0;
  return Math.max(0, Math.min(safe, totalFrames));
}

export function specExpectedExtractionLength(
  startFrame: number,
  endFrame: number,
  totalFrames: number,
): number {
  const start = specClampFrame(startFrame, totalFrames);
  const end = Math.max(start, specClampFrame(endFrame, totalFrames));
  return end - start;
}

export interface PcmTestCase {
  readonly sampleRate: number;
  readonly channels: ChannelCountOption;
  readonly chunkFrameCounts: readonly number[];
  readonly cutFrame: number;
  readonly blockSeconds: number;
}

/**
 * Exhaustive canonical finite parameter grid covering mono/stereo, multiple sample rates,
 * multi-chunk boundaries (cuts inside first chunk, on exact chunk boundary, at 0, at end,
 * past end, negative, NaN), and varied storage block sizes.
 */
export function generateCanonicalPcmCases(): readonly PcmTestCase[] {
  const sampleRates = [1000, 8000];
  const channelsList: readonly ChannelCountOption[] = [1, 2];
  const chunkLayouts: readonly (readonly number[])[] = [
    [100],
    [40, 60],
    [15, 35, 50],
    [1, 1, 98],
  ];
  const cutFrames = [-10, 0, 1, 15, 40, 50, 99, 100, 150, Number.NaN];
  const blockSecondsList = [0.02, 0.05, 0.2];

  const cases: PcmTestCase[] = [];
  for (const sampleRate of sampleRates) {
    for (const channels of channelsList) {
      for (const chunkFrameCounts of chunkLayouts) {
        for (const cutFrame of cutFrames) {
          for (const blockSeconds of blockSecondsList) {
            cases.push({
              sampleRate,
              channels,
              chunkFrameCounts,
              cutFrame,
              blockSeconds,
            });
          }
        }
      }
    }
  }
  return cases;
}
