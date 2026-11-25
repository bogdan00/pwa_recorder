import {
  ArrayBufferTarget as Mp4ArrayBufferTarget,
  Muxer as Mp4Muxer,
} from 'mp4-muxer';
import {
  ArrayBufferTarget as WebmArrayBufferTarget,
  Muxer as WebmMuxer,
} from 'webm-muxer';
import type {
  AudioQualitySettings,
  ChannelCountOption,
  EncodedAudioExtension,
} from '../types/models';
import { normalizeAacDecoderDescription } from './aacEsds';
import { applyPeakCeilingToChannels } from './inputStrip';
import {
  canPlayAudioContainer,
  probeAudioCapabilities,
  resolveEffectiveFormat,
} from './qualityPresets';
import { encodeWav } from './wavEncoder';

export interface EncodedAudioResult {
  blob: Blob;
  mimeType: string;
  extension: EncodedAudioExtension;
  sampleRate: number;
  bitrateKbps?: number;
  bitDepth?: number;
  channels: ChannelCountOption;
}

const OPUS_VALID_RATES = [8000, 12000, 16000, 24000, 48000] as const;

export function mapSampleRateForOpus(targetRate: number): number {
  if ((OPUS_VALID_RATES as readonly number[]).includes(targetRate)) {
    return targetRate;
  }
  // 44100 or 96000 -> 48000 (standard full-band Opus ceiling)
  if (targetRate > 24000) return 48000;
  return 24000;
}

export async function resampleChannelData(
  channels: Float32Array[],
  sourceRate: number,
  targetRate: number,
): Promise<Float32Array[]> {
  if (sourceRate === targetRate || channels.length === 0 || channels[0].length === 0) {
    return channels;
  }

  const numChannels = channels.length;
  const sourceFrames = channels[0].length;
  const targetFrames = Math.max(
    1,
    Math.round((sourceFrames * targetRate) / sourceRate),
  );

  // Use browser OfflineAudioContext high-quality sinc resampler when available
  if (typeof OfflineAudioContext !== 'undefined') {
    try {
      const offline = new OfflineAudioContext(
        numChannels,
        targetFrames,
        targetRate,
      );
      const srcBuffer = offline.createBuffer(
        numChannels,
        sourceFrames,
        sourceRate,
      );
      for (let ch = 0; ch < numChannels; ch += 1) {
        srcBuffer.copyToChannel(
          new Float32Array(channels[ch]),
          ch,
        );
      }
      const srcNode = offline.createBufferSource();
      srcNode.buffer = srcBuffer;
      srcNode.connect(offline.destination);
      srcNode.start(0);
      const rendered = await offline.startRendering();
      const out: Float32Array[] = [];
      for (let ch = 0; ch < numChannels; ch += 1) {
        out.push(rendered.getChannelData(ch).slice());
      }
      return out;
    } catch {
      // Fall through to linear interpolation resampler
    }
  }

  // Deterministic linear interpolation fallback (e.g. non-browser test envs)
  const ratio = sourceRate / targetRate;
  return channels.map((src) => {
    const dst = new Float32Array(targetFrames);
    for (let i = 0; i < targetFrames; i += 1) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = src[Math.min(idx, sourceFrames - 1)] || 0;
      const b = src[Math.min(idx + 1, sourceFrames - 1)] || a;
      dst[i] = a + (b - a) * frac;
    }
    return dst;
  });
}

async function resolveSupportedEncoderConfig(
  codec: 'mp4a.40.2' | 'opus',
  sampleRate: number,
  channels: ChannelCountOption,
  requestedBitrateKbps: number,
  bitrateMode: 'variable' | 'constant',
): Promise<{
  config: AudioEncoderConfig;
  achievedBitrateKbps: number;
} | null> {
  if (typeof AudioEncoder === 'undefined' || !AudioEncoder.isConfigSupported) {
    return null;
  }

  const candidateKbps = [
    requestedBitrateKbps,
    384,
    320,
    256,
    192,
    160,
    128,
    96,
    64,
    48,
    32,
  ].filter(
    (v, i, arr) => v <= requestedBitrateKbps && arr.indexOf(v) === i,
  );

  for (const kbps of candidateKbps) {
    const config: AudioEncoderConfig = {
      codec,
      sampleRate,
      numberOfChannels: channels,
      bitrate: kbps * 1000,
      bitrateMode,
    };
    try {
      const res = await AudioEncoder.isConfigSupported(config);
      if (res.supported) {
        return { config, achievedBitrateKbps: kbps };
      }
    } catch {
      // Retry without bitrateMode if browser rejects it
      try {
        const basicConfig: AudioEncoderConfig = {
          codec,
          sampleRate,
          numberOfChannels: channels,
          bitrate: kbps * 1000,
        };
        const res2 = await AudioEncoder.isConfigSupported(basicConfig);
        if (res2.supported) {
          return { config: basicConfig, achievedBitrateKbps: kbps };
        }
      } catch {
        // Continue trying lower bitrate
      }
    }
  }
  return null;
}

async function encodeViaWebCodecs(
  format: 'm4a' | 'webm',
  channelsData: Float32Array[],
  sampleRate: number,
  quality: AudioQualitySettings,
  onProgress?: (ratio: number) => void,
): Promise<EncodedAudioResult | null> {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') {
    return null;
  }

  const codec = format === 'm4a' ? 'mp4a.40.2' : 'opus';
  const numChannels: ChannelCountOption = channelsData.length >= 2 ? 2 : 1;
  const resolved = await resolveSupportedEncoderConfig(
    codec,
    sampleRate,
    numChannels,
    quality.bitrateKbps,
    quality.bitrateMode,
  );
  if (!resolved) return null;

  const mp4Target = format === 'm4a' ? new Mp4ArrayBufferTarget() : null;
  const mp4Muxer =
    format === 'm4a' && mp4Target
      ? new Mp4Muxer({
          target: mp4Target,
          audio: {
            codec: 'aac',
            numberOfChannels: numChannels,
            sampleRate,
          },
          fastStart: 'in-memory',
        })
      : null;

  const webmTarget = format === 'webm' ? new WebmArrayBufferTarget() : null;
  const webmMuxer =
    format === 'webm' && webmTarget
      ? new WebmMuxer({
          target: webmTarget,
          audio: {
            codec: 'A_OPUS',
            numberOfChannels: numChannels,
            sampleRate,
          },
        })
      : null;

  let encodeError: Error | null = null;

  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      if (mp4Muxer) {
        // Guard against WebKit Bug #302253 (iOS 26 Safari emitting a full 39-byte ESDS
        // box in meta.decoderConfig.description instead of the raw 2-byte AudioSpecificConfig).
        const safeMeta: EncodedAudioChunkMetadata | undefined = meta?.decoderConfig
          ? {
              ...meta,
              decoderConfig: {
                ...meta.decoderConfig,
                description: normalizeAacDecoderDescription(
                  meta.decoderConfig.description,
                  sampleRate,
                  numChannels,
                ),
              },
            }
          : meta;
        mp4Muxer.addAudioChunk(chunk, safeMeta);
      } else if (webmMuxer) {
        webmMuxer.addAudioChunk(chunk, meta);
      }
    },
    error: (err) => {
      encodeError = err instanceof Error ? err : new Error(String(err));
    },
  });

  encoder.configure(resolved.config);

  const totalFrames = channelsData[0]?.length ?? 0;
  const batchFrames = 4096;

  for (let start = 0; start < totalFrames; start += batchFrames) {
    if (encodeError) throw encodeError;
    const count = Math.min(batchFrames, totalFrames - start);

    // f32-planar layout: all frames of ch0, followed by all frames of ch1
    const planar = new Float32Array(count * numChannels);
    for (let ch = 0; ch < numChannels; ch += 1) {
      planar.set(channelsData[ch].subarray(start, start + count), ch * count);
    }

    const timestampUs = Math.round((start / sampleRate) * 1_000_000);
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate,
      numberOfFrames: count,
      numberOfChannels: numChannels,
      timestamp: timestampUs,
      data: planar,
    });

    encoder.encode(audioData);
    audioData.close();

    if (onProgress && totalFrames > 0) {
      onProgress(Math.min(0.95, (start + count) / totalFrames));
    }

    // Yield periodically on very long audiobooks so mobile UI stays responsive
    if (encoder.encodeQueueSize > 32) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  await encoder.flush();
  encoder.close();

  if (encodeError) throw encodeError;

  if (mp4Muxer && mp4Target) {
    mp4Muxer.finalize();
    onProgress?.(1);
    return {
      blob: new Blob([mp4Target.buffer], { type: 'audio/mp4' }),
      mimeType: 'audio/mp4',
      extension: 'm4a',
      sampleRate,
      bitrateKbps: resolved.achievedBitrateKbps,
      channels: numChannels,
    };
  }

  if (webmMuxer && webmTarget) {
    webmMuxer.finalize();
    onProgress?.(1);
    return {
      blob: new Blob([webmTarget.buffer], { type: 'audio/webm;codecs=opus' }),
      mimeType: 'audio/webm;codecs=opus',
      extension: 'webm',
      sampleRate,
      bitrateKbps: resolved.achievedBitrateKbps,
      channels: numChannels,
    };
  }

  return null;
}

/**
 * Encodes Float32 planar PCM channels using user's AudioQualitySettings,
 * automatically resampling to target sampleRate and adapting gracefully across
 * M4A (AAC) -> WebM (Opus) -> WAV (16/24/32-bit Float) fallbacks.
 */
export async function encodeAudio(
  sourceChannels: Float32Array[],
  sourceSampleRate: number,
  quality: AudioQualitySettings,
  onProgress?: (ratio: number) => void,
): Promise<EncodedAudioResult> {
  const numChannels: ChannelCountOption = sourceChannels.length >= 2 ? 2 : 1;
  const caps = await probeAudioCapabilities();
  const preferred = resolveEffectiveFormat(quality.format, caps);

  onProgress?.(0.05);

  if (preferred !== 'wav') {
    // Try preferred compressed format, then alternate compressed format (skipping
    // formats the current browser cannot play back unless explicitly requested),
    // before falling back to universally playable lossless WAV.
    const rawAttempts: Array<'m4a' | 'webm'> =
      preferred === 'm4a' ? ['m4a', 'webm'] : ['webm', 'm4a'];
    const attempts = rawAttempts.filter(
      (fmt) => quality.format === fmt || canPlayAudioContainer(fmt),
    );

    for (const fmt of attempts) {
      const targetRate =
        fmt === 'webm'
          ? mapSampleRateForOpus(quality.sampleRate)
          : Math.min(48000, quality.sampleRate); // AAC-LC standard max 48 kHz in most OS WebCodecs encoders
      try {
        const resampled = await resampleChannelData(
          sourceChannels,
          sourceSampleRate,
          targetRate,
        );
        // Bound inter-sample/post-resample peaks at -1.0 dBFS before lossy AAC/Opus encoding
        const bounded = applyPeakCeilingToChannels(resampled);
        const encoded = await encodeViaWebCodecs(
          fmt,
          bounded,
          targetRate,
          quality,
          onProgress,
        );
        if (encoded) return encoded;
      } catch {
        // Try next fallback format
      }
    }
  }

  // Lossless WAV (explicitly requested or guaranteed safety fallback)
  const resampled = await resampleChannelData(
    sourceChannels,
    sourceSampleRate,
    quality.sampleRate,
  );
  const prepared =
    quality.wavBitDepth === 32
      ? resampled
      : applyPeakCeilingToChannels(resampled);
  onProgress?.(0.6);
  const wavBlob = encodeWav(prepared, quality.sampleRate, quality.wavBitDepth);
  onProgress?.(1);
  return {
    blob: wavBlob,
    mimeType: 'audio/wav',
    extension: 'wav',
    sampleRate: quality.sampleRate,
    bitDepth: quality.wavBitDepth,
    channels: numChannels,
  };
}
