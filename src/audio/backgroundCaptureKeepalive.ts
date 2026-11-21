import { encodeWav } from './wavEncoder';

export type NavigatorAudioSessionType =
  | 'auto'
  | 'playback'
  | 'transient'
  | 'transient-solo'
  | 'ambient'
  | 'play-and-record';

export interface NavigatorAudioSessionLike {
  type: NavigatorAudioSessionType;
  state?: 'active' | 'inactive' | 'interrupted';
  addEventListener?: (type: 'statechange', listener: () => void) => void;
  removeEventListener?: (type: 'statechange', listener: () => void) => void;
}

function getAudioSession(): NavigatorAudioSessionLike | null {
  if (typeof navigator === 'undefined') return null;
  const nav = navigator as Navigator & {
    audioSession?: NavigatorAudioSessionLike;
  };
  return nav.audioSession ?? null;
}

/**
 * Sets Safari/iOS Web Audio Session category (`navigator.audioSession.type`).
 * When `forceCycle` is true, cycles through `'auto'` first to bypass WebKit's
 * `RemoteAudioSession` category deduplication cache (WebKit Bug #323104).
 */
export function setNavigatorAudioSessionType(
  type: NavigatorAudioSessionType,
  forceCycle = false,
): boolean {
  const session = getAudioSession();
  if (!session) return false;
  try {
    if (forceCycle && type !== 'auto') {
      session.type = 'auto';
    }
    session.type = type;
    return true;
  } catch {
    return false;
  }
}

/**
 * Switches Safari/iOS AudioSession to `'playback'` so audiobook playback uses the
 * full-volume loudspeaker even when the iPhone hardware Silent switch is enabled
 * or immediately after finishing a recording session.
 */
export function setPlaybackAudioSession(): void {
  setNavigatorAudioSessionType('playback', false);
}

/**
 * Generates a tiny 4-second 8 kHz mono 16-bit PCM WAV containing a `-90 dBFS`
 * alternating 1-LSB Nyquist floor (`±1 / 32768`, zero DC offset).
 * Completely inaudible to humans and below iPhone speaker noise floor, while
 * remaining non-zero so iOS CoreAudio treats the looping `<audio>` element as
 * active media holding a background/lock-screen audio session.
 */
export function createInaudibleKeepaliveWavBlob(): Blob {
  const sampleRate = 8000;
  const frames = sampleRate * 4;
  const pcm = new Float32Array(frames);
  const lsb = 1 / 32768;
  for (let i = 0; i < frames; i += 1) {
    pcm[i] = (i & 1) === 0 ? lsb : -lsb;
  }
  return encodeWav([pcm], sampleRate, 16);
}

export interface BackgroundCaptureKeepaliveOptions {
  onSessionStateChange?: (state: string) => void;
}

/**
 * Holds an active iOS Safari background/lock-screen audio session while recording:
 * - Sets `navigator.audioSession.type = 'play-and-record'`
 * - Plays a persistent looping inaudible `<audio>` element synchronously inside the Record tap
 * - Publishes recording status via `navigator.mediaSession`
 * - Restores `'playback'` -> `'auto'` on stop so post-recording playback stays loud
 */
export class BackgroundCaptureKeepalive {
  private audioEl: HTMLAudioElement | null = null;
  private keepaliveUrl: string | null = null;
  private active = false;
  private sessionListener: (() => void) | null = null;
  private onSessionStateChange?: (state: string) => void;

  constructor(options: BackgroundCaptureKeepaliveOptions = {}) {
    this.onSessionStateChange = options.onSessionStateChange;
  }

  /**
   * Must be called SYNCHRONOUSLY inside the user's Record tap gesture BEFORE any `await`
   * so iOS Safari grants playback activation to the looping keepalive `<audio>` element.
   */
  startSync(title?: string): void {
    this.active = true;
    setNavigatorAudioSessionType('play-and-record', true);
    this.attachAudioSessionListener();

    const audio = this.ensureKeepaliveAudio();
    if (audio) {
      audio.muted = false;
      audio.volume = 0.01;
      audio.loop = true;
      try {
        const res = audio.play();
        if (res && typeof res.catch === 'function') {
          void res.catch(() => {});
        }
      } catch {
        // Ignore in headless/non-media test runtimes
      }
    }

    this.updateRecordingMediaSession(title);
  }

  /**
   * Re-asserts `play-and-record` right after `getUserMedia` resolves (helps iOS
   * route external/wired mics and prevents silent category drift) and ensures the
   * keepalive `<audio>` element is actively playing.
   */
  reinforceAfterMicAcquired(): void {
    if (!this.active) return;
    setNavigatorAudioSessionType('play-and-record', false);
    this.ensureActive();
  }

  /**
   * Called from `visibilitychange`, `AudioContext.statechange`, and the capture watchdog
   * to keep the background media session alive if iOS paused the keepalive element.
   */
  ensureActive(): void {
    if (!this.active) return;
    if (this.audioEl && this.audioEl.paused) {
      try {
        const res = this.audioEl.play();
        if (res && typeof res.catch === 'function') {
          void res.catch(() => {});
        }
      } catch {
        // Non-fatal
      }
    }
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.detachAudioSessionListener();

    if (this.audioEl) {
      try {
        this.audioEl.pause();
        this.audioEl.currentTime = 0;
      } catch {
        // Ignore
      }
    }

    this.clearRecordingMediaSession();
    // Restore loudspeaker playback routing after releasing mic (prevents iOS earpiece stickiness)
    setNavigatorAudioSessionType('playback', false);
    setNavigatorAudioSessionType('auto', false);
  }

  dispose(): void {
    this.stop();
    if (this.audioEl) {
      try {
        this.audioEl.removeAttribute('src');
        this.audioEl.load();
      } catch {
        // Ignore
      }
      this.audioEl = null;
    }
    if (this.keepaliveUrl) {
      try {
        URL.revokeObjectURL(this.keepaliveUrl);
      } catch {
        // Ignore
      }
      this.keepaliveUrl = null;
    }
  }

  isActive(): boolean {
    return this.active;
  }

  private ensureKeepaliveAudio(): HTMLAudioElement | null {
    if (typeof Audio === 'undefined' && typeof document === 'undefined') {
      return null;
    }
    if (this.audioEl) return this.audioEl;

    try {
      if (!this.keepaliveUrl && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        const blob = createInaudibleKeepaliveWavBlob();
        this.keepaliveUrl = URL.createObjectURL(blob);
      }
      if (!this.keepaliveUrl) return null;

      const el =
        typeof document !== 'undefined'
          ? document.createElement('audio')
          : new Audio();
      el.preload = 'auto';
      el.loop = true;
      el.muted = false;
      el.volume = 0.01;
      el.setAttribute('playsinline', '');
      el.setAttribute('webkit-playsinline', '');
      el.src = this.keepaliveUrl;
      this.audioEl = el;
      return el;
    } catch {
      return null;
    }
  }

  private attachAudioSessionListener(): void {
    const session = getAudioSession();
    if (!session?.addEventListener || this.sessionListener) return;
    this.sessionListener = () => {
      const nextState = session.state ?? 'active';
      if (this.active && nextState === 'active') {
        this.ensureActive();
      }
      this.onSessionStateChange?.(nextState);
    };
    try {
      session.addEventListener('statechange', this.sessionListener);
    } catch {
      this.sessionListener = null;
    }
  }

  private detachAudioSessionListener(): void {
    const session = getAudioSession();
    if (session?.removeEventListener && this.sessionListener) {
      try {
        session.removeEventListener('statechange', this.sessionListener);
      } catch {
        // Ignore
      }
    }
    this.sessionListener = null;
  }

  private updateRecordingMediaSession(title?: string): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
      return;
    }
    try {
      if (typeof MediaMetadata !== 'undefined') {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: 'Recording…',
          artist: title?.trim() || 'StoryTape',
          album: 'StoryTape Studio',
        });
      }
      navigator.mediaSession.playbackState = 'playing';
    } catch {
      // Non-fatal
    }
  }

  private clearRecordingMediaSession(): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
      return;
    }
    try {
      navigator.mediaSession.playbackState = 'none';
    } catch {
      // Non-fatal
    }
  }
}
