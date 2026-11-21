import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ArrayBufferTarget as Mp4ArrayBufferTarget,
  Muxer as Mp4Muxer,
} from 'mp4-muxer';
import { DEFAULT_AUDIO_QUALITY } from '../../storage/settings';
import {
  buildMpeg4AudioSpecificConfig,
  extractAudioSpecificConfigFromEsdsPayload,
  normalizeAacDecoderDescription,
  repairDoubleWrappedEsdsMp4,
} from '../aacEsds';
import { encodeAudio } from '../nativeEncoder';
import {
  canPlayAudioContainer,
  probeAudioCapabilities,
  resetCapabilitiesCacheForTests,
} from '../qualityPresets';
import { encodeWav } from '../wavEncoder';
import {
  formatPlaybackErrorMessage,
  normalizeAudioBlobType,
  preparePlayableAudioBlob,
  transcodeFloatWavForPlayback,
} from '../../player/playbackBlob';
import { blobToArrayBuffer } from '../../utils/blob';

// Exact 39-byte ESDS payload emitted by iOS 26 / Safari 26 AudioEncoder (WebKit Bug #302253)
// for 48 kHz mono AAC-LC (actual 2-byte AudioSpecificConfig is [17, 136] = [0x11, 0x88]).
const WEBKIT_BUG_302253_ESDS_48K_MONO = new Uint8Array([
  3, 128, 128, 128, 34, 0, 0, 0, 4, 128, 128, 128, 20, 64, 20, 0, 24, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 5, 128, 128, 128, 2, 17, 136, 6, 128, 128, 128, 1, 2,
]);

function readAscii(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

interface ParsedBox {
  type: string;
  start: number;
  end: number;
  size: number;
}

function walkBoxes(view: DataView, start: number, end: number): ParsedBox[] {
  const out: ParsedBox[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    const size = view.getUint32(pos, false);
    const type = readAscii(view, pos + 4);
    expect(size).toBeGreaterThanOrEqual(8);
    expect(pos + size).toBeLessThanOrEqual(end);
    out.push({ type, start: pos, end: pos + size, size });
    pos += size;
  }
  // Exact boundary fit — zero orphaned/truncated trailing bytes
  expect(pos).toBe(end);
  return out;
}

function extractEsdsPayloadFromMp4(buffer: ArrayBuffer): {
  esdsPayload: Uint8Array;
  mdatStart: number;
  moovChildren: ParsedBox[];
} {
  const view = new DataView(buffer);
  const top = walkBoxes(view, 0, buffer.byteLength);
  const moov = top.find((b) => b.type === 'moov')!;
  const mdat = top.find((b) => b.type === 'mdat')!;
  expect(moov).toBeDefined();
  expect(mdat).toBeDefined();

  const moovChildren = walkBoxes(view, moov.start + 8, moov.end);
  const trak = moovChildren.find((b) => b.type === 'trak')!;
  const mdia = walkBoxes(view, trak.start + 8, trak.end).find((b) => b.type === 'mdia')!;
  const minf = walkBoxes(view, mdia.start + 8, mdia.end).find((b) => b.type === 'minf')!;
  const stbl = walkBoxes(view, minf.start + 8, minf.end).find((b) => b.type === 'stbl')!;
  const stsd = walkBoxes(view, stbl.start + 8, stbl.end).find((b) => b.type === 'stsd')!;
  const mp4a = walkBoxes(view, stsd.start + 16, stsd.end).find((b) => b.type === 'mp4a')!;
  const esds = walkBoxes(view, mp4a.start + 36, mp4a.end).find((b) => b.type === 'esds')!;
  expect(esds).toBeDefined();

  return {
    esdsPayload: new Uint8Array(buffer, esds.start + 12, esds.size - 12),
    mdatStart: mdat.start,
    moovChildren,
  };
}

function buildTestMp4WithDescription(description: Uint8Array): ArrayBuffer {
  const target = new Mp4ArrayBufferTarget();
  const muxer = new Mp4Muxer({
    target,
    audio: {
      codec: 'aac',
      numberOfChannels: 1,
      sampleRate: 48000,
    },
    fastStart: 'in-memory',
  });
  // Synthetic AAC payload frames
  const fakeAacFrame = new Uint8Array([0x21, 0x00, 0x49, 0x90, 0x02, 0x19, 0x00, 0x23]);
  muxer.addAudioChunkRaw(fakeAacFrame, 'key', 0, 21333, {
    decoderConfig: {
      codec: 'mp4a.40.2',
      sampleRate: 48000,
      numberOfChannels: 1,
      description,
    },
  });
  muxer.addAudioChunkRaw(fakeAacFrame, 'key', 21333, 21333);
  muxer.finalize();
  return target.buffer;
}

describe('AAC AudioSpecificConfig & WebKit Bug #302253 ESDS unwrapping', () => {
  it('synthesizes spec-compliant ISO 14496-3 AudioSpecificConfig bytes', () => {
    expect(Array.from(buildMpeg4AudioSpecificConfig(48000, 1))).toEqual([0x11, 0x88]);
    expect(Array.from(buildMpeg4AudioSpecificConfig(48000, 2))).toEqual([0x11, 0x90]);
    expect(Array.from(buildMpeg4AudioSpecificConfig(44100, 1))).toEqual([0x12, 0x08]);
    expect(Array.from(buildMpeg4AudioSpecificConfig(44100, 2))).toEqual([0x12, 0x10]);
    expect(Array.from(buildMpeg4AudioSpecificConfig(24000, 1))).toEqual([0x13, 0x08]);
  });

  it('unwraps iOS 26 Safari WebKit Bug #302253 39-byte ESDS description to raw 2-byte AudioSpecificConfig', () => {
    const unwrapped = normalizeAacDecoderDescription(
      WEBKIT_BUG_302253_ESDS_48K_MONO,
      48000,
      1,
    );
    expect(Array.from(unwrapped)).toEqual([17, 136]);

    // Also handles ArrayBuffer input and optional leading version/flags [0,0,0,0]
    const withVerFlags = new Uint8Array(4 + WEBKIT_BUG_302253_ESDS_48K_MONO.length);
    withVerFlags.set(WEBKIT_BUG_302253_ESDS_48K_MONO, 4);
    expect(
      Array.from(normalizeAacDecoderDescription(withVerFlags.buffer, 48000, 1)),
    ).toEqual([17, 136]);
  });

  it('preserves already-clean Chromium AudioSpecificConfig descriptions untouched', () => {
    const aacLc = new Uint8Array([0x11, 0x88]);
    expect(Array.from(normalizeAacDecoderDescription(aacLc, 48000, 1))).toEqual([0x11, 0x88]);

    const heAac = new Uint8Array([0x2b, 0x92, 0x08, 0x00, 0x00]);
    expect(Array.from(normalizeAacDecoderDescription(heAac, 48000, 2))).toEqual([
      0x2b, 0x92, 0x08, 0x00, 0x00,
    ]);

    // Synthesizes fallback when description is omitted or empty
    expect(Array.from(normalizeAacDecoderDescription(undefined, 48000, 1))).toEqual([0x11, 0x88]);
    expect(Array.from(normalizeAacDecoderDescription(new Uint8Array(0), 44100, 2))).toEqual([
      0x12, 0x10,
    ]);
  });

  it('repairs real mp4-muxer double-wrapped esds M4A files while preserving exact byte size & mdat offset', () => {
    const corrupted = buildTestMp4WithDescription(WEBKIT_BUG_302253_ESDS_48K_MONO);
    const before = extractEsdsPayloadFromMp4(corrupted);

    const { repaired, buffer } = repairDoubleWrappedEsdsMp4(corrupted);
    expect(repaired).toBe(true);
    // Exact same total file size and exact same mdat offset (so stco offsets stay 100% valid!)
    expect(buffer.byteLength).toBe(corrupted.byteLength);

    const after = extractEsdsPayloadFromMp4(buffer);
    expect(after.mdatStart).toBe(before.mdatStart);
    // `moov` now ends with a clean `free` padding box matching the shrunk `esds` delta
    expect(after.moovChildren[after.moovChildren.length - 1].type).toBe('free');

    // Verify `esds` now carries the raw 2-byte [17, 136] AudioSpecificConfig directly
    const inner = extractAudioSpecificConfigFromEsdsPayload(after.esdsPayload);
    expect(inner).not.toBeNull();
    expect(Array.from(inner!)).toEqual([17, 136]);
    expect(after.esdsPayload.byteLength).toBeLessThan(before.esdsPayload.byteLength);

    // Idempotent: running repair a second time is a pure no-op
    const secondPass = repairDoubleWrappedEsdsMp4(buffer);
    expect(secondPass.repaired).toBe(false);
    expect(secondPass.buffer).toBe(buffer);
  });

  it('leaves already-healthy M4A files completely untouched', () => {
    const healthy = buildTestMp4WithDescription(new Uint8Array([0x11, 0x88]));
    const res = repairDoubleWrappedEsdsMp4(healthy);
    expect(res.repaired).toBe(false);
    expect(res.buffer).toBe(healthy);
  });
});

describe('nativeEncoder WebKit Bug #302253 & Safari container guards', () => {
  afterEach(() => {
    resetCapabilitiesCacheForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('normalizes WebKit ESDS description during encodeAudio so newly recorded iOS M4As have clean single-wrapped esds', async () => {
    class MockEncodedAudioChunk {
      type: 'key' | 'delta' = 'key';
      timestamp: number;
      duration: number;
      private payload: Uint8Array;
      byteLength: number;

      constructor(init: { timestamp: number; duration: number; data: Uint8Array }) {
        this.timestamp = init.timestamp;
        this.duration = init.duration;
        this.payload = init.data;
        this.byteLength = init.data.byteLength;
      }

      copyTo(dest: Uint8Array) {
        dest.set(this.payload);
      }
    }

    class MockAudioData {
      numberOfFrames: number;
      timestamp: number;
      constructor(init: { numberOfFrames: number; timestamp: number }) {
        this.numberOfFrames = init.numberOfFrames;
        this.timestamp = init.timestamp;
      }
      close() {}
    }

    class MockWebKitAudioEncoder {
      encodeQueueSize = 0;
      private onOutput: (chunk: unknown, meta?: EncodedAudioChunkMetadata) => void;
      private emittedFirst = false;

      static async isConfigSupported(cfg: AudioEncoderConfig) {
        return { supported: cfg.codec === 'mp4a.40.2' };
      }

      constructor(init: {
        output: (chunk: unknown, meta?: EncodedAudioChunkMetadata) => void;
      }) {
        this.onOutput = init.output;
      }

      configure() {}

      encode(data: { timestamp: number }) {
        const chunk = new MockEncodedAudioChunk({
          timestamp: data.timestamp,
          duration: 21333,
          data: new Uint8Array([0x21, 0x00, 0x49, 0x90, 0x02, 0x19]),
        });
        if (!this.emittedFirst) {
          this.emittedFirst = true;
          // Simulate Safari 26 emitting full 39-byte ESDS as description!
          this.onOutput(chunk, {
            decoderConfig: {
              codec: 'mp4a.40.2',
              sampleRate: 48000,
              numberOfChannels: 1,
              description: WEBKIT_BUG_302253_ESDS_48K_MONO,
            },
          });
        } else {
          this.onOutput(chunk);
        }
      }

      async flush() {}
      close() {}
    }

    vi.stubGlobal('EncodedAudioChunk', MockEncodedAudioChunk);
    vi.stubGlobal('AudioData', MockAudioData);
    vi.stubGlobal('AudioEncoder', MockWebKitAudioEncoder);
    resetCapabilitiesCacheForTests();

    const encoded = await encodeAudio(
      [new Float32Array(2048).fill(0.1)],
      48000,
      { ...DEFAULT_AUDIO_QUALITY, format: 'auto' },
    );

    expect(encoded.extension).toBe('m4a');
    expect(encoded.mimeType).toBe('audio/mp4');
    const buf = await blobToArrayBuffer(encoded.blob);
    // Must already be clean single-wrapped `esds` — repairDoubleWrappedEsdsMp4 sees zero corruption!
    expect(repairDoubleWrappedEsdsMp4(buf).repaired).toBe(false);
    const { esdsPayload } = extractEsdsPayloadFromMp4(buf);
    expect(Array.from(extractAudioSpecificConfigFromEsdsPayload(esdsPayload)!)).toEqual([
      17, 136,
    ]);
  });

  it('never falls back to unplayable WebM on Safari/iOS under format: auto', async () => {
    // Simulate Safari/iOS canPlayType: plays mp4 and wav, cannot play webm
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation((type) => {
      if (type.includes('webm')) return '';
      if (type.includes('mp4') || type.includes('wav')) return 'probably';
      return '';
    });

    expect(canPlayAudioContainer('m4a')).toBe(true);
    expect(canPlayAudioContainer('wav')).toBe(true);
    expect(canPlayAudioContainer('webm')).toBe(false);

    // Simulate WebCodecs where AAC configure throws and Opus would succeed
    class FailingAacEncoder {
      encodeQueueSize = 0;
      private onError: (err: Error) => void;
      static async isConfigSupported(cfg: AudioEncoderConfig) {
        return { supported: cfg.codec === 'mp4a.40.2' || cfg.codec === 'opus' };
      }
      constructor(init: { error: (err: Error) => void }) {
        this.onError = init.error;
      }
      configure(cfg: AudioEncoderConfig) {
        if (cfg.codec === 'mp4a.40.2') {
          this.onError(new Error('Simulated AAC failure'));
        }
      }
      encode() {}
      async flush() {}
      close() {}
    }

    vi.stubGlobal('AudioEncoder', FailingAacEncoder);
    vi.stubGlobal('AudioData', class { close() {} });
    resetCapabilitiesCacheForTests();

    const caps = await probeAudioCapabilities(true);
    expect(caps.autoBestFormat).toBe('m4a');

    const result = await encodeAudio(
      [new Float32Array(1024).fill(0.1)],
      48000,
      { ...DEFAULT_AUDIO_QUALITY, format: 'auto' },
    );

    // Must fall back to universally playable WAV — NEVER unplayable webm!
    expect(result.extension).toBe('wav');
    expect(result.mimeType).toBe('audio/wav');
  });
});

describe('playbackBlob Safari/iOS resilience helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes missing or application/octet-stream blob types from recording metadata', () => {
    const rawOctet = new Blob([new Uint8Array([1, 2, 3])], {
      type: 'application/octet-stream',
    });
    const fixed = normalizeAudioBlobType(rawOctet, {
      extension: 'm4a',
      mimeType: 'audio/mp4',
    });
    expect(fixed.type).toBe('audio/mp4');

    const xM4a = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/x-m4a' });
    expect(
      normalizeAudioBlobType(xM4a, { extension: 'm4a', mimeType: 'audio/x-m4a' }).type,
    ).toBe('audio/mp4');
  });

  it('preparePlayableAudioBlob repairs legacy double-wrapped M4A even with octet-stream MIME', async () => {
    const corruptedBuf = buildTestMp4WithDescription(WEBKIT_BUG_302253_ESDS_48K_MONO);
    const corruptedBlob = new Blob([corruptedBuf], {
      type: 'application/octet-stream',
    });

    const prepared = await preparePlayableAudioBlob(corruptedBlob, {
      extension: 'm4a',
      mimeType: 'audio/mp4',
    });
    expect(prepared.repaired).toBe(true);
    expect(prepared.blob.type).toBe('audio/mp4');

    const repairedBuf = await blobToArrayBuffer(prepared.blob);
    expect(repairDoubleWrappedEsdsMp4(repairedBuf).repaired).toBe(false);
  });

  it('transcodes 32-bit IEEE Float WAV to 16-bit PCM WAV fallback while skipping integer WAVs', async () => {
    const float32Wav = encodeWav([new Float32Array([0, 0.5, -0.5, 0.25])], 48000, 32);
    const fallback = await transcodeFloatWavForPlayback(float32Wav);
    expect(fallback).not.toBeNull();
    expect(fallback!.type).toBe('audio/wav');

    const view = new DataView(await blobToArrayBuffer(fallback!));
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(34, true)).toBe(16); // 16-bit

    const pcm16Wav = encodeWav([new Float32Array([0, 0.5])], 48000, 16);
    expect(await transcodeFloatWavForPlayback(pcm16Wav)).toBeNull();
  });

  it('formats cryptic Safari NotSupportedError into clear actionable guidance', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation((type) =>
      type.includes('webm') ? '' : 'probably',
    );
    const err = new DOMException('The operation is not supported.', 'NotSupportedError');
    expect(formatPlaybackErrorMessage(err, { extension: 'webm' })).toMatch(
      /cannot play WEBM audio/i,
    );
    expect(formatPlaybackErrorMessage(err, { extension: 'm4a' })).toMatch(
      /Unable to play this M4A audio file/i,
    );
  });
});
