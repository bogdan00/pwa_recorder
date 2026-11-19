import { describe, expect, it } from 'vitest';
import { PcmTimeline, PEAKS_PER_SECOND } from '../pcmTimeline';

describe('PcmTimeline', () => {
  it('appends mono frames, calculates duration and peaks, and extracts arbitrary ranges', () => {
    const sampleRate = 1000;
    const timeline = new PcmTimeline(sampleRate, 1);

    // 1 second of constant 0.5 amplitude
    const sec1 = new Float32Array(sampleRate).fill(0.5);
    timeline.appendFrames(sec1);

    expect(timeline.getTotalFrames()).toBe(1000);
    expect(timeline.getDurationMs()).toBe(1000);
    expect(timeline.getPeaks().length).toBe(PEAKS_PER_SECOND);
    expect(timeline.getPeaks()[0]).toBeCloseTo(0.5, 4);

    // Extract middle 250ms range
    const slice = timeline.extractChannelData(250, 500);
    expect(slice).toHaveLength(1);
    expect(slice[0].length).toBe(250);
    expect(slice[0][0]).toBeCloseTo(0.5, 4);
  });

  it('supports stereo interleaved frames and planar extraction', () => {
    const sampleRate = 1000;
    const timeline = new PcmTimeline(sampleRate, 2);

    const interleaved = new Float32Array(200 * 2);
    for (let f = 0; f < 200; f += 1) {
      interleaved[f * 2] = 0.25; // Left
      interleaved[f * 2 + 1] = -0.75; // Right
    }
    timeline.appendFrames(interleaved);

    expect(timeline.getTotalFrames()).toBe(200);
    expect(timeline.getDurationMs()).toBe(200);

    const [left, right] = timeline.extractChannelData();
    expect(left.length).toBe(200);
    expect(right.length).toBe(200);
    expect(left[50]).toBeCloseTo(0.25, 5);
    expect(right[50]).toBeCloseTo(-0.75, 5);
    // Peak should capture max abs across both channels (0.75)
    expect(timeline.getPeaks()[0]).toBeCloseTo(0.75, 4);
  });

  it('truncates for punch-in with 15ms fade-out, arms fade-in splice, and supports 1-step undo', () => {
    const sampleRate = 1000; // 15 ms = 15 frames
    const timeline = new PcmTimeline(sampleRate, 1);

    const twoSec = new Float32Array(2000).fill(0.8);
    timeline.appendFrames(twoSec);
    expect(timeline.canUndoTruncate()).toBe(false);

    // Truncate at 1.0 second (frame 1000)
    const result = timeline.truncateAtFrame(1000);
    expect(result.trimmedMs).toBe(1000);
    expect(result.newDurationMs).toBe(1000);
    expect(timeline.getTotalFrames()).toBe(1000);
    expect(timeline.canUndoTruncate()).toBe(true);

    // Verify 15ms tail fade-out reaches near 0 at the cut boundary (no click!)
    const [afterTrim] = timeline.extractChannelData();
    expect(afterTrim[900]).toBeCloseTo(0.8, 4); // Unaffected before fade window
    expect(afterTrim[999]).toBeCloseTo(0, 2); // Smoothly faded to ~0 at cut edge

    // Undo restores original 2000 frames without fade-out damage
    const undone = timeline.undoTruncate();
    expect(undone).toBe(true);
    expect(timeline.getTotalFrames()).toBe(2000);
    const [restored] = timeline.extractChannelData();
    expect(restored[999]).toBeCloseTo(0.8, 4);
    expect(timeline.canUndoTruncate()).toBe(false);

    // Truncate again and append new punch-in audio -> verify smooth fade-in
    timeline.truncateAtFrame(1000);
    const punchIn = new Float32Array(500).fill(0.9);
    timeline.appendFrames(punchIn);
    expect(timeline.getTotalFrames()).toBe(1500);
    const [spliced] = timeline.extractChannelData();
    expect(spliced[1000]).toBeLessThan(0.15); // Fades in gently from 0
    expect(spliced[1100]).toBeCloseTo(0.9, 4); // Full level after 15ms fade-in
  });

  it('builds consolidated storage blocks and reloads losslessly', () => {
    const timeline = new PcmTimeline(1000, 2);
    for (let i = 0; i < 10; i += 1) {
      const chunk = new Float32Array(300 * 2).fill(0.1 * (i + 1));
      timeline.appendFrames(chunk);
    }

    const blocks = timeline.buildStorageBlocks(1); // 1 second blocks
    expect(blocks.length).toBe(3);

    const restored = new PcmTimeline(1000, 2);
    restored.loadFromChunks(blocks, timeline.getPeaks());
    expect(restored.getTotalFrames()).toBe(3000);
    expect(restored.getPeaks().length).toBe(timeline.getPeaks().length);
  });
});
