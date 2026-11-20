import { describe, expect, it } from 'vitest';
import {
  type BlindTierResult,
  buildExportFileName,
  classifyBlindTier,
  computeThresholdRecommendation,
  decodeAudioBlob,
  slicePcmWindow,
  transcodePcm,
} from '../audioExporter';
import { encodeWav } from '../wavEncoder';

function makeSineChannel(
  sampleRate: number,
  durationSec: number,
  freqHz: number,
  amp = 0.5,
): Float32Array {
  const frames = Math.round(sampleRate * durationSec);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    out[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return out;
}

describe('WAV decodeWav round-trip & audioExporter', () => {
  it('round-trips 32-bit IEEE Float WAV bit-identically (mono & stereo)', async () => {
    const ch0 = new Float32Array([0, 0.25, -0.5, 0.9995, -0.875, 0.123456]);
    const ch1 = new Float32Array([-0.1, 0.6, -0.95, 0.0, 0.444, -0.333]);
    const blob = encodeWav([ch0, ch1], 48000, 32);
    const decoded = await decodeAudioBlob(blob);

    expect(decoded.sampleRate).toBe(48000);
    expect(decoded.bitDepth).toBe(32);
    expect(decoded.channels).toHaveLength(2);
    for (let i = 0; i < ch0.length; i += 1) {
      expect(decoded.channels[0][i]).toBeCloseTo(ch0[i], 6);
      expect(decoded.channels[1][i]).toBeCloseTo(ch1[i], 6);
    }
  });

  it('round-trips 16-bit PCM and 24-bit PCM WAV accurately', async () => {
    const ch = makeSineChannel(44100, 0.02, 440, 0.6);

    const wav16 = encodeWav([ch], 44100, 16);
    const dec16 = await decodeAudioBlob(wav16);
    expect(dec16.bitDepth).toBe(16);
    expect(dec16.sampleRate).toBe(44100);
    expect(dec16.channels[0].length).toBe(ch.length);
    expect(dec16.channels[0][100]).toBeCloseTo(ch[100], 3);

    const wav24 = encodeWav([ch], 48000, 24);
    const dec24 = await decodeAudioBlob(wav24);
    expect(dec24.bitDepth).toBe(24);
    expect(dec24.sampleRate).toBe(48000);
    expect(dec24.channels[0][100]).toBeCloseTo(ch[100], 5);
  });

  it('slices a PCM comparison window accurately', () => {
    const ch = makeSineChannel(1000, 10, 50);
    const sliced = slicePcmWindow(
      { channels: [ch], sampleRate: 1000, durationMs: 10_000 },
      2,
      3,
    );
    expect(sliced.durationMs).toBe(3000);
    expect(sliced.channels[0].length).toBe(3000);
    expect(sliced.channels[0][0]).toBeCloseTo(ch[2000], 6);
  });

  it('builds descriptive, collision-free export filenames', () => {
    const rec = { orderIndex: 0, name: 'Chapter 1: Into the Woods' };
    expect(
      buildExportFileName(rec, {
        extension: 'm4a',
        sampleRate: 48000,
        bitrateKbps: 96,
      }),
    ).toBe('01_Chapter_1_Into_the_Woods_96kbps_48kHz.m4a');

    expect(
      buildExportFileName(
        rec,
        {
          extension: 'wav',
          sampleRate: 48000,
          bitDepth: 32,
        },
        true,
      ),
    ).toBe('01_Chapter_1_Into_the_Woods_master_32f_48kHz.wav');
  });

  it('transcodes PCM to lower-resolution WAV and computes accurate savings vs 32f master', async () => {
    const ch = makeSineChannel(48000, 0.25, 330);
    const masterBlob = encodeWav([ch], 48000, 32);
    const pcm = await decodeAudioBlob(masterBlob);

    const exported = await transcodePcm(
      pcm,
      {
        format: 'wav',
        sampleRate: 24000,
        bitrateKbps: 128,
        bitrateMode: 'variable',
        wavBitDepth: 16,
      },
      { orderIndex: 0, name: 'Test Chapter' },
      masterBlob.size,
    );

    expect(exported.encoded.extension).toBe('wav');
    expect(exported.encoded.sampleRate).toBe(24000);
    expect(exported.encoded.bitDepth).toBe(16);
    expect(exported.fileSizeBytes).toBeLessThan(masterBlob.size / 3);
    expect(exported.savingsPercent).toBeGreaterThan(70);
    expect(exported.fileName).toContain('16bit_24kHz.wav');
  });

  it('classifies blind A/B tiers and computes lowest transparent sweet spot above highest audible bitrate', () => {
    const makeTier = (
      bitrateKbps: BlindTierResult['bitrateKbps'],
      pickedMaster: number,
      pickedCompressed: number,
      cantTell: number,
    ): BlindTierResult => ({
      bitrateKbps,
      achievedBitrateKbps: bitrateKbps,
      extension: 'm4a',
      sampleRate: 48000,
      encodedBytes: bitrateKbps * 1000,
      bytesPerMinute: bitrateKbps * 7500,
      savingsPercent: 95,
      trials: pickedMaster + pickedCompressed + cantTell,
      pickedMaster,
      pickedCompressed,
      cantTell,
    });

    const t32 = makeTier(32, 2, 0, 0);
    const t64 = makeTier(64, 2, 0, 0);
    const t96 = makeTier(96, 0, 0, 1);
    const t128 = makeTier(128, 0, 1, 0);

    expect(classifyBlindTier(t32)).toBe('audible');
    expect(classifyBlindTier(t64)).toBe('audible');
    expect(classifyBlindTier(t96)).toBe('transparent');
    expect(classifyBlindTier(t128)).toBe('transparent');

    const rec = computeThresholdRecommendation({
      32: t32,
      64: t64,
      96: t96,
      128: t128,
    });

    expect(rec).not.toBeNull();
    expect(rec?.recommendedKbps).toBe(96);
    expect(rec?.reason).toContain('64 kbps');
    expect(rec?.reason).toContain('96 kbps');
  });
});
