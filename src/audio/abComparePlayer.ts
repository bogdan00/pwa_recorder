import type { DecodedPcmAudio } from './audioExporter';

export type CompareTrackSlot = 'master' | 'candidate';

const FADE_IN_SEC = 0.005; // 5ms click-free fade-in on start/resume

/**
 * Web Audio A/B sample comparison player.
 * Each sample button toggles Play / Pause for its own slot (resuming in place),
 * while activating the other sample stops the current one and replays the newly
 * selected sample cleanly from the beginning (00:00).
 */
export class AbComparePlayer {
  private ctx: AudioContext | null = null;
  private masterBuffer: AudioBuffer | null = null;
  private candidateBuffer: AudioBuffer | null = null;

  private activeSource: AudioBufferSourceNode | null = null;
  private activeGain: GainNode | null = null;
  private activeSlot: CompareTrackSlot | null = null;

  private isPlaying = false;
  private loop = true;
  private startCtxTime = 0;
  private startOffsetSec = 0;
  private pausedOffsetSec = 0;
  private durationSec = 0;
  private playToken = 0;

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
    this.activeSlot = null;
  }

  getDurationSec(): number {
    return this.durationSec;
  }

  getIsPlaying(): boolean {
    return this.isPlaying;
  }

  getActiveSlot(): CompareTrackSlot | null {
    return this.activeSlot;
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
    const buffer =
      slot === 'master' ? this.masterBuffer : this.candidateBuffer;
    if (!buffer || this.durationSec <= 0) return;

    const switchingSlot = this.activeSlot !== slot;
    if (this.isPlaying && !switchingSlot && offsetSec === undefined) {
      return;
    }

    const token = ++this.playToken;

    // Switching to the other sample always stops the first and restarts from 0:00.
    const maxOffset = Math.max(0, this.durationSec - 0.01);
    const startOffset =
      offsetSec !== undefined
        ? Math.max(0, Math.min(maxOffset, offsetSec))
        : switchingSlot
          ? 0
          : this.pausedOffsetSec >= this.durationSec - 0.05
            ? 0
            : this.pausedOffsetSec;

    this.teardownSource();
    this.isPlaying = false;
    this.activeSlot = slot;
    this.pausedOffsetSec = startOffset;

    const ctx = this.ensureContext();
    if (ctx.state !== 'running') {
      // Trigger AudioContext.resume() synchronously inside the tap gesture for iOS PWAs.
      const resumePromise = ctx.resume().catch(() => {});
      await Promise.race([
        resumePromise,
        new Promise<void>((r) => window.setTimeout(r, 1200)),
      ]);
      if (token !== this.playToken || !this.ctx) {
        return;
      }
    }

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = this.loop;
    src.loopStart = 0;
    src.loopEnd = this.durationSec;

    const gain = ctx.createGain();
    const startAt = ctx.currentTime + 0.01;
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(1, startAt + FADE_IN_SEC);

    src.connect(gain);
    gain.connect(ctx.destination);
    src.start(startAt, startOffset);

    src.onended = () => {
      if (this.activeSource === src && !this.loop) {
        this.isPlaying = false;
        this.pausedOffsetSec = 0;
        this.teardownSource();
      }
    };

    this.activeSource = src;
    this.activeGain = gain;
    this.startCtxTime = startAt;
    this.startOffsetSec = startOffset;
    this.isPlaying = true;
  }

  async toggle(slot: CompareTrackSlot): Promise<boolean> {
    if (this.isPlaying && this.activeSlot === slot) {
      this.pause();
      return false;
    }
    await this.play(slot);
    return this.isPlaying;
  }

  pause(): void {
    this.playToken += 1;
    if (!this.isPlaying) return;
    this.pausedOffsetSec = this.getCurrentTimeSec();
    this.isPlaying = false;
    this.teardownSource();
  }

  stop(): void {
    this.playToken += 1;
    this.isPlaying = false;
    this.pausedOffsetSec = 0;
    this.activeSlot = null;
    this.teardownSource();
  }

  private teardownSource(): void {
    if (this.activeSource) {
      try {
        this.activeSource.onended = null;
        this.activeSource.stop();
        this.activeSource.disconnect();
      } catch {
        // Ignore already stopped sources
      }
      this.activeSource = null;
    }
    if (this.activeGain) {
      try {
        this.activeGain.disconnect();
      } catch {
        // Ignore
      }
      this.activeGain = null;
    }
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
