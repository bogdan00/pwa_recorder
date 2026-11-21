import type {
  AudioDeviceSettings,
  AudioQualitySettings,
  ChannelCountOption,
} from '../types/models';
import type { DecodedPcmAudio } from './audioExporter';
import { buildStudioInputStrip } from './inputStrip';
import {
  attachPcmCapture,
  type PcmCaptureHandle,
  teardownPcmCapture,
} from './pcmCapture';
import { encodeWav } from './wavEncoder';

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
  captureSampleRate?: number,
): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = {
    sampleRate: { ideal: captureSampleRate ?? quality.sampleRate },
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
  captureSampleRate?: number,
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
        audio: buildAudioConstraints(
          quality,
          deviceSettings.deviceId,
          true,
          captureSampleRate,
        ),
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
          audio: buildAudioConstraints(
            quality,
            undefined,
            false,
            captureSampleRate,
          ),
        });
      } else {
        throw err;
      }
    }
  } else {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: buildAudioConstraints(
        quality,
        undefined,
        false,
        captureSampleRate,
      ),
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
  capturedDurationMs: number;
}

export interface CapturedMicTestAudio {
  pcm: DecodedPcmAudio;
  wavBlob: Blob;
  deviceLabel: string;
  capturedAt: number;
}

const MAX_MIC_TEST_CAPTURE_SEC = 30;

export class MicLevelTester {
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private inputStripNodes: AudioNode[] = [];
  private captureHandle: PcmCaptureHandle | null = null;
  private rafId: number | null = null;
  private stopped = false;

  // Rolling raw 32-bit Float PCM capture for instant A/B Quality Lab testing
  private captureChunks: Float32Array[] = [];
  private capturedFrames = 0;
  private captureSampleRate = 48000;
  private captureChannels: ChannelCountOption = 1;
  private captureDeviceLabel = 'System Default Microphone';

  async start(
    deviceSettings: AudioDeviceSettings,
    quality: AudioQualitySettings,
    onTelemetry: (t: MicTestTelemetry) => void,
  ): Promise<{ usedFallback: boolean; fallbackReason?: string }> {
    this.stop();
    this.stopped = false;
    this.captureChunks = [];
    this.capturedFrames = 0;

    const AudioCtxCtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;

    // Create native-rate AudioContext with playback latencyHint inside click gesture
    try {
      this.audioCtx = new AudioCtxCtor({ latencyHint: 'playback' });
    } catch {
      this.audioCtx = new AudioCtxCtor();
    }
    if (this.audioCtx.state === 'suspended') {
      void this.audioCtx.resume().catch(() => {});
    }

    const acquired = await acquireMicStream(
      deviceSettings,
      quality,
      this.audioCtx.sampleRate,
    );
    if (this.stopped) {
      acquired.stream.getTracks().forEach((t) => t.stop());
      this.teardownAudioGraph();
      return { usedFallback: false };
    }

    this.stream = acquired.stream;
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume().catch(() => {});
    }

    const ctx = this.audioCtx;
    const targetChannels: ChannelCountOption = quality.channels === 2 ? 2 : 1;
    this.captureSampleRate = ctx.sampleRate;
    this.captureChannels = targetChannels;
    this.captureDeviceLabel = acquired.actualDeviceLabel;

    const source = ctx.createMediaStreamSource(this.stream);
    const strip = buildStudioInputStrip(ctx, source, quality);
    this.inputStripNodes = strip.nodes;
    const tail = strip.tail;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    tail.connect(analyser);
    this.inputStripNodes.push(analyser);

    // Attach off-main-thread PCM capture (AudioWorklet with ScriptProcessor fallback)
    this.captureHandle = await attachPcmCapture(ctx, tail, {
      channels: targetChannels,
      isActive: () => !this.stopped,
      isAborted: () => this.stopped,
      onChunk: ({ pcm }) => this.pushInterleavedChunk(pcm),
    });

    if (this.stopped) {
      this.teardownAudioGraph();
      return { usedFallback: false };
    }

    const timeData = new Float32Array(analyser.fftSize);
    const actualSampleRate =
      acquired.actualSampleRate || ctx.sampleRate;
    const actualChannels = acquired.actualChannels || targetChannels;

    const tick = () => {
      if (this.stopped) return;
      analyser.getFloatTimeDomainData(timeData);
      let peak = 0;
      for (let i = 0; i < timeData.length; i += 1) {
        const a = Math.abs(timeData[i]);
        if (a > peak) peak = a;
      }
      const db = peak > 1e-4 ? Math.max(-60, 20 * Math.log10(peak)) : -60;
      const capturedDurationMs = Math.round(
        (this.capturedFrames / Math.max(1, this.captureSampleRate)) * 1000,
      );
      onTelemetry({
        level: Math.min(1, peak),
        db,
        clipping: peak >= 0.96,
        actualDeviceLabel: acquired.actualDeviceLabel,
        actualSampleRate,
        actualChannels,
        capturedDurationMs,
      });
      this.rafId = window.requestAnimationFrame(tick);
    };

    tick();
    return {
      usedFallback: acquired.usedFallback,
      fallbackReason: acquired.fallbackReason,
    };
  }

  private pushInterleavedChunk(interleaved: Float32Array): void {
    if (this.stopped || interleaved.length === 0) return;
    const frames = Math.floor(interleaved.length / this.captureChannels);
    if (frames <= 0) return;
    this.captureChunks.push(interleaved);
    this.capturedFrames += frames;

    // Keep rolling window capped at MAX_MIC_TEST_CAPTURE_SEC so long mic checks never bloat RAM
    const maxFrames = this.captureSampleRate * MAX_MIC_TEST_CAPTURE_SEC;
    while (this.capturedFrames > maxFrames && this.captureChunks.length > 1) {
      const oldest = this.captureChunks.shift()!;
      this.capturedFrames -= Math.floor(oldest.length / this.captureChannels);
    }
  }

  /**
   * Builds an uncompressed 32-bit IEEE Float WAV & planar PCM snapshot
   * from the most recent Test Mic capture (returns null if < 150ms captured).
   */
  getCapturedAudio(): CapturedMicTestAudio | null {
    if (this.captureChunks.length === 0 || this.capturedFrames <= 0) {
      return null;
    }
    const durationMs = Math.round(
      (this.capturedFrames / Math.max(1, this.captureSampleRate)) * 1000,
    );
    if (durationMs < 150) return null;

    const numChannels = this.captureChannels;
    const totalFrames = this.capturedFrames;
    const channels = Array.from(
      { length: numChannels },
      () => new Float32Array(totalFrames),
    );

    let frameOffset = 0;
    for (const chunk of this.captureChunks) {
      const chunkFrames = Math.floor(chunk.length / numChannels);
      for (let f = 0; f < chunkFrames && frameOffset < totalFrames; f += 1) {
        for (let ch = 0; ch < numChannels; ch += 1) {
          channels[ch][frameOffset] = chunk[f * numChannels + ch];
        }
        frameOffset += 1;
      }
    }

    const pcm: DecodedPcmAudio = {
      channels,
      sampleRate: this.captureSampleRate,
      bitDepth: 32,
      durationMs,
    };
    const wavBlob = encodeWav(channels, this.captureSampleRate, 32);

    return {
      pcm,
      wavBlob,
      deviceLabel: this.captureDeviceLabel,
      capturedAt: Date.now(),
    };
  }

  private teardownAudioGraph(): void {
    for (const node of this.inputStripNodes) {
      try {
        node.disconnect();
      } catch {
        // Ignore
      }
    }
    this.inputStripNodes = [];

    if (this.captureHandle) {
      teardownPcmCapture(this.captureHandle);
      this.captureHandle = null;
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

  stop(): void {
    this.stopped = true;
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.teardownAudioGraph();
  }
}
