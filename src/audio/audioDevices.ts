import type {
  AudioDeviceSettings,
  AudioQualitySettings,
} from '../types/models';

export interface AudioInputDeviceInfo {
  deviceId: string;
  label: string;
  groupId: string;
  isDefault: boolean;
}

export interface DeviceListResult {
  devices: AudioInputDeviceInfo[];
  permissionGranted: boolean;
}

export interface AcquiredMicResult {
  stream: MediaStream;
  usedFallback: boolean;
  fallbackReason?: string;
  actualDeviceId: string;
  actualDeviceLabel: string;
  actualSampleRate?: number;
  actualChannels?: number;
}

export async function listAudioInputDevices(): Promise<DeviceListResult> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.enumerateDevices !== 'function'
  ) {
    return { devices: [], permissionGranted: false };
  }

  const all = await navigator.mediaDevices.enumerateDevices();
  const inputs = all.filter((d) => d.kind === 'audioinput');
  const permissionGranted = inputs.some((d) => Boolean(d.label && d.label.trim()));

  const devices: AudioInputDeviceInfo[] = inputs.map((d, idx) => {
    const isDefault = d.deviceId === 'default';
    const rawLabel = d.label?.trim();
    const label = rawLabel
      ? rawLabel
      : isDefault
        ? 'System Default Microphone'
        : `Microphone ${idx + 1}`;
    return {
      deviceId: d.deviceId || `mic-${idx}`,
      label,
      groupId: d.groupId || '',
      isDefault,
    };
  });

  return { devices, permissionGranted };
}

export async function requestMicPermissionAndList(): Promise<DeviceListResult> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== 'function'
  ) {
    throw new Error('Microphone API is not available in this browser.');
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((t) => t.stop());
  return listAudioInputDevices();
}

export function subscribeDeviceChanges(callback: () => void): () => void {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!md || typeof md.addEventListener !== 'function') {
    return () => {};
  }
  md.addEventListener('devicechange', callback);
  return () => {
    md.removeEventListener?.('devicechange', callback);
  };
}

function buildAudioConstraints(
  quality: AudioQualitySettings,
  deviceId?: string,
  exactDevice = false,
): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = {
    sampleRate: { ideal: quality.sampleRate },
    channelCount: { ideal: quality.channels },
    noiseSuppression: quality.noiseSuppression,
    autoGainControl: quality.autoGainControl,
    echoCancellation: quality.echoCancellation,
  };

  if (deviceId && deviceId !== 'default') {
    constraints.deviceId = exactDevice ? { exact: deviceId } : { ideal: deviceId };
  }

  return constraints;
}

export async function acquireMicStream(
  deviceSettings: AudioDeviceSettings,
  quality: AudioQualitySettings,
): Promise<AcquiredMicResult> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== 'function'
  ) {
    throw new Error(
      'Microphone capture requires a modern browser over HTTPS (or localhost).',
    );
  }

  const wantsSpecific =
    Boolean(deviceSettings.deviceId) && deviceSettings.deviceId !== 'default';

  let stream: MediaStream;
  let usedFallback = false;
  let fallbackReason: string | undefined;

  if (wantsSpecific) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: buildAudioConstraints(quality, deviceSettings.deviceId, true),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (
        name === 'OverconstrainedError' ||
        name === 'NotFoundError' ||
        name === 'ConstraintNotSatisfiedError'
      ) {
        usedFallback = true;
        fallbackReason = `"${deviceSettings.deviceLabel}" is unavailable — using System Default microphone.`;
        stream = await navigator.mediaDevices.getUserMedia({
          audio: buildAudioConstraints(quality, undefined, false),
        });
      } else {
        throw err;
      }
    }
  } else {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: buildAudioConstraints(quality, undefined, false),
    });
  }

  const track = stream.getAudioTracks()[0];
  const trackSettings = track?.getSettings?.() ?? {};
  const actualDeviceLabel =
    track?.label?.trim() ||
    (usedFallback
      ? 'System Default Microphone'
      : deviceSettings.deviceLabel || 'Microphone');

  return {
    stream,
    usedFallback,
    fallbackReason,
    actualDeviceId: trackSettings.deviceId || 'default',
    actualDeviceLabel,
    actualSampleRate: trackSettings.sampleRate,
    actualChannels: trackSettings.channelCount,
  };
}

export interface MicTestTelemetry {
  level: number; // 0..1 peak
  db: number; // -60..0
  clipping: boolean;
  actualDeviceLabel: string;
  actualSampleRate: number;
  actualChannels: number;
}

export class MicLevelTester {
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private rafId: number | null = null;
  private stopped = false;

  async start(
    deviceSettings: AudioDeviceSettings,
    quality: AudioQualitySettings,
    onTelemetry: (t: MicTestTelemetry) => void,
  ): Promise<{ usedFallback: boolean; fallbackReason?: string }> {
    this.stop();
    this.stopped = false;

    const acquired = await acquireMicStream(deviceSettings, quality);
    if (this.stopped) {
      acquired.stream.getTracks().forEach((t) => t.stop());
      return { usedFallback: false };
    }

    this.stream = acquired.stream;
    const AudioCtxCtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;

    try {
      this.audioCtx = new AudioCtxCtor({ sampleRate: quality.sampleRate });
    } catch {
      this.audioCtx = new AudioCtxCtor();
    }
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }

    const source = this.audioCtx.createMediaStreamSource(this.stream);
    let tail: AudioNode = source;

    if (quality.highPassFilter) {
      const hpf = this.audioCtx.createBiquadFilter();
      hpf.type = 'highpass';
      hpf.frequency.value = 80;
      hpf.Q.value = 0.707;
      tail.connect(hpf);
      tail = hpf;
    }

    const gainNode = this.audioCtx.createGain();
    gainNode.gain.value = quality.inputGain;
    tail.connect(gainNode);
    tail = gainNode;

    if (quality.softLimiter) {
      const comp = this.audioCtx.createDynamicsCompressor();
      comp.threshold.value = -3;
      comp.knee.value = 6;
      comp.ratio.value = 12;
      comp.attack.value = 0.002;
      comp.release.value = 0.08;
      tail.connect(comp);
      tail = comp;
    }

    const analyser = this.audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    tail.connect(analyser);

    const timeData = new Float32Array(analyser.fftSize);
    const actualSampleRate =
      acquired.actualSampleRate || this.audioCtx.sampleRate;
    const actualChannels = acquired.actualChannels || quality.channels;

    const tick = () => {
      if (this.stopped) return;
      analyser.getFloatTimeDomainData(timeData);
      let peak = 0;
      for (let i = 0; i < timeData.length; i += 1) {
        const a = Math.abs(timeData[i]);
        if (a > peak) peak = a;
      }
      const db = peak > 1e-4 ? Math.max(-60, 20 * Math.log10(peak)) : -60;
      onTelemetry({
        level: Math.min(1, peak),
        db,
        clipping: peak >= 0.96,
        actualDeviceLabel: acquired.actualDeviceLabel,
        actualSampleRate,
        actualChannels,
      });
      this.rafId = window.requestAnimationFrame(tick);
    };

    tick();
    return {
      usedFallback: acquired.usedFallback,
      fallbackReason: acquired.fallbackReason,
    };
  }

  stop(): void {
    this.stopped = true;
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }
}
