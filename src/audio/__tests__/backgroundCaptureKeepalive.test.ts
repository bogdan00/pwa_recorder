import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AUDIO_QUALITY } from '../../storage/settings';
import { blobToArrayBuffer } from '../../utils/blob';

const DEFAULT_AUDIO_DEVICE = { deviceId: 'default', deviceLabel: 'Default Mic' };
import {
  BackgroundCaptureKeepalive,
  createInaudibleKeepaliveWavBlob,
  setPlaybackAudioSession,
} from '../backgroundCaptureKeepalive';
import { RecordingEngine } from '../recordingEngine';

describe('BackgroundCaptureKeepalive & iOS AudioSession helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    // Clean up any stubbed navigator.audioSession
    const nav = navigator as unknown as { audioSession?: unknown };
    delete nav.audioSession;
  });

  it('generates a 4-second 8kHz 16-bit PCM WAV with inaudible ±1 LSB floor', async () => {
    const blob = createInaudibleKeepaliveWavBlob();
    expect(blob.type).toBe('audio/wav');
    const buf = await blobToArrayBuffer(blob);
    const view = new DataView(buf);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // Mono
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(buf.byteLength).toBe(44 + 8000 * 4 * 2);
    // Alternating ±1 LSB (-90.3 dBFS): non-zero for iOS CoreAudio heuristics, inaudible to humans
    expect(view.getInt16(44, true)).toBe(1);
    expect(view.getInt16(46, true)).toBe(-1);
  });

  it('cycles navigator.audioSession to play-and-record on startSync, plays looping keepalive <audio>, and restores playback->auto on stop', () => {
    const typeHistory: string[] = [];
    let currentType = 'auto';
    const listeners = new Map<string, Set<() => void>>();

    const mockAudioSession = {
      get type() {
        return currentType;
      },
      set type(next: string) {
        currentType = next;
        typeHistory.push(next);
      },
      state: 'active' as 'active' | 'interrupted',
      addEventListener(evt: string, fn: () => void) {
        const set = listeners.get(evt) ?? new Set();
        set.add(fn);
        listeners.set(evt, set);
      },
      removeEventListener(evt: string, fn: () => void) {
        listeners.get(evt)?.delete(fn);
      },
    };
    Object.defineProperty(navigator, 'audioSession', {
      configurable: true,
      writable: true,
      value: mockAudioSession,
    });

    const playSpy = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockResolvedValue(undefined);
    const pauseSpy = vi
      .spyOn(HTMLMediaElement.prototype, 'pause')
      .mockImplementation(() => {});
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    const onSessionStateChange = vi.fn();
    const keepalive = new BackgroundCaptureKeepalive({ onSessionStateChange });

    keepalive.startSync('Mica sirenă');
    expect(keepalive.isActive()).toBe(true);
    // Forced cycle 'auto' -> 'play-and-record' bypasses WebKit Bug #323104 dedup cache
    expect(typeHistory).toEqual(['auto', 'play-and-record']);
    expect(playSpy).toHaveBeenCalledTimes(1);

    // Trigger audioSession statechange
    mockAudioSession.state = 'interrupted';
    listeners.get('statechange')?.forEach((fn) => fn());
    expect(onSessionStateChange).toHaveBeenCalledWith('interrupted');

    keepalive.stop();
    expect(keepalive.isActive()).toBe(false);
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(typeHistory.slice(-2)).toEqual(['playback', 'auto']);

    keepalive.dispose();
    expect(revokeSpy).toHaveBeenCalledTimes(1);

    setPlaybackAudioSession();
    expect(currentType).toBe('playback');
  });
});

describe('RecordingEngine lock-screen interruption & track-end recovery', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('auto-resumes AudioContext on iOS interrupted statechange and cleanly auto-pauses with warning if OS ends mic track', async () => {
    const ctxListeners = new Map<string, Set<() => void>>();
    const trackListeners = new Map<string, Set<() => void>>();
    let trackReadyState: MediaStreamTrackState = 'live';

    const fakeTrack = {
      kind: 'audio',
      label: 'iPhone Microphone',
      get readyState() {
        return trackReadyState;
      },
      stop: vi.fn(() => {
        trackReadyState = 'ended';
      }),
      getSettings: () => ({ sampleRate: 48000, channelCount: 1 }),
      addEventListener: (evt: string, fn: () => void) => {
        const set = trackListeners.get(evt) ?? new Set();
        set.add(fn);
        trackListeners.set(evt, set);
      },
      removeEventListener: (evt: string, fn: () => void) => {
        trackListeners.get(evt)?.delete(fn);
      },
    } as unknown as MediaStreamTrack;

    const fakeStream = {
      getTracks: () => [fakeTrack],
      getAudioTracks: () => [fakeTrack],
    } as unknown as MediaStream;

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue(fakeStream),
        enumerateDevices: vi.fn().mockResolvedValue([]),
        getSupportedConstraints: () => ({ echoCancellation: true }),
      },
    });

    const playSpy = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});

    let ctxState: string = 'running';
    const resumeMock = vi.fn(async () => {
      ctxState = 'running';
    });

    const createFakeNode = () => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
      gain: { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn() },
      frequency: { value: 80 },
      Q: { value: 0.707 },
      threshold: { value: -16 },
      knee: { value: 12 },
      ratio: { value: 3 },
      attack: { value: 0.005 },
      release: { value: 0.12 },
      type: 'highpass',
      curve: null,
      oversample: 'none',
    });

    class MockAudioContext {
      sampleRate = 48000;
      currentTime = 0;
      destination = createFakeNode();
      get state() {
        return ctxState;
      }
      resume = resumeMock;
      close = vi.fn().mockResolvedValue(undefined);
      createMediaStreamSource = vi.fn(() => createFakeNode());
      createBiquadFilter = vi.fn(() => createFakeNode());
      createGain = vi.fn(() => createFakeNode());
      createDynamicsCompressor = vi.fn(() => createFakeNode());
      createWaveShaper = vi.fn(() => createFakeNode());
      createScriptProcessor = vi.fn(() => {
        const node = createFakeNode() as ReturnType<typeof createFakeNode> & {
          onaudioprocess: ((e: unknown) => void) | null;
        };
        node.onaudioprocess = null;
        return node;
      });
      addEventListener = (evt: string, fn: () => void) => {
        const set = ctxListeners.get(evt) ?? new Set();
        set.add(fn);
        ctxListeners.set(evt, set);
      };
      removeEventListener = (evt: string, fn: () => void) => {
        ctxListeners.get(evt)?.delete(fn);
      };
    }

    vi.stubGlobal('AudioContext', MockAudioContext);

    // Default (backgroundKeepalive omitted / false): NEVER plays looping keepalive <audio>,
    // yet passive interruption auto-resume and track-end recovery still protect the recording.
    const engine = new RecordingEngine('book-1', 'Mica sirenă');
    await engine.startOrResumeFromEnd(DEFAULT_AUDIO_DEVICE, DEFAULT_AUDIO_QUALITY, true);
    expect(engine.getSnapshot().phase).toBe('recording');
    expect(engine.getSnapshot().captureWarning).toBeNull();
    expect(playSpy).not.toHaveBeenCalled();

    // 1. Simulate iOS lock screen transitioning AudioContext to 'interrupted'
    ctxState = 'interrupted';
    ctxListeners.get('statechange')?.forEach((fn) => fn());
    expect(resumeMock).toHaveBeenCalled();
    expect(engine.getSnapshot().phase).toBe('recording');

    // 2. Simulate OS forcibly terminating microphone track (e.g., standalone PWA lock / call)
    trackReadyState = 'ended';
    trackListeners.get('ended')?.forEach((fn) => fn());
    await vi.waitFor(() => {
      expect(engine.getSnapshot().phase).toBe('paused');
    });
    expect(engine.getSnapshot().captureWarning).toMatch(/system stopped the microphone/i);

    engine.dismissCaptureWarning();
    expect(engine.getSnapshot().captureWarning).toBeNull();

    // 3. Opt-in ({ backgroundKeepalive: true }) activates the looping keepalive <audio> synchronously
    trackReadyState = 'live';
    await engine.startOrResumeFromEnd(DEFAULT_AUDIO_DEVICE, DEFAULT_AUDIO_QUALITY, true, {
      backgroundKeepalive: true,
    });
    expect(playSpy).toHaveBeenCalled();

    await engine.dispose();
  });
});
