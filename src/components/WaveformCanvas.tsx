import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PEAKS_PER_SECOND } from '../audio/pcmTimeline';
import type { StudioPhase } from '../audio/recordingEngine';
import './WaveformCanvas.css';

interface WaveformCanvasProps {
  peaks: number[];
  durationMs: number;
  playheadMs: number;
  phase: StudioPhase;
  liveLevel: number;
  onSeekMs: (ms: number) => void;
  onScrubStart?: () => void;
}

function formatRulerTick(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export const WaveformCanvas: React.FC<WaveformCanvasProps> = ({
  peaks,
  durationMs,
  playheadMs,
  phase,
  liveLevel,
  onSeekMs,
  onScrubStart,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [zoom, setZoom] = useState<1 | 2>(1);
  const [isDragging, setIsDragging] = useState(false);
  const [hasScrubbedOnce, setHasScrubbedOnce] = useState(false);

  // Pointer scrubbing + momentum refs
  const dragRef = useRef<{
    pointerId: number | null;
    startX: number;
    startPlayheadMs: number;
    lastX: number;
    lastTime: number;
    velocityPxPerMs: number;
    currentMs: number;
  }>({
    pointerId: null,
    startX: 0,
    startPlayheadMs: 0,
    lastX: 0,
    lastTime: 0,
    velocityPxPerMs: 0,
    currentMs: 0,
  });
  const momentumRafRef = useRef<number | null>(null);

  const pixelsPerSecond = 84 * zoom;
  const canScrub =
    (phase === 'paused' || phase === 'playing') && durationMs > 0;

  const stopMomentum = useCallback(() => {
    if (momentumRafRef.current !== null) {
      window.cancelAnimationFrame(momentumRafRef.current);
      momentumRafRef.current = null;
    }
  }, []);

  useEffect(() => stopMomentum, [stopMomentum]);

  // Draw crisp retina waveform whenever peaks, playhead, phase, liveLevel, or resize changes
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const rect = container.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 3);

    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const styles = getComputedStyle(document.documentElement);
    const colActive = styles.getPropertyValue('--wave-active').trim() || '#ede4d8';
    const colRecording = styles.getPropertyValue('--wave-recording').trim() || '#e25a44';
    const colPlayed = styles.getPropertyValue('--wave-played').trim() || '#e6a94d';
    const colDimmed = styles.getPropertyValue('--wave-dimmed').trim() || 'rgba(237,228,216,0.22)';
    const colRuler = styles.getPropertyValue('--wave-ruler').trim() || 'rgba(237,228,216,0.35)';
    const colGrid = styles.getPropertyValue('--wave-grid').trim() || 'rgba(237,228,216,0.08)';
    const colPlayhead = styles.getPropertyValue('--wave-playhead').trim() || '#e6a94d';

    const rulerHeight = 26;
    const waveTop = rulerHeight + 6;
    const waveBottom = height - 18;
    const waveCenterY = (waveTop + waveBottom) / 2;
    const maxHalfBar = Math.max(12, (waveBottom - waveTop) / 2 - 4);
    const centerX = width / 2;
    const playheadSec = playheadMs / 1000;

    // Subtle center baseline
    ctx.strokeStyle = colGrid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, waveCenterY);
    ctx.lineTo(width, waveCenterY);
    ctx.stroke();

    // Time ruler ticks & subtle vertical guides
    const visibleStartSec = playheadSec - centerX / pixelsPerSecond;
    const visibleEndSec = playheadSec + (width - centerX) / pixelsPerSecond;
    const majorStep = zoom === 2 ? 2 : 5;
    const minorStep = 1;
    const firstTick = Math.max(0, Math.floor(visibleStartSec));
    const lastTick = Math.ceil(visibleEndSec);

    ctx.font = '500 10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    for (let sec = firstTick; sec <= lastTick; sec += minorStep) {
      const x = centerX + (sec - playheadSec) * pixelsPerSecond;
      if (x < -20 || x > width + 20) continue;
      const isMajor = sec % majorStep === 0;

      ctx.strokeStyle = isMajor ? colRuler : colGrid;
      ctx.beginPath();
      ctx.moveTo(x, isMajor ? 15 : 20);
      ctx.lineTo(x, rulerHeight);
      ctx.stroke();

      if (isMajor) {
        ctx.fillStyle = colRuler;
        ctx.fillText(formatRulerTick(sec), x, 4);

        ctx.strokeStyle = colGrid;
        ctx.beginPath();
        ctx.moveTo(x, waveTop);
        ctx.lineTo(x, waveBottom);
        ctx.stroke();
      }
    }

    // Draw waveform bars (50 peaks/sec)
    if (peaks.length > 0) {
      const barSpacing = pixelsPerSecond / PEAKS_PER_SECOND;
      const barWidth = Math.max(1.8, Math.min(4.2, barSpacing * 0.62));
      const stride = barSpacing < 2.2 ? Math.ceil(2.2 / barSpacing) : 1;

      const startIdx = Math.max(
        0,
        Math.floor(visibleStartSec * PEAKS_PER_SECOND) - stride,
      );
      const endIdx = Math.min(
        peaks.length - 1,
        Math.ceil(visibleEndSec * PEAKS_PER_SECOND) + stride,
      );

      const isScrubbedBack =
        phase === 'paused' && durationMs > 0 && durationMs - playheadMs > 300;

      for (let i = startIdx; i <= endIdx; i += stride) {
        let amp = peaks[i] || 0;
        if (stride > 1) {
          for (let k = 1; k < stride && i + k <= endIdx; k += 1) {
            if (peaks[i + k] > amp) amp = peaks[i + k];
          }
        }

        const barSec = (i + 0.5) / PEAKS_PER_SECOND;
        const x = centerX + (barSec - playheadSec) * pixelsPerSecond;
        if (x < -6 || x > width + 6) continue;

        // Subtle perceptual curve so soft bedtime whispers remain clearly visible
        const shaped = Math.pow(Math.min(1, amp * 1.15), 0.72);
        const halfH = Math.max(2, shaped * maxHalfBar);
        const isAfterPlayhead = barSec > playheadSec + 0.015;

        if (phase === 'recording') {
          // Recent 1.5s glows warm terracotta, older bars settle into warm cream
          ctx.fillStyle =
            playheadSec - barSec < 1.2 ? colRecording : colActive;
        } else if (phase === 'playing') {
          ctx.fillStyle = isAfterPlayhead ? colActive : colPlayed;
        } else if (isScrubbedBack && isAfterPlayhead) {
          // Audio after playhead dims gently to preview what "Re-record from here" would trim
          ctx.fillStyle = colDimmed;
        } else {
          ctx.fillStyle = colActive;
        }

        ctx.beginPath();
        ctx.roundRect(
          x - barWidth / 2,
          waveCenterY - halfH,
          barWidth,
          halfH * 2,
          barWidth / 2,
        );
        ctx.fill();
      }
    }

    // Live input halo right at center playhead while recording
    if (phase === 'recording') {
      const liveRadius = 6 + Math.min(1, liveLevel * 1.4) * 20;
      const grad = ctx.createRadialGradient(
        centerX,
        waveCenterY,
        2,
        centerX,
        waveCenterY,
        liveRadius * 1.6,
      );
      grad.addColorStop(0, 'rgba(226, 90, 68, 0.36)');
      grad.addColorStop(1, 'rgba(226, 90, 68, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(centerX, waveCenterY, liveRadius * 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // Center fixed playhead hairline + top/bottom caps
    ctx.strokeStyle = phase === 'recording' ? colRecording : colPlayhead;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(centerX, rulerHeight - 2);
    ctx.lineTo(centerX, waveBottom + 4);
    ctx.stroke();

    ctx.fillStyle = phase === 'recording' ? colRecording : colPlayhead;
    ctx.beginPath();
    ctx.arc(centerX, rulerHeight - 2, 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }, [durationMs, liveLevel, peaks, phase, pixelsPerSecond, playheadMs, zoom]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(container);
    return () => ro.disconnect();
  }, [draw]);

  // Pointer drag-to-scrub handlers (touch + mouse)
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canScrub) return;
    stopMomentum();
    e.currentTarget.setPointerCapture(e.pointerId);
    onScrubStart?.();
    setIsDragging(true);
    setHasScrubbedOnce(true);

    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startPlayheadMs: playheadMs,
      lastX: e.clientX,
      lastTime: performance.now(),
      velocityPxPerMs: 0,
      currentMs: playheadMs,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!isDragging || drag.pointerId !== e.pointerId) return;

    const now = performance.now();
    const dt = Math.max(1, now - drag.lastTime);
    const dxStep = e.clientX - drag.lastX;
    drag.velocityPxPerMs = 0.7 * (dxStep / dt) + 0.3 * drag.velocityPxPerMs;
    drag.lastX = e.clientX;
    drag.lastTime = now;

    // Dragging waveform RIGHT moves earlier audio under the center playhead (decreases playheadMs)
    const totalDx = e.clientX - drag.startX;
    const deltaMs = -(totalDx / pixelsPerSecond) * 1000;
    const nextMs = Math.max(0, Math.min(durationMs, drag.startPlayheadMs + deltaMs));
    drag.currentMs = nextMs;
    onSeekMs(nextMs);
  };

  const handlePointerEnd = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!isDragging || drag.pointerId !== e.pointerId) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Ignore if not captured
    }
    drag.pointerId = null;
    setIsDragging(false);

    // Apply smooth momentum glide if flicked quickly
    let velocity = drag.velocityPxPerMs;
    if (Math.abs(velocity) < 0.08) return;

    let lastTick = performance.now();
    let current = drag.currentMs;

    const glide = (now: number) => {
      const dt = Math.min(32, Math.max(1, now - lastTick));
      lastTick = now;

      const deltaMs = -((velocity * dt) / pixelsPerSecond) * 1000;
      current = Math.max(0, Math.min(durationMs, current + deltaMs));
      onSeekMs(current);

      velocity *= Math.pow(0.92, dt / 16);
      if (Math.abs(velocity) > 0.02 && current > 0 && current < durationMs) {
        momentumRafRef.current = window.requestAnimationFrame(glide);
      } else {
        momentumRafRef.current = null;
      }
    };

    momentumRafRef.current = window.requestAnimationFrame(glide);
  };

  return (
    <div
      ref={containerRef}
      className={`waveform-stage ${canScrub ? 'waveform-stage--scrubbable' : ''} ${isDragging ? 'waveform-stage--dragging' : ''}`}
      data-testid="waveform-stage"
    >
      <canvas
        ref={canvasRef}
        className="waveform-canvas"
        aria-label={
          canScrub
            ? 'Interactive audio waveform. Drag left or right to scrub.'
            : 'Live audio recording waveform'
        }
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
      />

      {durationMs > 0 && (
        <div className="waveform-overlay-top">
          <button
            type="button"
            className="waveform-zoom-btn"
            onClick={() => setZoom((z) => (z === 1 ? 2 : 1))}
            aria-label={`Waveform zoom ${zoom}x`}
          >
            {zoom}×
          </button>
        </div>
      )}

      {phase === 'idle' && durationMs === 0 && (
        <div className="waveform-empty-prompt">
          <span>Tap the record button below to begin reading</span>
        </div>
      )}

      {phase === 'paused' && durationMs > 0 && !hasScrubbedOnce && (
        <div className="waveform-hint">Drag waveform to scrub · Tap Play to check</div>
      )}
    </div>
  );
};
