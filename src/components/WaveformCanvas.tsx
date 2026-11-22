import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PEAKS_PER_SECOND } from '../audio/pcmTimeline';
import type { RecordingEngine, StudioPhase } from '../audio/recordingEngine';
import './WaveformCanvas.css';

interface WaveformCanvasProps {
  engine?: RecordingEngine;
  peaks: number[];
  durationMs: number;
  playheadMs: number;
  phase: StudioPhase;
  liveLevel: number;
  paused?: boolean;
  onSeekMs: (ms: number) => void;
  onScrubStart?: () => void;
}

interface WaveformThemeColors {
  bg: string;
  active: string;
  recording: string;
  played: string;
  dimmed: string;
  ruler: string;
  grid: string;
  playhead: string;
}

interface WaveformPerfTelemetry {
  renderCount: number;
  rafFrames: number;
  recordingRafFrames: number;
  lastFrameMs: number;
  avgFrameMs: number;
  p95FrameMs: number;
  severeStallsOver50ms: number;
  playheadStallFrames: number;
  playheadJumpFrames: number;
  maxPlayheadStepMs: number;
  lastPlayheadMs: number;
  phase: StudioPhase;
  computeP95FrameMs: () => number;
  resetWindowMetrics: () => void;
}

type WaveformCanvasElement = HTMLCanvasElement & {
  __renderCount?: number;
};

declare global {
  interface Window {
    __storytapeWaveformPerf?: WaveformPerfTelemetry;
  }
}

const DEFAULT_THEME_COLORS: WaveformThemeColors = {
  bg: '#0c0c0e',
  active: '#ede4d8',
  recording: '#e25a44',
  played: '#e6a94d',
  dimmed: 'rgba(237,228,216,0.22)',
  ruler: 'rgba(237,228,216,0.35)',
  grid: 'rgba(237,228,216,0.08)',
  playhead: '#e6a94d',
};

const RULER_FONT = '500 10px "JetBrains Mono", monospace';
const FRAME_RING_SIZE = 256;

function nowPerfMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function configureCanvasContext(ctx: CanvasRenderingContext2D | null): void {
  if (!ctx) return;
  ctx.font = RULER_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineCap = 'butt';
}

function readWaveformThemeColors(): WaveformThemeColors {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') {
    return DEFAULT_THEME_COLORS;
  }
  const styles = getComputedStyle(document.documentElement);
  return {
    bg: styles.getPropertyValue('--bg-surface').trim() || DEFAULT_THEME_COLORS.bg,
    active: styles.getPropertyValue('--wave-active').trim() || DEFAULT_THEME_COLORS.active,
    recording: styles.getPropertyValue('--wave-recording').trim() || DEFAULT_THEME_COLORS.recording,
    played: styles.getPropertyValue('--wave-played').trim() || DEFAULT_THEME_COLORS.played,
    dimmed: styles.getPropertyValue('--wave-dimmed').trim() || DEFAULT_THEME_COLORS.dimmed,
    ruler: styles.getPropertyValue('--wave-ruler').trim() || DEFAULT_THEME_COLORS.ruler,
    grid: styles.getPropertyValue('--wave-grid').trim() || DEFAULT_THEME_COLORS.grid,
    playhead: styles.getPropertyValue('--wave-playhead').trim() || DEFAULT_THEME_COLORS.playhead,
  };
}

function formatRulerTick(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function buildHaloSprite(): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  try {
    const size = 96;
    const half = size / 2;
    const offscreen = document.createElement('canvas');
    offscreen.width = size;
    offscreen.height = size;
    const octx = offscreen.getContext('2d');
    if (!octx || typeof octx.createRadialGradient !== 'function') return null;
    const grad = octx.createRadialGradient(half, half, 2, half, half, half);
    grad.addColorStop(0, 'rgba(226, 90, 68, 0.36)');
    grad.addColorStop(1, 'rgba(226, 90, 68, 0)');
    octx.fillStyle = grad;
    octx.beginPath();
    octx.arc(half, half, half, 0, Math.PI * 2);
    octx.fill();
    return offscreen;
  } catch {
    return null;
  }
}

export const WaveformCanvas: React.FC<WaveformCanvasProps> = ({
  engine,
  peaks,
  durationMs,
  playheadMs,
  phase,
  liveLevel,
  paused = false,
  onSeekMs,
  onScrubStart,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const haloSpriteRef = useRef<HTMLCanvasElement | null>(null);
  const [zoom, setZoom] = useState<1 | 2>(1);
  const [isDragging, setIsDragging] = useState(false);
  const [hasScrubbedOnce, setHasScrubbedOnce] = useState(false);

  // Cached layout geometry & theme colors (never queried inside the draw loop)
  const sizeRef = useRef<{ width: number; height: number; dpr: number }>({
    width: 0,
    height: 0,
    dpr: 1,
  });
  const themeColorsRef = useRef<WaveformThemeColors>(DEFAULT_THEME_COLORS);

  // Latest props ref so the 60/120fps rAF loop stays unbroken across state transitions
  const pixelsPerSecond = 84 * zoom;
  const propsRef = useRef({
    engine,
    peaks,
    durationMs,
    playheadMs,
    phase,
    liveLevel,
    zoom,
    pixelsPerSecond,
  });
  propsRef.current = {
    engine,
    peaks,
    durationMs,
    playheadMs,
    phase,
    liveLevel,
    zoom,
    pixelsPerSecond,
  };

  // Smooth playhead & live-level motion state (keeps rAF clock separate from perf clock)
  const motionRef = useRef<{
    playheadMs: number;
    liveLevel: number;
    lastRafNow: number;
    lastPhase: StudioPhase;
    initialized: boolean;
  }>({
    playheadMs,
    liveLevel: 0,
    lastRafNow: 0,
    lastPhase: phase,
    initialized: false,
  });

  // Zero-allocation frame delta ring buffer & playhead smoothness telemetry
  const frameRingRef = useRef<Float32Array>(new Float32Array(FRAME_RING_SIZE));
  const frameRingCountRef = useRef(0);
  const perfRef = useRef<WaveformPerfTelemetry>({
    renderCount: 0,
    rafFrames: 0,
    recordingRafFrames: 0,
    lastFrameMs: 0,
    avgFrameMs: 0,
    p95FrameMs: 0,
    severeStallsOver50ms: 0,
    playheadStallFrames: 0,
    playheadJumpFrames: 0,
    maxPlayheadStepMs: 0,
    lastPlayheadMs: 0,
    phase,
    computeP95FrameMs: () => {
      const count = Math.min(frameRingCountRef.current, FRAME_RING_SIZE);
      if (count === 0) return 0;
      const sample = Array.from(frameRingRef.current.subarray(0, count)).sort(
        (a, b) => a - b,
      );
      const idx = Math.min(sample.length - 1, Math.floor(sample.length * 0.95));
      return sample[idx] ?? 0;
    },
    resetWindowMetrics: () => {
      const p = perfRef.current;
      frameRingCountRef.current = 0;
      p.recordingRafFrames = 0;
      p.lastFrameMs = 0;
      p.avgFrameMs = 0;
      p.p95FrameMs = 0;
      p.severeStallsOver50ms = 0;
      p.playheadStallFrames = 0;
      p.playheadJumpFrames = 0;
      p.maxPlayheadStepMs = 0;
    },
  });

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
  const lastMomentumSeekRef = useRef<{ ms: number; durationMs: number } | null>(
    null,
  );

  const canScrub =
    (phase === 'paused' || phase === 'playing') && durationMs > 0;

  const stopMomentum = useCallback(() => {
    if (momentumRafRef.current !== null) {
      window.cancelAnimationFrame(momentumRafRef.current);
      momentumRafRef.current = null;
    }
    lastMomentumSeekRef.current = null;
  }, []);

  useEffect(() => stopMomentum, [stopMomentum]);

  // Cancel scrub momentum immediately on phase change, trim/undo duration change,
  // or any external seek (-5s, +5s, End, Stop here, Undo trim).
  useEffect(() => {
    if (momentumRafRef.current === null) return;
    const lastSeek = lastMomentumSeekRef.current;
    if (
      phase !== 'paused' ||
      !lastSeek ||
      lastSeek.durationMs !== durationMs ||
      Math.abs(playheadMs - lastSeek.ms) > 5
    ) {
      stopMomentum();
    }
  }, [phase, durationMs, playheadMs, stopMomentum]);

  // Draw one frame using only cached dimensions, cached theme colors, and live engine/prop data
  const drawFrame = useCallback((now: number, isRafTick: boolean) => {
    const canvas = canvasRef.current as WaveformCanvasElement | null;
    const { width, height, dpr } = sizeRef.current;
    if (!canvas || width <= 0 || height <= 0) return;

    let ctx = ctxRef.current;
    if (!ctx) {
      ctx = canvas.getContext('2d', { alpha: false }) ?? canvas.getContext('2d');
      configureCanvasContext(ctx);
      ctxRef.current = ctx;
    }
    if (!ctx) return;

    const p = propsRef.current;
    const live = p.engine?.getLiveRenderState();
    const useLive = Boolean(live && live.isLiveClockActive);

    const activePhase: StudioPhase = useLive ? live!.phase : p.phase;
    const activeDurationMs = useLive ? live!.durationMs : p.durationMs;
    const activePeaks = useLive ? live!.peaks : p.peaks;
    const rawPlayheadMs = useLive ? live!.playheadMs : p.playheadMs;
    const rawLiveLevel = useLive ? live!.liveLevel : p.liveLevel;
    const perfNow = nowPerfMs();
    const lastChunkPerfMs = useLive ? live!.lastChunkPerfMs : perfNow;

    // Smooth playhead & liveLevel interpolation
    const motion = motionRef.current;
    const perf = perfRef.current;
    const enteringRecording =
      activePhase === 'recording' && motion.lastPhase !== 'recording';
    if (enteringRecording) {
      perf.resetWindowMetrics();
    }

    const dt =
      isRafTick && motion.lastRafNow > 0
        ? Math.min(50, Math.max(0, now - motion.lastRafNow))
        : 16.67;
    const prevPlayheadMs = motion.playheadMs;
    const wasSteadyRecording =
      activePhase === 'recording' &&
      motion.lastPhase === 'recording' &&
      motion.initialized &&
      isRafTick &&
      motion.lastRafNow > 0;

    if (activePhase === 'recording') {
      if (useLive) {
        // Compute elapsed since last chunk strictly in the performance.now() domain
        // (matching RecordingEngine.lastChunkPerfMs) so rAF VSync clock offsets never pull backwards.
        const elapsedSinceChunkMs = Math.min(
          220,
          Math.max(0, perfNow - lastChunkPerfMs),
        );
        const targetPlayheadMs = activeDurationMs + elapsedSinceChunkMs;
        if (
          enteringRecording ||
          !motion.initialized ||
          targetPlayheadMs < motion.playheadMs - 250 ||
          targetPlayheadMs > motion.playheadMs + 400
        ) {
          motion.playheadMs = targetPlayheadMs;
          motion.initialized = true;
        } else {
          // Bounded-slew phase-locked loop (0.75x..1.25x real time, tau=180ms, 250ms ceiling):
          // stays rock-steady at 1.0x across 60/120Hz displays and bursty mobile audio callbacks.
          const predicted = motion.playheadMs + dt;
          const err = targetPlayheadMs - predicted;
          const alpha = 1 - Math.exp(-dt / 180);
          const maxCorrection = dt * 0.25;
          const correction = Math.max(
            -maxCorrection,
            Math.min(maxCorrection, err * alpha),
          );
          const nextPlayhead = predicted + correction;
          motion.playheadMs = Math.max(
            motion.playheadMs,
            Math.min(nextPlayhead, activeDurationMs + 250),
          );
        }

        // Fast attack, smooth decay for center recording halo
        const targetLevel = Math.min(1, Math.max(0, rawLiveLevel));
        const dtLevel = Math.max(1, dt);
        const tau = targetLevel > motion.liveLevel ? 28 : 110;
        const levelAlpha = 1 - Math.exp(-dtLevel / tau);
        motion.liveLevel += (targetLevel - motion.liveLevel) * levelAlpha;
      } else {
        motion.playheadMs = rawPlayheadMs;
        motion.liveLevel = Math.min(1, Math.max(0, rawLiveLevel));
        motion.initialized = true;
      }
    } else {
      motion.playheadMs = rawPlayheadMs;
      motion.liveLevel = 0;
      motion.initialized = true;
    }

    motion.lastRafNow = isRafTick ? now : 0;
    motion.lastPhase = activePhase;

    const displayPlayheadMs = motion.playheadMs;
    const displayLiveLevel = motion.liveLevel;

    // Update lightweight non-DOM frame & playhead smoothness telemetry
    perf.renderCount += 1;
    perf.phase = activePhase;
    perf.lastPlayheadMs = displayPlayheadMs;
    if (isRafTick) {
      if (perf.lastFrameMs > 0) {
        const frameDt = now - perf.lastFrameMs;
        if (frameDt > 0 && frameDt < 250) {
          perf.avgFrameMs =
            perf.avgFrameMs === 0
              ? frameDt
              : perf.avgFrameMs * 0.9 + frameDt * 0.1;
          if (activePhase === 'recording') {
            frameRingRef.current[frameRingCountRef.current % FRAME_RING_SIZE] =
              frameDt;
            frameRingCountRef.current += 1;
            if (frameDt > 50) {
              perf.severeStallsOver50ms += 1;
            }
          }
        }
      }
      if (wasSteadyRecording && useLive && dt >= 8) {
        const step = displayPlayheadMs - prevPlayheadMs;
        if (step > perf.maxPlayheadStepMs) {
          perf.maxPlayheadStepMs = step;
        }
        if (step < 0.5) {
          perf.playheadStallFrames += 1;
        } else if (step > Math.max(45, dt * 2.5)) {
          perf.playheadJumpFrames += 1;
        }
      }
      perf.rafFrames += 1;
      if (activePhase === 'recording') {
        perf.recordingRafFrames += 1;
      }
      perf.lastFrameMs = now;
    } else if (activePhase !== 'recording') {
      perf.lastFrameMs = 0;
    }
    canvas.__renderCount = perf.renderCount;
    if (typeof window !== 'undefined') {
      window.__storytapeWaveformPerf = perf;
    }

    const colors = themeColorsRef.current;
    const pps = p.pixelsPerSecond;
    const rulerHeight = 26;
    const waveTop = rulerHeight + 6;
    const waveBottom = height - 18;
    const waveCenterY = (waveTop + waveBottom) / 2;
    const maxHalfBar = Math.max(12, (waveBottom - waveTop) / 2 - 4);
    const centerX = width / 2;
    const playheadSec = displayPlayheadMs / 1000;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, width, height);

    // Time ruler ticks & subtle vertical guides (batched by stroke style)
    const visibleStartSec = playheadSec - centerX / pps;
    const visibleEndSec = playheadSec + (width - centerX) / pps;
    const majorStep = p.zoom === 2 ? 2 : 5;
    const firstTick = Math.max(0, Math.floor(visibleStartSec));
    const lastTick = Math.ceil(visibleEndSec);

    ctx.lineWidth = 1;

    // 1. Batched center baseline + vertical major grid lines (ONE stroke)
    ctx.strokeStyle = colors.grid;
    ctx.beginPath();
    ctx.moveTo(0, waveCenterY);
    ctx.lineTo(width, waveCenterY);
    const firstMajorTick =
      firstTick % majorStep === 0
        ? firstTick
        : firstTick + (majorStep - (firstTick % majorStep));
    for (let sec = firstMajorTick; sec <= lastTick; sec += majorStep) {
      const x = centerX + (sec - playheadSec) * pps;
      if (x < -20 || x > width + 20) continue;
      ctx.moveTo(x, waveTop);
      ctx.lineTo(x, waveBottom);
    }
    ctx.stroke();

    // 2. Batched minor ruler ticks (ONE stroke)
    ctx.beginPath();
    let hasMinorTicks = false;
    for (let sec = firstTick; sec <= lastTick; sec += 1) {
      if (sec % majorStep === 0) continue;
      const x = centerX + (sec - playheadSec) * pps;
      if (x < -20 || x > width + 20) continue;
      ctx.moveTo(x, 20);
      ctx.lineTo(x, rulerHeight);
      hasMinorTicks = true;
    }
    if (hasMinorTicks) {
      ctx.stroke();
    }

    // 3. Batched major ruler ticks (ONE stroke) + ruler labels (using cached ctx.font)
    ctx.strokeStyle = colors.ruler;
    ctx.beginPath();
    let hasMajorTicks = false;
    for (let sec = firstMajorTick; sec <= lastTick; sec += majorStep) {
      const x = centerX + (sec - playheadSec) * pps;
      if (x < -20 || x > width + 20) continue;
      ctx.moveTo(x, 15);
      ctx.lineTo(x, rulerHeight);
      hasMajorTicks = true;
    }
    if (hasMajorTicks) {
      ctx.stroke();

      ctx.fillStyle = colors.ruler;
      for (let sec = firstMajorTick; sec <= lastTick; sec += majorStep) {
        const x = centerX + (sec - playheadSec) * pps;
        if (x < -20 || x > width + 20) continue;
        ctx.fillText(formatRulerTick(sec), x, 4);
      }
    }

    // 4. Batched waveform bars (50 peaks/sec) — at most 2 rect()+fill() calls per frame
    //    (zero round-cap semicircle tessellation on mobile GPUs!)
    const peakCount = activePeaks.length;
    if (peakCount > 0) {
      const barSpacing = pps / PEAKS_PER_SECOND;
      const barWidth = Math.max(1.8, Math.min(4.2, barSpacing * 0.62));
      const barRadius = barWidth / 2;
      const stride = barSpacing < 2.2 ? Math.ceil(2.2 / barSpacing) : 1;

      const startIdx = Math.max(
        0,
        Math.floor(visibleStartSec * PEAKS_PER_SECOND) - stride,
      );
      const endIdx = Math.min(
        peakCount - 1,
        Math.ceil(visibleEndSec * PEAKS_PER_SECOND) + stride,
      );

      if (startIdx <= endIdx) {
        const isScrubbedBack =
          activePhase === 'paused' &&
          activeDurationMs > 0 &&
          activeDurationMs - displayPlayheadMs > 300;

        let leftColor = colors.active;
        let rightColor = colors.active;
        let splitSec = Infinity;

        if (activePhase === 'recording') {
          // Recent 1.2s glows warm terracotta, older bars settle into warm cream
          leftColor = colors.active;
          rightColor = colors.recording;
          splitSec = playheadSec - 1.2;
        } else if (activePhase === 'playing') {
          leftColor = colors.played;
          rightColor = colors.active;
          splitSec = playheadSec + 0.015;
        } else if (isScrubbedBack) {
          // Audio after playhead dims gently to preview what "Re-record from here" would trim
          leftColor = colors.active;
          rightColor = colors.dimmed;
          splitSec = playheadSec + 0.015;
        }

        const drawBarBucket = (
          fromIdx: number,
          toIdx: number,
          color: string,
        ) => {
          if (fromIdx > toIdx) return;
          ctx!.fillStyle = color;
          ctx!.beginPath();
          let drawn = false;
          for (let i = fromIdx; i <= toIdx; i += stride) {
            let amp = activePeaks[i] || 0;
            if (stride > 1) {
              for (let k = 1; k < stride && i + k <= endIdx; k += 1) {
                const v = activePeaks[i + k];
                if (v > amp) amp = v;
              }
            }

            const barSec = (i + 0.5) / PEAKS_PER_SECOND;
            const x = centerX + (barSec - playheadSec) * pps;
            if (x < -6 || x > width + 6) continue;

            // Subtle perceptual curve so soft bedtime whispers remain clearly visible
            const shaped = Math.pow(Math.min(1, amp * 1.15), 0.72);
            const halfH = Math.max(2, shaped * maxHalfBar);
            ctx!.rect(x - barRadius, waveCenterY - halfH, barWidth, halfH * 2);
            drawn = true;
          }
          if (drawn) {
            ctx!.fill();
          }
        };

        if (leftColor === rightColor) {
          drawBarBucket(startIdx, endIdx, leftColor);
        } else {
          // Largest index whose barSec = (i + 0.5) / PEAKS_PER_SECOND <= splitSec
          const rawSplit = Math.floor(splitSec * PEAKS_PER_SECOND - 0.5);
          if (rawSplit < startIdx) {
            drawBarBucket(startIdx, endIdx, rightColor);
          } else if (rawSplit >= endIdx) {
            drawBarBucket(startIdx, endIdx, leftColor);
          } else {
            const steps = Math.floor((rawSplit - startIdx) / stride);
            const leftLast = startIdx + steps * stride;
            drawBarBucket(startIdx, leftLast, leftColor);
            drawBarBucket(leftLast + stride, endIdx, rightColor);
          }
        }
      }
    }

    // Live input halo right at center playhead while recording (cached offscreen radial sprite)
    if (activePhase === 'recording') {
      const liveRadius = (6 + Math.min(1, displayLiveLevel * 1.4) * 20) * 1.6;
      if (!haloSpriteRef.current) {
        haloSpriteRef.current = buildHaloSprite();
      }
      const halo = haloSpriteRef.current;
      if (halo && typeof ctx.drawImage === 'function') {
        ctx.drawImage(
          halo,
          centerX - liveRadius,
          waveCenterY - liveRadius,
          liveRadius * 2,
          liveRadius * 2,
        );
      }
    }

    // Center fixed playhead hairline + top cap
    const playheadColor =
      activePhase === 'recording' ? colors.recording : colors.playhead;
    ctx.strokeStyle = playheadColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(centerX, rulerHeight - 2);
    ctx.lineTo(centerX, waveBottom + 4);
    ctx.stroke();

    ctx.fillStyle = playheadColor;
    ctx.beginPath();
    ctx.arc(centerX, rulerHeight - 2, 4, 0, Math.PI * 2);
    ctx.fill();
  }, []);

  // Cache CSS theme variables on mount and refresh ONLY when data-theme changes
  useEffect(() => {
    themeColorsRef.current = readWaveformThemeColors();
    drawFrame(nowPerfMs(), false);

    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') {
      return;
    }
    const observer = new MutationObserver(() => {
      themeColorsRef.current = readWaveformThemeColors();
      drawFrame(nowPerfMs(), false);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, [drawFrame]);

  // Measure canvas size on mount and refresh ONLY inside ResizeObserver
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const updateSize = (rawWidth: number, rawHeight: number) => {
      const width = Math.max(0, Math.floor(rawWidth));
      const height = Math.max(0, Math.floor(rawHeight));
      // Cap DPR at 2 (Retina-crisp while cutting pixel fill & commit bandwidth by 56% on 3x phones)
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (width <= 0 || height <= 0) return;

      const pixelW = Math.floor(width * dpr);
      const pixelH = Math.floor(height * dpr);
      const prev = sizeRef.current;

      if (
        prev.width !== width ||
        prev.height !== height ||
        prev.dpr !== dpr ||
        canvas.width !== pixelW ||
        canvas.height !== pixelH
      ) {
        sizeRef.current = { width, height, dpr };
        if (canvas.width !== pixelW) canvas.width = pixelW;
        if (canvas.height !== pixelH) canvas.height = pixelH;
        const nextCtx =
          canvas.getContext('2d', { alpha: false }) ?? canvas.getContext('2d');
        configureCanvasContext(nextCtx);
        ctxRef.current = nextCtx;
        drawFrame(nowPerfMs(), false);
      }
    };

    const initialRect = container.getBoundingClientRect();
    updateSize(initialRect.width, initialRect.height);

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) {
          updateSize(entry.contentRect.width, entry.contentRect.height);
        } else {
          const rect = container.getBoundingClientRect();
          updateSize(rect.width, rect.height);
        }
      });
      ro.observe(container);
      return () => ro.disconnect();
    }

    const onWindowResize = () => {
      const rect = container.getBoundingClientRect();
      updateSize(rect.width, rect.height);
    };
    window.addEventListener('resize', onWindowResize);
    return () => window.removeEventListener('resize', onWindowResize);
  }, [drawFrame]);

  // Continuous 60/120fps requestAnimationFrame loop while recording or preview-playing
  // (automatically suspended while OLED Blackout Mode covers the screen)
  useEffect(() => {
    if (paused || (phase !== 'recording' && phase !== 'playing')) {
      return;
    }

    let rafId = 0;
    let active = true;

    const tick = (now: number) => {
      if (!active) return;
      drawFrame(now, true);
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      active = false;
      window.cancelAnimationFrame(rafId);
    };
  }, [phase, paused, drawFrame]);

  // Static/paused/idle redraws on prop changes (rAF loop handles recording/playing)
  useEffect(() => {
    if (paused || phase === 'recording' || phase === 'playing') return;
    drawFrame(nowPerfMs(), false);
  }, [durationMs, liveLevel, peaks, phase, playheadMs, zoom, paused, drawFrame]);

  // Pointer drag-to-scrub handlers (touch + mouse)
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canScrub) return;
    stopMomentum();
    e.currentTarget.setPointerCapture(e.pointerId);
    const live = engine?.getLiveRenderState();
    const startPlayhead =
      live && live.isLiveClockActive ? live.playheadMs : playheadMs;
    onScrubStart?.();
    setIsDragging(true);
    setHasScrubbedOnce(true);

    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startPlayheadMs: startPlayhead,
      lastX: e.clientX,
      lastTime: performance.now(),
      velocityPxPerMs: 0,
      currentMs: startPlayhead,
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
    const startDurationMs = durationMs;
    lastMomentumSeekRef.current = { ms: current, durationMs: startDurationMs };

    const glide = (now: number) => {
      const p = propsRef.current;
      const live = p.engine?.getLiveRenderState();
      const livePhase = live ? live.phase : p.phase;
      const liveDurationMs = live ? live.durationMs : p.durationMs;

      if (livePhase !== 'paused' || liveDurationMs !== startDurationMs) {
        momentumRafRef.current = null;
        lastMomentumSeekRef.current = null;
        return;
      }

      const dt = Math.min(32, Math.max(1, now - lastTick));
      lastTick = now;

      const deltaMs = -((velocity * dt) / p.pixelsPerSecond) * 1000;
      current = Math.max(0, Math.min(startDurationMs, current + deltaMs));
      lastMomentumSeekRef.current = { ms: current, durationMs: startDurationMs };
      onSeekMs(current);

      velocity *= Math.pow(0.92, dt / 16);
      if (Math.abs(velocity) > 0.02 && current > 0 && current < startDurationMs) {
        momentumRafRef.current = window.requestAnimationFrame(glide);
      } else {
        momentumRafRef.current = null;
        lastMomentumSeekRef.current = null;
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
