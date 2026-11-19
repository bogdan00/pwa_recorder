import type {
  AudioFormatOption,
  AudioQualitySettings,
  BitrateKbpsOption,
  QualityPresetId,
  SampleRateOption,
  WavBitDepthOption,
} from '../types/models';

export interface QualityPresetDefinition {
  id: Exclude<QualityPresetId, 'custom'>;
  name: string;
  tagline: string;
  settings: AudioQualitySettings;
}

export const SAMPLE_RATE_OPTIONS: Array<{
  value: SampleRateOption;
  label: string;
  note: string;
}> = [
  { value: 16000, label: '16 kHz', note: 'Compact voice' },
  { value: 24000, label: '24 kHz', note: 'Crisp speech' },
  { value: 44100, label: '44.1 kHz', note: 'CD / Audiobook' },
  { value: 48000, label: '48 kHz', note: 'Studio / Native' },
  { value: 96000, label: '96 kHz', note: 'Hi-Res USB Mic' },
];

export const BITRATE_OPTIONS: BitrateKbpsOption[] = [
  32, 48, 64, 96, 128, 160, 192, 256, 320, 384, 510,
];

export const WAV_BIT_DEPTH_OPTIONS: Array<{
  value: WavBitDepthOption;
  label: string;
  note: string;
}> = [
  { value: 16, label: '16-bit PCM', note: 'CD Standard' },
  { value: 24, label: '24-bit PCM', note: 'Studio Master' },
  { value: 32, label: '32-bit Float', note: 'Zero-Clip Archival' },
];

export const QUALITY_PRESETS: QualityPresetDefinition[] = [
  {
    id: 'compact',
    name: 'Voice Compact',
    tagline: '24 kHz · 64 kbps · Tiny uploads',
    settings: {
      preset: 'compact',
      format: 'auto',
      sampleRate: 24000,
      bitrateKbps: 64,
      bitrateMode: 'variable',
      channels: 1,
      wavBitDepth: 16,
      inputGain: 1.0,
      highPassFilter: true,
      softLimiter: true,
      noiseSuppression: true,
      autoGainControl: true,
      echoCancellation: false,
    },
  },
  {
    id: 'standard',
    name: 'Audiobook Standard',
    tagline: '44.1 kHz · 128 kbps · Balanced warmth',
    settings: {
      preset: 'standard',
      format: 'auto',
      sampleRate: 44100,
      bitrateKbps: 128,
      bitrateMode: 'variable',
      channels: 1,
      wavBitDepth: 24,
      inputGain: 1.0,
      highPassFilter: true,
      softLimiter: true,
      noiseSuppression: true,
      autoGainControl: true,
      echoCancellation: false,
    },
  },
  {
    id: 'studio',
    name: 'Studio Raw (320k)',
    tagline: '48 kHz · 320 kbps · Uncolored phone mic',
    settings: {
      preset: 'studio',
      format: 'auto',
      sampleRate: 48000,
      bitrateKbps: 320,
      bitrateMode: 'variable',
      channels: 1,
      wavBitDepth: 24,
      inputGain: 1.0,
      highPassFilter: true,
      softLimiter: true,
      noiseSuppression: false,
      autoGainControl: false,
      echoCancellation: false,
    },
  },
  {
    id: 'master',
    name: 'Master Archival WAV',
    tagline: '48 kHz · 24-bit Lossless · Raw capsule',
    settings: {
      preset: 'master',
      format: 'wav',
      sampleRate: 48000,
      bitrateKbps: 320,
      bitrateMode: 'variable',
      channels: 1,
      wavBitDepth: 24,
      inputGain: 1.0,
      highPassFilter: true,
      softLimiter: true,
      noiseSuppression: false,
      autoGainControl: false,
      echoCancellation: false,
    },
  },
];

export interface CodecCapabilities {
  webCodecsAvailable: boolean;
  aacSupported: boolean;
  aacMaxMonoKbps: number;
  aacMaxStereoKbps: number;
  opusSupported: boolean;
  opusMaxMonoKbps: number;
  opusMaxStereoKbps: number;
  wavSupported: true;
  autoBestFormat: 'm4a' | 'webm' | 'wav';
}

const PROBE_BITRATES = [510, 384, 320, 256, 192, 160, 128, 96, 64];

async function probeMaxBitrate(
  codec: string,
  sampleRate: number,
  numberOfChannels: 1 | 2,
): Promise<number> {
  if (typeof AudioEncoder === 'undefined' || !AudioEncoder.isConfigSupported) {
    return 0;
  }
  for (const kbps of PROBE_BITRATES) {
    try {
      const support = await AudioEncoder.isConfigSupported({
        codec,
        sampleRate,
        numberOfChannels,
        bitrate: kbps * 1000,
      });
      if (support.supported) return kbps;
    } catch {
      // Try next lower bitrate
    }
  }
  return 0;
}

let cachedCapabilities: CodecCapabilities | null = null;

export async function probeAudioCapabilities(
  forceRefresh = false,
): Promise<CodecCapabilities> {
  if (cachedCapabilities && !forceRefresh) {
    return cachedCapabilities;
  }

  const webCodecsAvailable =
    typeof AudioEncoder !== 'undefined' &&
    typeof AudioData !== 'undefined' &&
    typeof AudioEncoder.isConfigSupported === 'function';

  if (!webCodecsAvailable) {
    cachedCapabilities = {
      webCodecsAvailable: false,
      aacSupported: false,
      aacMaxMonoKbps: 0,
      aacMaxStereoKbps: 0,
      opusSupported: false,
      opusMaxMonoKbps: 0,
      opusMaxStereoKbps: 0,
      wavSupported: true,
      autoBestFormat: 'wav',
    };
    return cachedCapabilities;
  }

  const [aacMono, aacStereo, opusMono, opusStereo] = await Promise.all([
    probeMaxBitrate('mp4a.40.2', 48000, 1),
    probeMaxBitrate('mp4a.40.2', 48000, 2),
    probeMaxBitrate('opus', 48000, 1),
    probeMaxBitrate('opus', 48000, 2),
  ]);

  const aacSupported = aacMono > 0 || aacStereo > 0;
  const opusSupported = opusMono > 0 || opusStereo > 0;
  const autoBestFormat: 'm4a' | 'webm' | 'wav' = aacSupported
    ? 'm4a'
    : opusSupported
      ? 'webm'
      : 'wav';

  cachedCapabilities = {
    webCodecsAvailable: true,
    aacSupported,
    aacMaxMonoKbps: aacMono,
    aacMaxStereoKbps: aacStereo,
    opusSupported,
    opusMaxMonoKbps: opusMono,
    opusMaxStereoKbps: opusStereo,
    wavSupported: true,
    autoBestFormat,
  };
  return cachedCapabilities;
}

export function resetCapabilitiesCacheForTests(): void {
  cachedCapabilities = null;
}

export function resolveEffectiveFormat(
  requested: AudioFormatOption,
  caps?: CodecCapabilities | null,
): 'm4a' | 'webm' | 'wav' {
  if (requested === 'wav') return 'wav';
  if (!caps) {
    if (requested === 'm4a') return 'm4a';
    if (requested === 'webm') return 'webm';
    return 'm4a';
  }
  if (requested === 'm4a') {
    return caps.aacSupported ? 'm4a' : caps.opusSupported ? 'webm' : 'wav';
  }
  if (requested === 'webm') {
    return caps.opusSupported ? 'webm' : caps.aacSupported ? 'm4a' : 'wav';
  }
  return caps.autoBestFormat;
}

export function estimateSizePerMinuteBytes(
  quality: AudioQualitySettings,
  caps?: CodecCapabilities | null,
): number {
  const effectiveFormat = resolveEffectiveFormat(quality.format, caps);
  if (effectiveFormat === 'wav') {
    const bytesPerSample = quality.wavBitDepth / 8;
    return quality.sampleRate * quality.channels * bytesPerSample * 60;
  }
  // Effective bitrate may be clamped by platform codec max if capabilities are known
  let effectiveKbps: number = quality.bitrateKbps;
  if (caps) {
    if (effectiveFormat === 'm4a') {
      const cap =
        quality.channels === 2 ? caps.aacMaxStereoKbps : caps.aacMaxMonoKbps;
      if (cap > 0) effectiveKbps = Math.min(effectiveKbps, cap);
    } else if (effectiveFormat === 'webm') {
      const cap =
        quality.channels === 2 ? caps.opusMaxStereoKbps : caps.opusMaxMonoKbps;
      if (cap > 0) effectiveKbps = Math.min(effectiveKbps, cap);
    }
  }
  // kbps -> bytes/min with ~3% container overhead
  return Math.round(((effectiveKbps * 1000) / 8) * 60 * 1.03);
}

export function detectMatchingPreset(
  quality: AudioQualitySettings,
): QualityPresetId {
  for (const preset of QUALITY_PRESETS) {
    const p = preset.settings;
    if (
      p.format === quality.format &&
      p.sampleRate === quality.sampleRate &&
      p.bitrateKbps === quality.bitrateKbps &&
      p.bitrateMode === quality.bitrateMode &&
      p.channels === quality.channels &&
      p.wavBitDepth === quality.wavBitDepth &&
      p.highPassFilter === quality.highPassFilter &&
      p.softLimiter === quality.softLimiter &&
      p.noiseSuppression === quality.noiseSuppression &&
      p.autoGainControl === quality.autoGainControl &&
      p.echoCancellation === quality.echoCancellation &&
      Math.abs(p.inputGain - quality.inputGain) < 0.01
    ) {
      return preset.id;
    }
  }
  return 'custom';
}

export function formatQualitySummaryPill(
  quality: AudioQualitySettings,
  caps?: CodecCapabilities | null,
): string {
  const fmt = resolveEffectiveFormat(quality.format, caps).toUpperCase();
  const sr =
    quality.sampleRate % 1000 === 0
      ? `${quality.sampleRate / 1000}kHz`
      : `${(quality.sampleRate / 1000).toFixed(1)}kHz`;
  const ch = quality.channels === 2 ? 'Stereo' : 'Mono';
  if (fmt === 'WAV') {
    const depth =
      quality.wavBitDepth === 32 ? '32f' : `${quality.wavBitDepth}-bit`;
    return `${sr} · ${depth} WAV · ${ch}`;
  }
  return `${sr} · ${quality.bitrateKbps}k ${fmt} · ${ch}`;
}
