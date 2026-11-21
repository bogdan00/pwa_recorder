import type { DecodedPcmAudio } from './audioExporter';

export type CompareTrackSlot = 'master' | 'candidate';

const CROSSFADE_SEC = 0.015; // 15ms click-free instant switch

/**
 * Gapless, sample-synchronized Web Audio A/B player.
 * Plays Master and Candidate simultaneously from the exact same AudioContext clock
 * and crossfades dedicated GainNodes in 15ms so toggling A <-> B mid-syllable has
 * zero silence gap, zero clicks, and zero timestamp drift.
 */
export class AbComparePlayer {
  private ctx: AudioContext | null = null;
  private masterBuffer: AudioBuffer | null = null;
  private candidateBuffer: AudioBuffer | null = null;

  private masterSource: AudioBufferSourceNode | null = null;
  private candidateSource: AudioBufferSourceNode | null = null;
  private masterGain: GainNode | null = null;
  private candidateGain: GainNode | null = null;

  private isPlaying = false;
  private loop = true;
  private startCtxTime = 0;
  private startOffsetSec = 0;
  private pausedOffsetSec = 0;
  private durationSec = 0;

  private ensureContext(sampleRate?: number): AudioContext {
    if (this.ctx && this.ctx.state !== 'closed') {
      return this.ctx;
    }
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    try {
      this.ctx = sampleRate ? new Ctor({ sampleRate }) : new Ctor();
    } catch {
      this.ctx = new Ctor();
    }
    return this.ctx;
  }

  private pcmToAudioBuffer(ctx: AudioContext, pcm: DecodedPcmAudio): AudioBuffer {
    const numChannels = Math.max(1, pcm.channels.length);
    const numFrames = Math.max(1, pcm.channels[0]?.length ?? 1);
    const buf = ctx.createBuffer(numChannels, numFrames, pcm.sampleRate);
    for (let ch = 0; ch < numChannels; ch += 1) {
      buf.copyToChannel(new Float32Array(pcm.channels[ch]), ch);
    }
    return buf;
  }

  loadBuffers(master: DecodedPcmAudio, candidate: DecodedPcmAudio): void {
    this.stop();
    const ctx = this.ensureContext(master.sampleRate);
    this.masterBuffer = this.pcmToAudioBuffer(ctx, master);
    this.candidateBuffer = this.pcmToAudioBuffer(ctx, candidate);
    this.durationSec = Math.min(
      this.masterBuffer.duration,
      this.candidateBuffer.duration,
    );
    this.pausedOffsetSec = 0;
  }

  getDurationSec(): number {
    return this.durationSec;
  }

  getIsPlaying(): boolean {
    return this.isPlaying;
  }

  getCurrentTimeSec(): number {
    if (!this.isPlaying || !this.ctx || this.durationSec <= 0) {
      return this.pausedOffsetSec;
    }
    const elapsed = Math.max(0, this.ctx.currentTime - this.startCtxTime);
    const pos = this.startOffsetSec + elapsed;
    return this.loop ? pos % this.durationSec : Math.min(this.durationSec, pos);
  }

  async play(slot: CompareTrackSlot, offsetSec?: number): Promise<void> {
    if (!this.masterBuffer || !this.candidateBuffer) return;

    // If already playing and no explicit seek requested, just crossfade instantaneously!
    if (this.isPlaying && offsetSec === undefined) {
      this.switchSlot(slot);
      return;
    }

    const ctx = this.ensureContext();
    if (ctx.state !== 'running') {
      await Promise.race([
        ctx.resume().catch(() => {}),
        new Promise<void>((r) => window.setTimeout(r, 1200)),
      ]);
    }

    this.teardownSources();

    const startOffset =
      offsetSec !== undefined
        ? Math.max(0, Math.min(this.durationSec - 0.01, offsetSec))
        : this.pausedOffsetSec >= this.durationSec - 0.05
          ? 0
          : this.pausedOffsetSec;

    const mSrc = ctx.createBufferSource();
    mSrc.buffer = this.masterBuffer;
    mSrc.loop = this.loop;
    mSrc.loopStart = 0;
    mSrc.loopEnd = this.durationSec;

    const cSrc = ctx.createBufferSource();
    cSrc.buffer = this.candidateBuffer;
    cSrc.loop = this.loop;
    cSrc.loopStart = 0;
    cSrc.loopEnd = this.durationSec;

    const mGain = ctx.createGain();
    const cGain = ctx.createGain();
    mGain.gain.value = slot === 'master' ? 1 : 0;
    cGain.gain.value = slot === 'candidate' ? 1 : 0;

    mSrc.connect(mGain);
    mGain.connect(ctx.destination);
    cSrc.connect(cGain);
    cGain.connect(ctx.destination);

    const startAt = ctx.currentTime + 0.01;
    mSrc.start(startAt, startOffset);
    cSrc.start(startAt, startOffset);

    mSrc.onended = () => {
      if (this.masterSource === mSrc && !this.loop) {
        this.isPlaying = false;
        this.pausedOffsetSec = 0;
        this.teardownSources();
      }
    };

    this.masterSource = mSrc;
    this.candidateSource = cSrc;
    this.masterGain = mGain;
    this.candidateGain = cGain;
    this.startCtxTime = startAt;
    this.startOffsetSec = startOffset;
    this.isPlaying = true;
  }

  switchSlot(slot: CompareTrackSlot): void {
    if (!this.isPlaying || !this.ctx || !this.masterGain || !this.candidateGain) {
      return;
    }
    const now = this.ctx.currentTime;
    const mTarget = slot === 'master' ? 1 : 0;
    const cTarget = slot === 'candidate' ? 1 : 0;

    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
    this.masterGain.gain.linearRampToValueAtTime(mTarget, now + CROSSFADE_SEC);

    this.candidateGain.gain.cancelScheduledValues(now);
    this.candidateGain.gain.setValueAtTime(this.candidateGain.gain.value, now);
    this.candidateGain.gain.linearRampToValueAtTime(cTarget, now + CROSSFADE_SEC);
  }

  pause(): void {
    if (!this.isPlaying) return;
    this.pausedOffsetSec = this.getCurrentTimeSec();
    this.isPlaying = false;
    this.teardownSources();
  }

  stop(): void {
    this.isPlaying = false;
    this.pausedOffsetSec = 0;
    this.teardownSources();
  }

  private teardownSources(): void {
    for (const src of [this.masterSource, this.candidateSource]) {
      if (src) {
        try {
          src.onended = null;
          src.stop();
          src.disconnect();
        } catch {
          // Ignore already stopped sources
        }
      }
    }
    for (const g of [this.masterGain, this.candidateGain]) {
      if (g) {
        try {
          g.disconnect();
        } catch {
          // Ignore
        }
      }
    }
    this.masterSource = null;
    this.candidateSource = null;
    this.masterGain = null;
    this.candidateGain = null;
  }

  dispose(): void {
    this.stop();
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      void ctx.close().catch(() => {});
    }
  }
}
