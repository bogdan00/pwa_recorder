import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AUDIO_QUALITY } from '../../storage/settings';
import {
  detectMatchingPreset,
  estimateSizePerMinuteBytes,
  probeAudioCapabilities,
  QUALITY_PRESETS,
  resetCapabilitiesCacheForTests,
} from '../qualityPresets';
import { encodeWav } from '../wavEncoder';
import {
  encodeAudio,
  mapSampleRateForOpus,
  resampleChannelData,
} from '../nativeEncoder';

async function readBlobBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

describe('qualityPresets & size estimation', () => {
  afterEach(() => {
    resetCapabilitiesCacheForTests();
    vi.unstubAllGlobals();
  });

  it('detects matching presets and switches to custom when tweaked', () => {
    for (const preset of QUALITY_PRESETS) {
      expect(detectMatchingPreset(preset.settings)).toBe(preset.id);
    }
    const tweaked = {
      ...QUALITY_PRESETS[1].settings,
      bitrateKbps: 510 as const,
      sampleRate: 96000 as const,
    };
    expect(detectMatchingPreset(tweaked)).toBe('custom');
  });

  it('calculates accurate MB/min estimates for compressed (up to 510 kbps) and WAV (up to 96 kHz / 32-bit float)', () => {
    const compressed510 = estimateSizePerMinuteBytes({
      ...DEFAULT_AUDIO_QUALITY,
      format: 'webm',
      bitrateKbps: 510,
    });
    // 510 kbps * 60s / 8 * 1.03 ≈ 3,939,750 bytes/min
    expect(compressed510).toBeGreaterThan(3_800_000);
    expect(compressed510).toBeLessThan(4_100_000);

    const wav96Stereo32f = estimateSizePerMinuteBytes({
      ...DEFAULT_AUDIO_QUALITY,
      format: 'wav',
      sampleRate: 96000,
      channels: 2,
      wavBitDepth: 32,
    });
    // 96000 * 2 ch * 4 bytes * 60s = 46,080,000 bytes/min
    expect(wav96Stereo32f).toBe(46_080_000);
  });
});

describe('WAV encoder (16-bit, 24-bit, 32-bit IEEE Float)', () => {
  it('writes valid 16-bit mono RIFF/WAVE header and payload', async () => {
    const ch0 = new Float32Array([0, 0.5, -0.5, 1.0]);
    const blob = encodeWav([ch0], 44100, 16);
    const buf = await readBlobBuffer(blob);
    const view = new DataView(buf);

    expect(blob.type).toBe('audio/wav');
    expect(buf.byteLength).toBe(44 + 4 * 2);
    expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))).toBe('RIFF');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // Mono
    expect(view.getUint32(24, true)).toBe(44100);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getInt16(44 + 6, true)).toBe(32767);
  });

  it('writes valid 24-bit stereo RIFF/WAVE header and payload', async () => {
    const left = new Float32Array([0, 1.0]);
    const right = new Float32Array([0, -1.0]);
    const blob = encodeWav([left, right], 48000, 24);
    const buf = await readBlobBuffer(blob);
    const view = new DataView(buf);

    expect(buf.byteLength).toBe(44 + 2 * 2 * 3);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(2); // Stereo
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint16(34, true)).toBe(24);
  });

  it('writes valid 32-bit IEEE Float WAV header (format tag 3)', async () => {
    const ch0 = new Float32Array([0.125, -0.625]);
    const blob = encodeWav([ch0], 96000, 32);
    const buf = await readBlobBuffer(blob);
    const view = new DataView(buf);

    expect(buf.byteLength).toBe(44 + 2 * 4);
    expect(view.getUint16(20, true)).toBe(3); // IEEE Float
    expect(view.getUint32(24, true)).toBe(96000);
    expect(view.getUint16(34, true)).toBe(32);
    expect(view.getFloat32(44, true)).toBeCloseTo(0.125, 6);
    expect(view.getFloat32(48, true)).toBeCloseTo(-0.625, 6);
  });
});

describe('nativeEncoder resampling & adaptive codec fallback', () => {
  afterEach(() => {
    resetCapabilitiesCacheForTests();
    vi.unstubAllGlobals();
  });

  it('maps unsupported Opus rates cleanly to valid Opus rates', () => {
    expect(mapSampleRateForOpus(44100)).toBe(48000);
    expect(mapSampleRateForOpus(96000)).toBe(48000);
    expect(mapSampleRateForOpus(24000)).toBe(24000);
    expect(mapSampleRateForOpus(16000)).toBe(16000);
  });

  it('resamples channel data accurately when hardware rate differs from target rate', async () => {
    const src = [new Float32Array(4800).fill(0.5)];
    const dst = await resampleChannelData(src, 48000, 24000);
    expect(dst[0].length).toBe(2400);
    expect(dst[0][100]).toBeCloseTo(0.5, 4);
  });

  it('falls back cleanly to lossless WAV when WebCodecs AudioEncoder is unavailable', async () => {
    vi.stubGlobal('AudioEncoder', undefined);
    resetCapabilitiesCacheForTests();

    const caps = await probeAudioCapabilities(true);
    expect(caps.webCodecsAvailable).toBe(false);
    expect(caps.autoBestFormat).toBe('wav');

    const result = await encodeAudio(
      [new Float32Array(1000).fill(0.25)],
      48000,
      {
        ...DEFAULT_AUDIO_QUALITY,
        format: 'auto',
        sampleRate: 44100,
        wavBitDepth: 24,
      },
    );

    expect(result.extension).toBe('wav');
    expect(result.mimeType).toBe('audio/wav');
    expect(result.sampleRate).toBe(44100);
    expect(result.bitDepth).toBe(24);
    expect(result.blob.size).toBeGreaterThan(44);
  });

  it('probes WebCodecs max supported bitrate cleanly when AudioEncoder is present', async () => {
    const mockIsConfigSupported = vi.fn(
      async (cfg: { codec: string; bitrate?: number; numberOfChannels: number }) => {
        if (cfg.codec === 'mp4a.40.2') {
          return {
            supported: (cfg.bitrate ?? 0) <= (cfg.numberOfChannels === 2 ? 320000 : 256000),
          };
        }
        if (cfg.codec === 'opus') {
          return {
            supported: (cfg.bitrate ?? 0) <= (cfg.numberOfChannels === 2 ? 510000 : 256000),
          };
        }
        return { supported: false };
      },
    );

    vi.stubGlobal('AudioEncoder', {
      isConfigSupported: mockIsConfigSupported,
    });
    vi.stubGlobal('AudioData', class {});
    resetCapabilitiesCacheForTests();

    const caps = await probeAudioCapabilities(true);
    expect(caps.webCodecsAvailable).toBe(true);
    expect(caps.aacSupported).toBe(true);
    expect(caps.aacMaxMonoKbps).toBe(256);
    expect(caps.aacMaxStereoKbps).toBe(320);
    expect(caps.opusSupported).toBe(true);
    expect(caps.opusMaxMonoKbps).toBe(256);
    expect(caps.opusMaxStereoKbps).toBe(510);
    expect(caps.autoBestFormat).toBe('m4a');
  });

  it('applies transparent -1 dBFS true-peak ceiling on integer WAV exports while preserving 32-bit float headroom', async () => {
    const hot = [new Float32Array([0.2, 1.08, -1.15, -0.3])];

    const wav16 = await encodeAudio(hot, 48000, {
      ...DEFAULT_AUDIO_QUALITY,
      format: 'wav',
      sampleRate: 48000,
      wavBitDepth: 16,
    });
    const buf16 = await readBlobBuffer(wav16.blob);
    const view16 = new DataView(buf16);
    const peakSample16 = Math.abs(view16.getInt16(44 + 2, true)) / 0x7fff;
    // Softly limited below -1 dBFS (~0.8913) instead of hard-clipping at 1.0
    expect(peakSample16).toBeGreaterThan(0.85);
    expect(peakSample16).toBeLessThan(0.9);

    const wav32 = await encodeAudio(hot, 48000, {
      ...DEFAULT_AUDIO_QUALITY,
      format: 'wav',
      sampleRate: 48000,
      wavBitDepth: 32,
    });
    const buf32 = await readBlobBuffer(wav32.blob);
    const view32 = new DataView(buf32);
    // 32-bit float archival master preserves full float headroom (>1.0) untouched
    expect(view32.getFloat32(44 + 4, true)).toBeCloseTo(1.08, 5);
    expect(view32.getFloat32(44 + 8, true)).toBeCloseTo(-1.15, 5);
  });
});
