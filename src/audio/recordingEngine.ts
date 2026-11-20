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
import { encodeAudio, type EncodedAudioResult } from './nativeEncoder';
import { PcmTimeline, PEAKS_PER_SECOND } from './pcmTimeline';

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
  private workletLoadedCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private workletSilentGain: GainNode | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private scriptSilentGain: GainNode | null = null;
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
      // Safe default: snap playhead to end and continue appending
      this.playheadMs = this.timeline.getDurationMs();
      this.timeline.clearUndo();
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
      this.playheadMs = this.timeline.getDurationMs();
      await this.syncFullDraftToDb();
      this.emit();
    }
    return ok;
  }

  async pause(): Promise<void> {
    if (this.phase !== 'recording') return;

    this.teardownMicCapture();
    await this.flushPendingDraftToDb();
    await this.releaseWakeLock();

    this.liveLevel = 0;
    this.phase = 'paused';
    this.playheadMs = this.timeline?.getDurationMs() ?? 0;
    this.emit();
  }

  /**
   * Seek playhead while paused or playing (used by drag-to-scrub waveform & -5s/+5s buttons).
   */
  seekToMs(ms: number): void {
    const maxMs = this.timeline?.getDurationMs() ?? 0;
    const clamped = Math.max(0, Math.min(ms, maxMs));
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
  ): Promise<{
    encoded: EncodedAudioResult;
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

    const encoded = await encodeAudio(channels, sourceRate, quality, onProgress);

    const oldDraftId = this.draftId;
    const deviceLabel = this.activeDeviceLabel;
    this.resetInternalState();

    if (oldDraftId) {
      await deleteDraft(oldDraftId).catch(() => {});
    }

    return { encoded, durationMs, overviewPeaks, deviceLabel };
  }

  async discard(): Promise<void> {
    this.stopPreviewPlayback();
    this.teardownMicCapture();
    await this.releaseWakeLock();

    const oldDraftId = this.draftId;
    this.resetInternalState();
    this.emit();

    if (oldDraftId) {
      await deleteDraft(oldDraftId).catch(() => {});
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
      this.workletLoadedCtx = null;
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

    if (desiredRate) {
      try {
        this.audioCtx = new Ctor({ sampleRate: desiredRate });
      } catch {
        this.audioCtx = new Ctor();
      }
    } else {
      // Let browser use native hardware sample rate for capture (avoids iOS/Firefox
      // MediaStreamAudioSourceNode mismatch); nativeEncoder resamples cleanly on export.
      this.audioCtx = new Ctor();
    }
    this.workletLoadedCtx = null;
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

    // 2. Acquire microphone stream (may present mobile OS permission prompt)
    const acquired = await acquireMicStream(deviceSettings, {
      ...quality,
      sampleRate: (this.timeline?.sampleRate ??
        quality.sampleRate) as AudioQualitySettings['sampleRate'],
      channels: targetChannels,
    });

    // 3. Re-resume AudioContext after permission dialog closes (iOS suspends it during prompt)
    await this.resumeContextSafely(ctx);

    this.stream = acquired.stream;
    this.activeDeviceLabel = acquired.actualDeviceLabel;

    if (!this.timeline) {
      this.timeline = new PcmTimeline(ctx.sampleRate, targetChannels);
      this.draftId = createId('draft');
      this.persistedChunkCount = 0;
    }

    // Build studio input strip: Mic -> [80Hz HPF] -> Input Gain -> [Soft Limiter] -> Capture
    const source = ctx.createMediaStreamSource(this.stream);
    let tail: AudioNode = source;

    if (quality.highPassFilter) {
      const hpf = ctx.createBiquadFilter();
      hpf.type = 'highpass';
      hpf.frequency.value = 80;
      hpf.Q.value = 0.707;
      tail.connect(hpf);
      tail = hpf;
    }

    const gainNode = ctx.createGain();
    gainNode.gain.value = quality.inputGain;
    tail.connect(gainNode);
    tail = gainNode;

    if (quality.softLimiter) {
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -3;
      comp.knee.value = 6;
      comp.ratio.value = 12;
      comp.attack.value = 0.002;
      comp.release.value = 0.08;
      tail.connect(comp);
      tail = comp;
    }

    // Attach AudioWorkletNode (preferred) or ScriptProcessorNode fallback
    const attachedWorklet = await this.tryAttachWorklet(
      ctx,
      tail,
      targetChannels,
    );
    if (!attachedWorklet) {
      this.attachScriptProcessorFallback(ctx, tail, targetChannels);
    }

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

  private async tryAttachWorklet(
    ctx: AudioContext,
    sourceNode: AudioNode,
    channels: ChannelCountOption,
  ): Promise<boolean> {
    if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') {
      return false;
    }
    try {
      // Only register the AudioWorklet module ONCE per AudioContext (calling twice throws on Resume)
      if (this.workletLoadedCtx !== ctx) {
        const base =
          (typeof import.meta !== 'undefined' &&
            import.meta.env &&
            import.meta.env.BASE_URL) ||
          '/';
        const workletUrl = `${base.endsWith('/') ? base : `${base}/`}audio/pcm-capture-worklet.js`;
        await ctx.audioWorklet.addModule(workletUrl);
        this.workletLoadedCtx = ctx;
      }

      // Use numberOfOutputs: 1 routed through a muted GainNode(0) -> ctx.destination
      // so iOS Safari WebKit and mobile Chrome always pull audio frames reliably.
      const node = new AudioWorkletNode(ctx, 'pcm-capture-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: channels,
        channelCountMode: 'explicit',
        processorOptions: { channels },
      });

      node.port.onmessage = (event) => {
        const msg = event.data;
        if (!msg || msg.type !== 'chunk' || this.phase !== 'recording') return;
        const pcm =
          msg.pcm instanceof Float32Array ? msg.pcm : new Float32Array(msg.pcm);
        this.ingestCapturedChunk(pcm, msg.peaks, msg.liveLevel);
      };

      const silentGain = ctx.createGain();
      silentGain.gain.value = 0;

      sourceNode.connect(node);
      node.connect(silentGain);
      silentGain.connect(ctx.destination);

      this.workletNode = node;
      this.workletSilentGain = silentGain;
      return true;
    } catch {
      return false;
    }
  }

  private attachScriptProcessorFallback(
    ctx: AudioContext,
    sourceNode: AudioNode,
    channels: ChannelCountOption,
  ): void {
    const bufferSize = 4096;
    const processor = ctx.createScriptProcessor(bufferSize, channels, channels);
    const silentGain = ctx.createGain();
    silentGain.gain.value = 0;

    processor.onaudioprocess = (event) => {
      if (this.phase !== 'recording') return;
      const ch0 = event.inputBuffer.getChannelData(0);
      const ch1 =
        channels === 2
          ? event.inputBuffer.numberOfChannels > 1
            ? event.inputBuffer.getChannelData(1)
            : ch0
          : null;

      const frames = ch0.length;
      const interleaved = new Float32Array(frames * channels);
      let peak = 0;

      for (let i = 0; i < frames; i += 1) {
        const s0 = ch0[i];
        interleaved[i * channels] = s0;
        const a0 = Math.abs(s0);
        if (a0 > peak) peak = a0;
        if (channels === 2 && ch1) {
          const s1 = ch1[i];
          interleaved[i * channels + 1] = s1;
          const a1 = Math.abs(s1);
          if (a1 > peak) peak = a1;
        }
      }

      const framesPerPeak = Math.max(
        1,
        Math.round(ctx.sampleRate / PEAKS_PER_SECOND),
      );
      const peaks: number[] = [];
      for (let f = 0; f < frames; f += framesPerPeak) {
        let localMax = 0;
        const end = Math.min(frames, f + framesPerPeak);
        for (let j = f; j < end; j += 1) {
          const a = Math.abs(ch0[j]);
          if (a > localMax) localMax = a;
        }
        peaks.push(Math.min(1, localMax));
      }

      this.ingestCapturedChunk(interleaved, peaks, peak);
    };

    sourceNode.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(ctx.destination);
    this.scriptNode = processor;
    this.scriptSilentGain = silentGain;
  }

  private ingestCapturedChunk(
    interleaved: Float32Array,
    peaks: number[],
    liveLevel: number,
  ): void {
    if (!this.timeline) return;
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
    if (this.workletNode) {
      try {
        this.workletNode.port.postMessage({ type: 'setActive', active: false });
        this.workletNode.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      this.workletNode = null;
    }
    if (this.workletSilentGain) {
      try {
        this.workletSilentGain.disconnect();
      } catch {
        // Ignore
      }
      this.workletSilentGain = null;
    }
    if (this.scriptNode) {
      try {
        this.scriptNode.disconnect();
      } catch {
        // Ignore
      }
      this.scriptNode.onaudioprocess = null;
      this.scriptNode = null;
    }
    if (this.scriptSilentGain) {
      try {
        this.scriptSilentGain.disconnect();
      } catch {
        // Ignore
      }
      this.scriptSilentGain = null;
    }
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

  private async flushPendingDraftToDb(): Promise<void> {
    if (!this.draftId || !this.timeline || this.pendingPersistSamples === 0) {
      return;
    }
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
      id: this.draftId,
      projectId: this.projectId,
      sampleRate: this.timeline.sampleRate,
      channels: this.timeline.channels,
      totalFrames: this.timeline.getTotalFrames(),
      chunkCount: this.persistedChunkCount,
      peaks: this.timeline.getPeaks().slice(),
      updatedAt: Date.now(),
    };

    try {
      await saveDraftChunk(this.draftId, chunkIdx, merged);
      await saveDraftMeta(draftMeta);
    } catch {
      // Non-fatal: recording remains safe in memory
    }
  }

  private async syncFullDraftToDb(): Promise<void> {
    if (!this.draftId || !this.timeline) return;
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

    try {
      await replaceDraftSnapshot(draftMeta, blocks);
    } catch {
      // Non-fatal
    }
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
