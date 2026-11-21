import type {
  AudioFormatOption,
  AudioQualitySettings,
  BitrateKbpsOption,
  BitrateModeOption,
  ChannelCountOption,
  Recording,
  SampleRateOption,
  WavBitDepthOption,
} from '../types/models';
import { DEFAULT_AUDIO_QUALITY } from '../storage/settings';
import { blobToArrayBuffer } from '../utils/blob';
import { sanitizeFileName } from '../utils/format';
import { isMp4Buffer, repairDoubleWrappedEsdsMp4 } from './aacEsds';
import { encodeAudio, type EncodedAudioResult } from './nativeEncoder';
import { decodeWav, isWavBuffer } from './wavEncoder';

export interface DecodedPcmAudio {
  channels: Float32Array[];
  sampleRate: number;
  bitDepth?: number;
  durationMs: number;
}

export interface ExportQualitySpec {
  format: AudioFormatOption;
  sampleRate: SampleRateOption;
  bitrateKbps: BitrateKbpsOption;
  bitrateMode: BitrateModeOption;
  wavBitDepth: WavBitDepthOption;
}

export interface TranscodedExportResult {
  encoded: EncodedAudioResult;
  fileSizeBytes: number;
  bytesPerMinute: number;
  savingsPercent: number;
  compressionRatio: number;
  fileName: string;
}

export const THRESHOLD_LADDER_KBPS: BitrateKbpsOption[] = [
  32, 48, 64, 96, 128, 192, 256, 320,
];

export type BlindChoice = 'master' | 'compressed' | 'cant_tell';

export interface BlindTierResult {
  bitrateKbps: BitrateKbpsOption;
  achievedBitrateKbps?: number;
  extension: EncodedAudioResult['extension'];
  sampleRate: number;
  encodedBytes: number;
  bytesPerMinute: number;
  savingsPercent: number;
  trials: number;
  pickedMaster: number;
  pickedCompressed: number;
  cantTell: number;
}

export type TierClassification = 'untested' | 'audible' | 'transparent';

export interface ThresholdRecommendation {
  recommendedKbps: BitrateKbpsOption;
  extension: EncodedAudioResult['extension'];
  sampleRate: number;
  bytesPerMinute: number;
  savingsPercent: number;
  reason: string;
}

/**
 * Decodes any saved StoryTape audio blob (WAV, M4A, WebM) back to planar Float32 PCM.
 * WAV blobs are decoded directly in pure TypeScript for bit-exact lossless fidelity
 * across 16/24/32-bit Float without browser resampler drift.
 */
export async function decodeAudioBlob(blob: Blob): Promise<DecodedPcmAudio> {
  const buffer = await blobToArrayBuffer(blob);
  if (isWavBuffer(buffer)) {
    return decodeWav(buffer);
  }

  const AudioCtx =
    typeof window !== 'undefined'
      ? window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext
      : undefined;

  if (!AudioCtx) {
    throw new Error('Web Audio decoding is unavailable in this environment.');
  }

  const ctx = new AudioCtx();
  try {
    const decodeTarget = isMp4Buffer(buffer)
      ? repairDoubleWrappedEsdsMp4(buffer).buffer
      : buffer;
    const decoded = await ctx.decodeAudioData(decodeTarget.slice(0));
    const channels: Float32Array[] = [];
    for (let ch = 0; ch < decoded.numberOfChannels; ch += 1) {
      channels.push(decoded.getChannelData(ch).slice());
    }
    return {
      channels,
      sampleRate: decoded.sampleRate,
      durationMs: Math.round(decoded.duration * 1000),
    };
  } finally {
    await ctx.close().catch(() => {});
  }
}

/**
 * Extracts a contiguous time window from decoded PCM (used for fast looped A/B passages
 * on long recordings while leaving short recordings intact).
 */
export function slicePcmWindow(
  pcm: DecodedPcmAudio,
  startSec: number,
  windowDurationSec: number,
): DecodedPcmAudio {
  const totalFrames = pcm.channels[0]?.length ?? 0;
  if (totalFrames === 0) return pcm;

  const startFrame = Math.max(
    0,
    Math.min(totalFrames - 1, Math.floor(startSec * pcm.sampleRate)),
  );
  const maxFrames = Math.max(1, Math.floor(windowDurationSec * pcm.sampleRate));
  const endFrame = Math.min(totalFrames, startFrame + maxFrames);
  const actualFrames = Math.max(1, endFrame - startFrame);

  return {
    channels: pcm.channels.map((ch) => ch.slice(startFrame, startFrame + actualFrames)),
    sampleRate: pcm.sampleRate,
    bitDepth: pcm.bitDepth,
    durationMs: Math.round((actualFrames / pcm.sampleRate) * 1000),
  };
}

export function buildExportFileName(
  recording: Pick<Recording, 'orderIndex' | 'name'>,
  encoded: Pick<EncodedAudioResult, 'extension' | 'sampleRate' | 'bitrateKbps' | 'bitDepth'>,
  isMaster = false,
): string {
  const prefix = String(recording.orderIndex + 1).padStart(2, '0');
  const cleanName = sanitizeFileName(recording.name, 'Chapter').replace(/\s+/g, '_');
  const srTag =
    encoded.sampleRate % 1000 === 0
      ? `${encoded.sampleRate / 1000}kHz`
      : `${(encoded.sampleRate / 1000).toFixed(1)}kHz`;

  if (encoded.extension === 'wav') {
    const depthTag =
      encoded.bitDepth === 32 ? '32f' : `${encoded.bitDepth ?? 16}bit`;
    const masterTag = isMaster ? 'master_' : '';
    return `${prefix}_${cleanName}_${masterTag}${depthTag}_${srTag}.wav`;
  }

  const kbpsTag = encoded.bitrateKbps ? `${encoded.bitrateKbps}kbps_` : '';
  return `${prefix}_${cleanName}_${kbpsTag}${srTag}.${encoded.extension}`;
}

export async function transcodePcm(
  pcm: DecodedPcmAudio,
  spec: ExportQualitySpec,
  recordingMeta: Pick<Recording, 'orderIndex' | 'name'>,
  referenceBytes: number,
  onProgress?: (ratio: number) => void,
): Promise<TranscodedExportResult> {
  const channels: ChannelCountOption = pcm.channels.length >= 2 ? 2 : 1;
  const qualitySettings: AudioQualitySettings = {
    ...DEFAULT_AUDIO_QUALITY,
    preset: 'custom',
    format: spec.format,
    sampleRate: spec.sampleRate,
    bitrateKbps: spec.bitrateKbps,
    bitrateMode: spec.bitrateMode,
    channels,
    wavBitDepth: spec.wavBitDepth,
  };

  const encoded = await encodeAudio(
    pcm.channels,
    pcm.sampleRate,
    qualitySettings,
    onProgress,
  );

  const fileSizeBytes = encoded.blob.size;
  const durationMin = Math.max(0.001, pcm.durationMs / 60_000);
  const bytesPerMinute = Math.round(fileSizeBytes / durationMin);
  const safeRef = Math.max(1, referenceBytes);
  const savingsPercent = Math.round(((safeRef - fileSizeBytes) / safeRef) * 100);
  const compressionRatio = Number((safeRef / Math.max(1, fileSizeBytes)).toFixed(1));

  return {
    encoded,
    fileSizeBytes,
    bytesPerMinute,
    savingsPercent,
    compressionRatio,
    fileName: buildExportFileName(recordingMeta, encoded),
  };
}

export function classifyBlindTier(tier?: BlindTierResult): TierClassification {
  if (!tier || tier.trials === 0) return 'untested';
  // If user explicitly chose "Can't tell" or picked compressed at least as often as master,
  // they did not demonstrate an audible preference for the lossless master at this bitrate.
  if (tier.cantTell > 0 && tier.pickedMaster <= tier.cantTell + tier.pickedCompressed) {
    return 'transparent';
  }
  if (tier.pickedMaster > tier.pickedCompressed && tier.pickedMaster / tier.trials >= 0.6) {
    return 'audible';
  }
  return 'transparent';
}

/**
 * Determines the lowest bitrate that tested transparent (indistinguishable from Master)
 * above the highest bitrate where the user still heard a clear difference.
 */
export function computeThresholdRecommendation(
  tiers: Record<number, BlindTierResult>,
): ThresholdRecommendation | null {
  const tested = Object.values(tiers)
    .filter((t) => t.trials > 0)
    .sort((a, b) => a.bitrateKbps - b.bitrateKbps);

  if (tested.length === 0) return null;

  let highestAudible = -1;
  for (const t of tested) {
    if (classifyBlindTier(t) === 'audible') {
      highestAudible = Math.max(highestAudible, t.bitrateKbps);
    }
  }

  const transparentAbove = tested.find(
    (t) =>
      t.bitrateKbps > highestAudible && classifyBlindTier(t) === 'transparent',
  );

  if (!transparentAbove) return null;

  const fmt = transparentAbove.extension.toUpperCase();
  const reason =
    highestAudible > 0
      ? `You heard a difference at ${highestAudible} kbps, but ${transparentAbove.bitrateKbps} kbps ${fmt} was indistinguishable from your lossless master.`
      : `${transparentAbove.bitrateKbps} kbps ${fmt} already sounded indistinguishable from your lossless master.`;

  return {
    recommendedKbps: transparentAbove.bitrateKbps,
    extension: transparentAbove.extension,
    sampleRate: transparentAbove.sampleRate,
    bytesPerMinute: transparentAbove.bytesPerMinute,
    savingsPercent: transparentAbove.savingsPercent,
    reason,
  };
}
