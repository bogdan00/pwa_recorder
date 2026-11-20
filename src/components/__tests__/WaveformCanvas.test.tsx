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
});
