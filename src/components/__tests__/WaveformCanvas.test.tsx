import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { WaveformCanvas } from '../WaveformCanvas';

describe('WaveformCanvas scrub momentum cancellation', () => {
  let rafQueue: Map<number, FrameRequestCallback>;
  let nextRafId: number;
  let nowMs: number;

  const flushNextRaf = (advanceMs = 16) => {
    nowMs += advanceMs;
    const entries = Array.from(rafQueue.entries());
    rafQueue.clear();
    for (const [, cb] of entries) {
      cb(nowMs);
    }
  };

  beforeEach(() => {
    rafQueue = new Map();
    nextRafId = 1;
    nowMs = 1000;

    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      const id = nextRafId++;
      rafQueue.set(id, cb);
      return id;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      rafQueue.delete(id);
    });

    // Stub 2D canvas context for jsdom
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      rect: vi.fn(),
      roundRect: vi.fn(),
      arc: vi.fn(),
      closePath: vi.fn(),
      fillText: vi.fn(),
      createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    } as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function dispatchPointer(
    target: HTMLCanvasElement,
    type: 'pointerdown' | 'pointermove' | 'pointerup',
    clientX: number,
  ) {
    const ev = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY: 40,
    });
    Object.defineProperty(ev, 'pointerId', { value: 1 });
    fireEvent(target, ev);
  }

  function triggerFastFlickRight(canvas: HTMLCanvasElement) {
    // Pointer methods are not implemented on jsdom elements by default
    canvas.setPointerCapture = vi.fn();
    canvas.releasePointerCapture = vi.fn();

    dispatchPointer(canvas, 'pointerdown', 100);
    nowMs += 20;
    dispatchPointer(canvas, 'pointermove', 112);
    nowMs += 20;
    dispatchPointer(canvas, 'pointermove', 124);
    dispatchPointer(canvas, 'pointerup', 124);
  }

  it('cancels active scrub momentum immediately when durationMs changes (Stop here trim / Undo trim)', () => {
    const onSeekMs = vi.fn();
    const { container, rerender } = render(
      <WaveformCanvas
        peaks={[0.2, 0.5, 0.7, 0.4, 0.6, 0.3]}
        durationMs={10000}
        playheadMs={8000}
        phase="paused"
        liveLevel={0}
        onSeekMs={onSeekMs}
      />,
    );

    const canvas = container.querySelector('canvas')!;
    triggerFastFlickRight(canvas);

    // One momentum frame runs and updates playhead, leaving glide still active
    const callsBeforeGlide = onSeekMs.mock.calls.length;
    expect(rafQueue.size).toBeGreaterThan(0);
    flushNextRaf(16);
    expect(onSeekMs.mock.calls.length).toBe(callsBeforeGlide + 1);
    const trimmedPlayhead = onSeekMs.mock.calls[onSeekMs.mock.calls.length - 1][0] as number;
    expect(trimmedPlayhead).toBeGreaterThan(1000);
    expect(rafQueue.size).toBeGreaterThan(0);

    // Simulate "Stop here" trimming durationMs down to trimmedPlayhead while staying paused
    rerender(
      <WaveformCanvas
        peaks={[0.2, 0.5, 0.7]}
        durationMs={trimmedPlayhead}
        playheadMs={trimmedPlayhead}
        phase="paused"
        liveLevel={0}
        onSeekMs={onSeekMs}
      />,
    );

    const callsAfterTrim = onSeekMs.mock.calls.length;
    flushNextRaf(16);
    flushNextRaf(16);
    expect(onSeekMs.mock.calls.length).toBe(callsAfterTrim);
  });

  it('cancels active scrub momentum immediately on external seek (Undo trim / End / -5s / +5s)', () => {
    const onSeekMs = vi.fn();
    const { container, rerender } = render(
      <WaveformCanvas
        peaks={[0.2, 0.5, 0.7, 0.4, 0.6, 0.3]}
        durationMs={10000}
        playheadMs={8000}
        phase="paused"
        liveLevel={0}
        onSeekMs={onSeekMs}
      />,
    );

    const canvas = container.querySelector('canvas')!;
    triggerFastFlickRight(canvas);
    flushNextRaf(16);
    expect(rafQueue.size).toBeGreaterThan(0);

    // Simulate user tapping "End" (jumping playhead back to 10000ms externally while paused)
    rerender(
      <WaveformCanvas
        peaks={[0.2, 0.5, 0.7, 0.4, 0.6, 0.3]}
        durationMs={10000}
        playheadMs={10000}
        phase="paused"
        liveLevel={0}
        onSeekMs={onSeekMs}
      />,
    );

    const callsAfterJump = onSeekMs.mock.calls.length;
    flushNextRaf(16);
    flushNextRaf(16);
    expect(onSeekMs.mock.calls.length).toBe(callsAfterJump);
  });

  it('cancels active scrub momentum immediately when phase leaves paused', () => {
    const onSeekMs = vi.fn();
    const { container, rerender } = render(
      <WaveformCanvas
        peaks={[0.2, 0.5, 0.7, 0.4, 0.6, 0.3]}
        durationMs={10000}
        playheadMs={8000}
        phase="paused"
        liveLevel={0}
        onSeekMs={onSeekMs}
      />,
    );

    const canvas = container.querySelector('canvas')!;
    triggerFastFlickRight(canvas);
    flushNextRaf(16);
    expect(rafQueue.size).toBeGreaterThan(0);

    rerender(
      <WaveformCanvas
        peaks={[0.2, 0.5, 0.7, 0.4, 0.6, 0.3]}
        durationMs={10000}
        playheadMs={5000}
        phase="recording"
        liveLevel={0.4}
        onSeekMs={onSeekMs}
      />,
    );

    const callsAfterRecord = onSeekMs.mock.calls.length;
    flushNextRaf(16);
    expect(onSeekMs.mock.calls.length).toBe(callsAfterRecord);
  });

  it('suspends the live rAF waveform loop while paused (OLED Blackout Mode) and resumes on wake', () => {
    const onSeekMs = vi.fn();
    const { rerender } = render(
      <WaveformCanvas
        peaks={[0.2, 0.5, 0.7]}
        durationMs={2000}
        playheadMs={2000}
        phase="recording"
        liveLevel={0.4}
        paused={false}
        onSeekMs={onSeekMs}
      />,
    );

    expect(rafQueue.size).toBeGreaterThan(0);

    rerender(
      <WaveformCanvas
        peaks={[0.2, 0.5, 0.7]}
        durationMs={2000}
        playheadMs={2000}
        phase="recording"
        liveLevel={0.4}
        paused={true}
        onSeekMs={onSeekMs}
      />,
    );

    expect(rafQueue.size).toBe(0);

    rerender(
      <WaveformCanvas
        peaks={[0.2, 0.5, 0.7]}
        durationMs={2000}
        playheadMs={2000}
        phase="recording"
        liveLevel={0.4}
        paused={false}
        onSeekMs={onSeekMs}
      />,
    );

    expect(rafQueue.size).toBeGreaterThan(0);
  });

  it('glides smoothly without freezing or jumping when audio chunks arrive in 100ms bursts', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 360,
      height: 220,
      top: 0,
      left: 0,
      right: 360,
      bottom: 220,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const onSeekMs = vi.fn();
    let liveDurationMs = 1000;
    let lastChunkPerfMs = nowMs;
    const mockEngine = {
      getLiveRenderState: () => ({
        phase: 'recording' as const,
        durationMs: liveDurationMs,
        playheadMs: liveDurationMs,
        liveLevel: 0.3,
        peaks: [0.2, 0.4, 0.6, 0.5, 0.3],
        lastChunkPerfMs,
        isLiveClockActive: true,
      }),
    };

    render(
      <WaveformCanvas
        engine={mockEngine as never}
        peaks={[0.2, 0.4, 0.6]}
        durationMs={1000}
        playheadMs={1000}
        phase="recording"
        liveLevel={0.3}
        onSeekMs={onSeekMs}
      />,
    );

    // Simulate 1.2s at 60fps where chunks arrive in 100ms bursts (every 6 frames)
    const steps: number[] = [];
    let prevPlayhead: number | null = null;
    for (let f = 1; f <= 72; f += 1) {
      flushNextRaf(16.67);
      if (f % 6 === 0) {
        liveDurationMs += 100;
        lastChunkPerfMs = nowMs;
      }
      const cur = window.__storytapeWaveformPerf?.lastPlayheadMs ?? 0;
      if (prevPlayhead !== null) {
        steps.push(cur - prevPlayhead);
      }
      prevPlayhead = cur;
    }

    expect(window.__storytapeWaveformPerf?.recordingRafFrames).toBeGreaterThanOrEqual(70);
    expect(window.__storytapeWaveformPerf?.playheadStallFrames).toBe(0);
    expect(window.__storytapeWaveformPerf?.playheadJumpFrames).toBe(0);
    // Every frame step stays tightly bounded around 16.67ms (no freeze <10ms, no jump >25ms)
    expect(Math.min(...steps)).toBeGreaterThan(10);
    expect(Math.max(...steps)).toBeLessThan(25);
  });

  it('stays monotonic and freeze-free even when rAF VSync timestamp lags performance.now() by 20ms', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 360,
      height: 220,
      top: 0,
      left: 0,
      right: 360,
      bottom: 220,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const onSeekMs = vi.fn();
    let liveDurationMs = 2000;
    let lastChunkPerfMs = nowMs;
    const mockEngine = {
      getLiveRenderState: () => ({
        phase: 'recording' as const,
        durationMs: liveDurationMs,
        playheadMs: liveDurationMs,
        liveLevel: 0.4,
        peaks: [0.3, 0.5, 0.4],
        lastChunkPerfMs,
        isLiveClockActive: true,
      }),
    };

    render(
      <WaveformCanvas
        engine={mockEngine as never}
        peaks={[0.3, 0.5, 0.4]}
        durationMs={2000}
        playheadMs={2000}
        phase="recording"
        liveLevel={0.4}
        onSeekMs={onSeekMs}
      />,
    );

    // Simulate Android/Safari VSync rAF timestamps running 20ms behind performance.now()
    for (let f = 1; f <= 30; f += 1) {
      nowMs += 16.67;
      if (f % 2 === 0) {
        liveDurationMs += 33.34;
        lastChunkPerfMs = nowMs;
      }
      const entries = Array.from(rafQueue.entries());
      rafQueue.clear();
      for (const [, cb] of entries) {
        cb(nowMs - 20);
      }
    }

    expect(window.__storytapeWaveformPerf?.recordingRafFrames).toBeGreaterThanOrEqual(30);
    expect(window.__storytapeWaveformPerf?.playheadStallFrames).toBe(0);
    expect(window.__storytapeWaveformPerf?.playheadJumpFrames).toBe(0);
  });
});
