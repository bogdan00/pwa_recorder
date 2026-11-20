import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbConnectionForTests } from '../../storage/db';
import { PcmTimeline } from '../pcmTimeline';
import { RecordingEngine } from '../recordingEngine';

describe('RecordingEngine.trimToPlayhead', () => {
  beforeEach(async () => {
    await resetDbConnectionForTests();
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
});
