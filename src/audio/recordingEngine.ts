import type {
  ActiveDraft,
  AudioDeviceSettings,
  AudioQualitySettings,
  ChannelCountOption,
} from '../types/models';
import {
  deleteDraft,
  getDraft,
  loadDraftChunks,
  replaceDraftSnapshot,
  saveDraftChunk,
  saveDraftMeta,
} from '../storage/db';
import { createId, downsamplePeaks } from '../utils/format';
import { acquireMicStream } from './audioDevices';
import { buildStudioInputStrip } from './inputStrip';
import { encodeAudio, type EncodedAudioResult } from './nativeEncoder';
import {
  attachPcmCapture,
  type PcmCaptureHandle,
  teardownPcmCapture,
} from './pcmCapture';
import { PcmTimeline } from './pcmTimeline';
import { encodeWav } from './wavEncoder';

export type StudioPhase = 'idle' | 'recording' | 'paused' | 'playing';

export interface StudioSnapshot {
  phase: StudioPhase;
  durationMs: number;
  playheadMs: number;
  liveLevel: number;
  peaks: number[];
  canUndoTrim: boolean;
  activeDeviceLabel: string;
  actualSampleRate: number;
  channels: ChannelCountOption;
  draftId: string | null;
}

export interface LiveWaveformState {
  phase: StudioPhase;
  durationMs: number;
  playheadMs: number;
  liveLevel: number;
  peaks: readonly number[];
  lastChunkPerfMs: number;
  isLiveClockActive: boolean;
}

export interface StartRecordingFeedback {
  usedFallbackDevice: boolean;
  fallbackReason?: string;
}

const DRAFT_FLUSH_SECONDS = 2;
const LIVE_EMIT_INTERVAL_MS = 65; // ~15 Hz React UI updates during live capture/preview
const EMPTY_PEAKS: readonly number[] = [];

function nowPerfMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export class RecordingEngine {
  private projectId: string;
  private draftId: string | null = null;
  private phase: StudioPhase = 'idle';
  private timeline: PcmTimeline | null = null;
  private playheadMs = 0;
  private liveLevel = 0;
  private lastChunkPerfMs = 0;
  private lastEmitPerfMs = 0;
  private hasEmittedFirstChunkInSession = false;

  // Capture graph
  private audioCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private inputStripNodes: AudioNode[] = [];
  private workletNode: AudioWorkletNode | null = null;
  private captureHandle: PcmCaptureHandle | null = null;
  private activeDeviceLabel = '';

  // Preview playback graph
  private previewSource: AudioBufferSourceNode | null = null;
  private previewStartCtxTime = 0;
  private previewStartOffsetMs = 0;
  private previewRafId: number | null = null;

  // Crash-safe IndexedDB chunk accumulator
  private pendingPersistBuffers: Float32Array[] = [];
  private pendingPersistSamples = 0;
  private persistedChunkCount = 0;
  private draftPersistQueue: Promise<void> = Promise.resolve();

  // Wake Lock
  private wakeLock: WakeLockSentinel | null = null;
  private keepScreenAwake = true;

  // Listeners
  private listeners = new Set<(snap: StudioSnapshot) => void>();
  private visibilityHandler: (() => void) | null = null;

  constructor(projectId: string) {
    this.projectId = projectId;
  }

  subscribe(listener: (snap: StudioSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): StudioSnapshot {
    return {
      phase: this.phase,
      durationMs: this.timeline?.getDurationMs() ?? 0,
      playheadMs: this.playheadMs,
      liveLevel: this.liveLevel,
      peaks: this.timeline?.getPeaks() ?? [],
      canUndoTrim: this.timeline?.canUndoTruncate() ?? false,
      activeDeviceLabel: this.activeDeviceLabel,
      actualSampleRate: this.timeline?.sampleRate ?? 44100,
      channels: this.timeline?.channels ?? 1,
      draftId: this.draftId,
    };
  }

  /**
   * Zero-copy live waveform state read directly from the canvas rAF loop
   * at 60/120 fps without triggering React re-renders or copying the peaks array.
   */
  getLiveRenderState(): LiveWaveformState {
    const durationMs = this.timeline?.getDurationMs() ?? 0;
    let playheadMs = this.playheadMs;
    let isLiveClockActive = false;

    if (this.phase === 'recording' && this.timeline) {
      isLiveClockActive = true;
    } else if (
      this.phase === 'playing' &&
      this.audioCtx &&
      this.timeline &&
      this.previewSource
    ) {
      const elapsedMs = Math.max(
        0,
        (this.audioCtx.currentTime - this.previewStartCtxTime) * 1000,
      );
      playheadMs = Math.min(durationMs, this.previewStartOffsetMs + elapsedMs);
      isLiveClockActive = true;
    }

    return {
      phase: this.phase,
      durationMs,
      playheadMs,
      liveLevel: this.liveLevel,
      peaks: this.timeline ? this.timeline.getPeaks() : EMPTY_PEAKS,
      lastChunkPerfMs: this.lastChunkPerfMs,
      isLiveClockActive,
    };
  }

  private emit(): void {
    this.lastEmitPerfMs = nowPerfMs();
    const snap = this.getSnapshot();
    this.listeners.forEach((fn) => fn(snap));
  }

  /**
   * Restore an unfinished recording draft from IndexedDB in paused state.
   */
  async loadDraft(draftId: string): Promise<boolean> {
    const draft = await getDraft(draftId);
    if (!draft) return false;
    const chunks = await loadDraftChunks(draftId);
    if (chunks.length === 0) return false;

    this.draftId = draft.id;
    this.timeline = new PcmTimeline(draft.sampleRate, draft.channels);
    this.timeline.loadFromChunks(chunks, draft.peaks);
    this.persistedChunkCount = chunks.length;
    this.phase = 'paused';
    this.playheadMs = this.timeline.getDurationMs();
    this.emit();
    return true;
  }

  /**
   * Start a fresh recording or safely append at the end of a paused take.
   */
  async startOrResumeFromEnd(
    deviceSettings: AudioDeviceSettings,
    quality: AudioQualitySettings,
    keepScreenAwake: boolean,
  ): Promise<StartRecordingFeedback> {
    this.stopPreviewPlayback();
    this.keepScreenAwake = keepScreenAwake;

    if (this.timeline) {
      // Safe default: snap playhead to end and continue appending with click-free fade-in
      this.playheadMs = this.timeline.getDurationMs();
      this.timeline.clearUndo();
      this.timeline.armResumeFadeIn();
    }

    return this.beginMicCapture(deviceSettings, quality);
  }

  /**
   * Punch-in: truncates everything after current playheadMs (15ms anti-click splice + undo snapshot)
   * and immediately resumes recording from that exact position.
   */
  async punchInFromPlayhead(
    deviceSettings: AudioDeviceSettings,
    quality: AudioQualitySettings,
    keepScreenAwake: boolean,
  ): Promise<StartRecordingFeedback & { trimmedMs: number }> {
    this.stopPreviewPlayback();
    this.keepScreenAwake = keepScreenAwake;

    let trimmedMs = 0;
    if (this.timeline) {
      const targetFrame = this.timeline.msToFrame(this.playheadMs);
      const res = this.timeline.truncateAtFrame(targetFrame);
      trimmedMs = res.trimmedMs;
      this.playheadMs = res.newDurationMs;
      await this.syncFullDraftToDb();
    }

    const feedback = await this.beginMicCapture(deviceSettings, quality);
    return { ...feedback, trimmedMs };
  }

  /**
   * Trims everything after current playheadMs (15ms smooth tail fade-out + 1-step undo snapshot)
   * without restarting the microphone — used by "Stop here" so the user can cut trailing noise
   * and immediately save the recording.
   */
  async trimToPlayhead(): Promise<{ trimmedMs: number; newDurationMs: number }> {
    this.stopPreviewPlayback();
    if (this.phase === 'recording') {
      await this.pause();
    }

    if (!this.timeline) {
      return { trimmedMs: 0, newDurationMs: 0 };
    }

    const targetFrame = this.timeline.msToFrame(this.playheadMs);
    const res = this.timeline.truncateAtFrame(targetFrame);
    this.playheadMs = res.newDurationMs;
    this.phase = res.newDurationMs > 0 ? 'paused' : 'idle';
    await this.syncFullDraftToDb();
    this.emit();
    return res;
  }

  /**
   * Restores the tail removed by the most recent punch-in (while paused).
   */
  async undoLastTrim(): Promise<boolean> {
    if (!this.timeline || !this.timeline.canUndoTruncate()) return false;
    if (this.phase === 'recording') {
      await this.pause();
    }
    this.stopPreviewPlayback();
    const ok = this.timeline.undoTruncate();
    if (ok) {
      const restoredDurationMs = this.timeline.getDurationMs();
      this.playheadMs = restoredDurationMs;
      this.phase = restoredDurationMs > 0 ? 'paused' : 'idle';
      await this.syncFullDraftToDb();
      this.emit();
    }
    return ok;
  }

  async pause(): Promise<void> {
    if (this.phase !== 'recording') return;

    this.teardownMicCapture();
    // Apply 15ms raised-cosine tail fade-out and arm 15ms fade-in for click-free Resume
    this.timeline?.markPauseBoundary();
    this.liveLevel = 0;
    this.phase = 'paused';
    this.playheadMs = this.timeline?.getDurationMs() ?? 0;
    this.emit();

    await this.flushPendingDraftToDb();
    await this.releaseWakeLock();
  }

  /**
   * Seek playhead while paused or playing (used by drag-to-scrub waveform & -5s/+5s buttons).
   */
  seekToMs(ms: number): void {
    const safeMs = Number.isFinite(ms) ? ms : 0;
    const maxMs = this.timeline?.getDurationMs() ?? 0;
    const clamped = Math.max(0, Math.min(safeMs, maxMs));
    this.playheadMs = clamped;

    if (this.phase === 'playing') {
      this.stopPreviewPlayback();
      void this.playPreviewFromPlayhead();
      return;
    }

    this.emit();
  }

  async playPreviewFromPlayhead(): Promise<void> {
    if (!this.timeline || this.timeline.getTotalFrames() === 0) return;
    if (this.phase === 'recording') {
      await this.pause();
    }

    this.stopPreviewPlayback();

    const durationMs = this.timeline.getDurationMs();
    if (this.playheadMs >= durationMs - 40) {
      // If playhead is already at the very end, jump back 5s so tapping Play previews the last bit!
      this.playheadMs = Math.max(0, durationMs - 5000);
    }

    const ctx = await this.ensureAudioContext(this.timeline.sampleRate);
    const startFrame = this.timeline.msToFrame(this.playheadMs);
    const totalFrames = this.timeline.getTotalFrames();
    const length = totalFrames - startFrame;
    if (length <= 0) return;

    const channelData = this.timeline.extractChannelData(startFrame, totalFrames);
    const audioBuffer = ctx.createBuffer(
      this.timeline.channels,
      length,
      this.timeline.sampleRate,
    );
    for (let ch = 0; ch < this.timeline.channels; ch += 1) {
      audioBuffer.copyToChannel(new Float32Array(channelData[ch]), ch);
    }

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    this.previewSource = source;
    this.previewStartCtxTime = ctx.currentTime;
    this.previewStartOffsetMs = this.playheadMs;
    this.lastChunkPerfMs = nowPerfMs();
    this.phase = 'playing';

    source.onended = () => {
      if (this.previewSource !== source) return;
      this.previewSource = null;
      if (this.previewRafId !== null) {
        window.cancelAnimationFrame(this.previewRafId);
        this.previewRafId = null;
      }
      this.playheadMs = this.timeline?.getDurationMs() ?? 0;
      this.phase = 'paused';
      this.emit();
    };

    source.start(0);
    this.emit();

    const step = () => {
      if (this.phase !== 'playing' || !this.audioCtx || !this.timeline) return;
      const elapsedMs = (this.audioCtx.currentTime - this.previewStartCtxTime) * 1000;
      this.playheadMs = Math.min(
        this.timeline.getDurationMs(),
        this.previewStartOffsetMs + elapsedMs,
      );
      if (nowPerfMs() - this.lastEmitPerfMs >= LIVE_EMIT_INTERVAL_MS) {
        this.emit();
      }
      this.previewRafId = window.requestAnimationFrame(step);
    };
    this.previewRafId = window.requestAnimationFrame(step);
  }

  pausePreview(): void {
    if (this.phase !== 'playing') return;
    this.stopPreviewPlayback();
    this.phase = 'paused';
    this.emit();
  }

  async pauseForStopPrompt(): Promise<void> {
    if (this.phase === 'recording') {
      await this.pause();
    } else if (this.phase === 'playing') {
      this.pausePreview();
    }
  }

  async finalizeAndEncode(
    quality: AudioQualitySettings,
    onProgress?: (ratio: number) => void,
    options?: { captureLocalMaster?: boolean },
  ): Promise<{
    encoded: EncodedAudioResult;
    localMaster?: {
      blob: Blob;
      sampleRate: number;
      bitDepth: 32;
      channels: ChannelCountOption;
    };
    durationMs: number;
    overviewPeaks: number[];
    deviceLabel: string;
  }> {
    await this.pauseForStopPrompt();
    if (!this.timeline || this.timeline.getTotalFrames() === 0) {
      throw new Error('No audio recorded yet.');
    }

    const durationMs = this.timeline.getDurationMs();
    const overviewPeaks = downsamplePeaks(this.timeline.getPeaks(), 140);
    const channels = this.timeline.extractChannelData();
    const sourceRate = this.timeline.sampleRate;
    const sourceChannels = this.timeline.channels;

    const encoded = await encodeAudio(
      channels,
      sourceRate,
      quality,
      options?.captureLocalMaster
        ? (ratio) => onProgress?.(Math.min(0.88, ratio * 0.88))
        : onProgress,
    );

    let localMaster:
      | {
          blob: Blob;
          sampleRate: number;
          bitDepth: 32;
          channels: ChannelCountOption;
        }
      | undefined;

    if (options?.captureLocalMaster) {
      // Uncompressed 32-bit IEEE Float WAV at raw hardware sample rate (zero resampling / zero quantization loss)
      const masterBlob = encodeWav(channels, sourceRate, 32);
      localMaster = {
        blob: masterBlob,
        sampleRate: sourceRate,
        bitDepth: 32,
        channels: sourceChannels,
      };
      onProgress?.(1);
    }

    const oldDraftId = this.draftId;
    const deviceLabel = this.activeDeviceLabel;
    this.resetInternalState();

    if (oldDraftId) {
      await this.enqueueDraftPersist(() =>
        deleteDraft(oldDraftId).catch(() => {}),
      );
    }

    return { encoded, localMaster, durationMs, overviewPeaks, deviceLabel };
  }

  async discard(): Promise<void> {
    this.stopPreviewPlayback();
    this.teardownMicCapture();
    await this.releaseWakeLock();

    const oldDraftId = this.draftId;
    this.resetInternalState();
    this.emit();

    if (oldDraftId) {
      await this.enqueueDraftPersist(() =>
        deleteDraft(oldDraftId).catch(() => {}),
      );
    }
  }

  async dispose(): Promise<void> {
    this.stopPreviewPlayback();
    this.teardownMicCapture();
    await this.flushPendingDraftToDb();
    await this.releaseWakeLock();
    if (this.audioCtx) {
      const ctx = this.audioCtx;
      this.audioCtx = null;
      await ctx.close().catch(() => {});
    }
  }

  private resetInternalState(): void {
    this.timeline = null;
    this.draftId = null;
    this.phase = 'idle';
    this.playheadMs = 0;
    this.liveLevel = 0;
    this.lastChunkPerfMs = 0;
    this.lastEmitPerfMs = 0;
    this.hasEmittedFirstChunkInSession = false;
    this.pendingPersistBuffers = [];
    this.pendingPersistSamples = 0;
    this.persistedChunkCount = 0;
  }

  private createOrGetAudioContext(desiredRate?: number): AudioContext {
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      return this.audioCtx;
    }

    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;

    // Prefer 'playback' latencyHint (larger OS audio buffer for glitch-free narration without
    // live monitoring) and native hardware sample rate for fresh takes; nativeEncoder resamples
    // cleanly offline on export when needed.
    const options: AudioContextOptions = desiredRate
      ? { sampleRate: desiredRate, latencyHint: 'playback' }
      : { latencyHint: 'playback' };
    try {
      this.audioCtx = new Ctor(options);
    } catch {
      try {
        this.audioCtx = desiredRate
          ? new Ctor({ sampleRate: desiredRate })
          : new Ctor();
      } catch {
        this.audioCtx = new Ctor();
      }
    }
    return this.audioCtx;
  }

  private async resumeContextSafely(ctx: AudioContext): Promise<void> {
    if (ctx.state === 'running' || ctx.state === 'closed') return;
    await Promise.race([
      ctx.resume().catch(() => {}),
      new Promise<void>((resolve) => window.setTimeout(resolve, 1500)),
    ]);
  }

  private async ensureAudioContext(desiredRate?: number): Promise<AudioContext> {
    const ctx = this.createOrGetAudioContext(desiredRate);
    await this.resumeContextSafely(ctx);
    return ctx;
  }

  private async beginMicCapture(
    deviceSettings: AudioDeviceSettings,
    quality: AudioQualitySettings,
  ): Promise<StartRecordingFeedback> {
    const targetChannels: ChannelCountOption =
      this.timeline?.channels ?? quality.channels;

    // 1. Synchronously create & kick AudioContext.resume() INSIDE the user tap gesture
    //    (required by iOS Safari before any await!). Use existing timeline rate when
    //    resuming a take, or native hardware rate for fresh takes.
    const ctx = this.createOrGetAudioContext(this.timeline?.sampleRate);
    if (ctx.state !== 'running') {
      void ctx.resume().catch(() => {});
    }

    // 2. Acquire microphone stream aligned to AudioContext.sampleRate so Chromium/WebRTC
    //    never inserts a live rate-conversion bridge into MediaStreamAudioSourceNode.
    const captureSampleRate = this.timeline?.sampleRate ?? ctx.sampleRate;
    const acquired = await acquireMicStream(
      deviceSettings,
      {
        ...quality,
        channels: targetChannels,
      },
      captureSampleRate,
    );

    // 3. Re-resume AudioContext after permission dialog closes (iOS suspends it during prompt)
    await this.resumeContextSafely(ctx);

    this.stream = acquired.stream;
    this.activeDeviceLabel = acquired.actualDeviceLabel;

    if (!this.timeline) {
      this.timeline = new PcmTimeline(ctx.sampleRate, targetChannels);
      this.draftId = createId('draft');
      this.persistedChunkCount = 0;
    }

    // Build studio input strip: Mic -> [80Hz HPF] -> Input Gain -> [Compressor + Soft-Clip Ceiling] -> Capture
    const source = ctx.createMediaStreamSource(this.stream);
    const strip = buildStudioInputStrip(ctx, source, quality);
    this.inputStripNodes = strip.nodes;
    const tail = strip.tail;

    // Attach AudioWorkletNode (preferred) or ScriptProcessorNode fallback
    const handle = await attachPcmCapture(ctx, tail, {
      channels: targetChannels,
      isActive: () => this.phase === 'recording',
      computeFallbackPeaks: true,
      onChunk: ({ pcm, peaks, liveLevel }) =>
        this.ingestCapturedChunk(pcm, peaks, liveLevel),
    });
    this.captureHandle = handle;
    this.workletNode = handle.workletNode;

    this.phase = 'recording';
    this.playheadMs = this.timeline.getDurationMs();
    const startPerf = nowPerfMs();
    this.lastChunkPerfMs = startPerf;
    this.hasEmittedFirstChunkInSession = false;
    await this.requestWakeLock();
    if (this.lastChunkPerfMs === startPerf) {
      this.lastChunkPerfMs = nowPerfMs();
    }
    this.emit();

    return {
      usedFallbackDevice: acquired.usedFallback,
      fallbackReason: acquired.fallbackReason,
    };
  }

  private ingestCapturedChunk(
    interleaved: Float32Array,
    peaks: number[],
    liveLevel: number,
  ): void {
    if (!this.timeline || this.phase !== 'recording') return;
    const now = nowPerfMs();
    this.timeline.appendFrames(interleaved, peaks);
    this.playheadMs = this.timeline.getDurationMs();
    this.liveLevel = Math.min(1, Math.max(0, liveLevel || 0));
    this.lastChunkPerfMs = now;

    // Buffer for crash-safe 2-second IndexedDB flushes
    this.pendingPersistBuffers.push(interleaved);
    this.pendingPersistSamples += interleaved.length;
    const flushThreshold =
      this.timeline.sampleRate * this.timeline.channels * DRAFT_FLUSH_SECONDS;

    if (this.pendingPersistSamples >= flushThreshold) {
      void this.flushPendingDraftToDb();
    }

    if (
      !this.hasEmittedFirstChunkInSession ||
      now - this.lastEmitPerfMs >= LIVE_EMIT_INTERVAL_MS
    ) {
      this.hasEmittedFirstChunkInSession = true;
      this.emit();
    }
  }

  private teardownMicCapture(): void {
    for (const node of this.inputStripNodes) {
      try {
        node.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    }
    this.inputStripNodes = [];

    teardownPcmCapture({
      ...(this.captureHandle ?? {}),
      workletNode: this.workletNode ?? this.captureHandle?.workletNode ?? null,
    });
    this.captureHandle = null;
    this.workletNode = null;

    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }

  private stopPreviewPlayback(): void {
    if (this.previewRafId !== null) {
      window.cancelAnimationFrame(this.previewRafId);
      this.previewRafId = null;
    }
    if (this.previewSource) {
      try {
        this.previewSource.onended = null;
        this.previewSource.stop();
        this.previewSource.disconnect();
      } catch {
        // Ignore if already stopped
      }
      this.previewSource = null;
    }
  }

  private enqueueDraftPersist(task: () => Promise<void>): Promise<void> {
    const next = this.draftPersistQueue.then(task, task);
    this.draftPersistQueue = next.catch(() => {});
    return next;
  }

  private flushPendingDraftToDb(): Promise<void> {
    if (!this.draftId || !this.timeline || this.pendingPersistSamples === 0) {
      return this.draftPersistQueue;
    }
    const draftId = this.draftId;
    const buffers = this.pendingPersistBuffers;
    const totalLen = this.pendingPersistSamples;
    this.pendingPersistBuffers = [];
    this.pendingPersistSamples = 0;

    const merged = new Float32Array(totalLen);
    let offset = 0;
    for (const buf of buffers) {
      merged.set(buf, offset);
      offset += buf.length;
    }

    const chunkIdx = this.persistedChunkCount;
    this.persistedChunkCount += 1;

    const draftMeta: ActiveDraft = {
      id: draftId,
      projectId: this.projectId,
      sampleRate: this.timeline.sampleRate,
      channels: this.timeline.channels,
      totalFrames: this.timeline.getTotalFrames(),
      chunkCount: this.persistedChunkCount,
      peaks: this.timeline.getPeaks().slice(),
      updatedAt: Date.now(),
    };

    return this.enqueueDraftPersist(async () => {
      try {
        await saveDraftChunk(draftId, chunkIdx, merged);
        await saveDraftMeta(draftMeta);
      } catch {
        // Non-fatal: recording remains safe in memory
      }
    });
  }

  private syncFullDraftToDb(): Promise<void> {
    if (!this.draftId || !this.timeline) return this.draftPersistQueue;
    this.pendingPersistBuffers = [];
    this.pendingPersistSamples = 0;

    const blocks = this.timeline.buildStorageBlocks(DRAFT_FLUSH_SECONDS);
    this.persistedChunkCount = blocks.length;

    const draftMeta: ActiveDraft = {
      id: this.draftId,
      projectId: this.projectId,
      sampleRate: this.timeline.sampleRate,
      channels: this.timeline.channels,
      totalFrames: this.timeline.getTotalFrames(),
      chunkCount: blocks.length,
      peaks: this.timeline.getPeaks().slice(),
      updatedAt: Date.now(),
    };

    return this.enqueueDraftPersist(async () => {
      try {
        await replaceDraftSnapshot(draftMeta, blocks);
      } catch {
        // Non-fatal
      }
    });
  }

  private async requestWakeLock(): Promise<void> {
    if (
      !this.keepScreenAwake ||
      typeof navigator === 'undefined' ||
      !('wakeLock' in navigator)
    ) {
      return;
    }
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      if (!this.visibilityHandler && typeof document !== 'undefined') {
        this.visibilityHandler = () => {
          if (document.visibilityState === 'visible' && this.phase === 'recording') {
            void this.requestWakeLock();
          }
        };
        document.addEventListener('visibilitychange', this.visibilityHandler);
      }
    } catch {
      // Wake lock optional (some browsers restrict it on low battery)
    }
  }

  private async releaseWakeLock(): Promise<void> {
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (this.wakeLock) {
      try {
        await this.wakeLock.release();
      } catch {
        // Ignore
      }
      this.wakeLock = null;
    }
  }
}
