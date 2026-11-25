import { describe, expect, it } from 'vitest';
import {
  computeOverviewPeaksFromChannels,
  deriveChapterNameFromFileName,
  detectImportedAudioFormat,
  inspectImportedAudioFile,
  naturalSortFiles,
  parseWavHeader,
} from '../audioImporter';
import { encodeWav } from '../wavEncoder';
import { blobToArrayBuffer } from '../../utils/blob';
import {
  isAbortPlaybackError,
  normalizeAudioBlobType,
  resolveRecordingMimeType,
} from '../../player/playbackBlob';

function makeSineChannel(
  sampleRate: number,
  durationSec: number,
  amplitude = 0.5,
): Float32Array {
  const frames = Math.floor(sampleRate * durationSec);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    out[i] = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * amplitude;
  }
  return out;
}

describe('audioImporter', () => {
  describe('deriveChapterNameFromFileName', () => {
    it('strips file extensions, leading track prefixes, and underscores', () => {
      expect(deriveChapterNameFromFileName('01 - The_Boy_Who_Lived.mp3')).toBe(
        'The Boy Who Lived',
      );
      expect(deriveChapterNameFromFileName('02_Bedtime_Story.m4a')).toBe(
        'Bedtime Story',
      );
      expect(deriveChapterNameFromFileName('3. Into the Woods.wav')).toBe(
        'Into the Woods',
      );
      expect(deriveChapterNameFromFileName('Voice Memo.m4b')).toBe('Voice Memo');
    });

    it('preserves numeric-only names and falls back when empty', () => {
      expect(deriveChapterNameFromFileName('01.mp3')).toBe('01');
      expect(deriveChapterNameFromFileName('.wav', 4)).toBe('Chapter 5');
      expect(deriveChapterNameFromFileName('   .mp3', 0)).toBe('Chapter 1');
    });
  });

  describe('detectImportedAudioFormat', () => {
    it('detects supported extensions and normalizes aliases (m4b -> m4a, opus -> ogg)', () => {
      expect(detectImportedAudioFormat('ch1.mp3', 'audio/mpeg')).toEqual({
        extension: 'mp3',
        mimeType: 'audio/mpeg',
      });
      expect(detectImportedAudioFormat('book.m4b', '')).toEqual({
        extension: 'm4a',
        mimeType: 'audio/mp4',
      });
      expect(detectImportedAudioFormat('memo.opus', 'application/octet-stream')).toEqual({
        extension: 'ogg',
        mimeType: 'audio/ogg',
      });
      expect(detectImportedAudioFormat('lossless.flac', 'audio/x-flac')).toEqual({
        extension: 'flac',
        mimeType: 'audio/flac',
      });
      expect(detectImportedAudioFormat('clip.aac', 'audio/aac')).toEqual({
        extension: 'aac',
        mimeType: 'audio/aac',
      });
      expect(detectImportedAudioFormat('rec.webm', 'audio/webm;codecs=opus')).toEqual({
        extension: 'webm',
        mimeType: 'audio/webm',
      });
    });

    it('detects container magic bytes even without an extension or MIME type', () => {
      const flacBytes = new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 0]);
      expect(detectImportedAudioFormat('untitled', '', flacBytes)).toEqual({
        extension: 'flac',
        mimeType: 'audio/flac',
      });

      const oggBytes = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0]);
      expect(detectImportedAudioFormat('untitled', '', oggBytes)).toEqual({
        extension: 'ogg',
        mimeType: 'audio/ogg',
      });

      const id3Bytes = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0, 0, 0, 0]);
      expect(detectImportedAudioFormat('untitled', '', id3Bytes)).toEqual({
        extension: 'mp3',
        mimeType: 'audio/mpeg',
      });

      const ftypBytes = new Uint8Array([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20,
      ]);
      expect(detectImportedAudioFormat('memo', '', ftypBytes)).toEqual({
        extension: 'm4a',
        mimeType: 'audio/mp4',
      });
    });

    it('rejects non-audio files and spoofed extensions with non-audio magic bytes', () => {
      expect(detectImportedAudioFormat('notes.txt', 'text/plain')).toBeNull();
      expect(detectImportedAudioFormat('cover.png', 'image/png')).toBeNull();
      // PNG magic bytes renamed to .mp3 must be rejected
      const pngMagic = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(detectImportedAudioFormat('fake.mp3', 'audio/mpeg', pngMagic)).toBeNull();
      // PDF magic bytes renamed to .wav must be rejected
      const pdfMagic = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
      expect(detectImportedAudioFormat('fake.wav', 'audio/wav', pdfMagic)).toBeNull();
    });
  });

  describe('naturalSortFiles', () => {
    it('sorts numbered chapter files naturally (2 before 10)', () => {
      const files = [
        new File(['a'], 'Chapter 10.mp3'),
        new File(['a'], 'Chapter 2.mp3'),
        new File(['a'], 'Chapter 1.mp3'),
      ];
      expect(naturalSortFiles(files).map((f) => f.name)).toEqual([
        'Chapter 1.mp3',
        'Chapter 2.mp3',
        'Chapter 10.mp3',
      ]);
    });
  });

  describe('parseWavHeader & inspectImportedAudioFile', () => {
    it('inspects real 16-bit mono WAV and 32-bit float stereo WAV with accurate metadata and overview peaks', async () => {
      const monoPcm = makeSineChannel(24000, 1.5, 0.6);
      const monoWavBlob = encodeWav([monoPcm], 24000, 16);
      const monoFile = new File([monoWavBlob], '01 - Night_Sky.wav', {
        type: 'audio/x-wav',
      });

      const monoResult = await inspectImportedAudioFile(monoFile);
      expect(monoResult.suggestedName).toBe('Night Sky');
      expect(monoResult.extension).toBe('wav');
      expect(monoResult.mimeType).toBe('audio/wav');
      expect(monoResult.blob.type).toBe('audio/wav');
      expect(monoResult.sampleRate).toBe(24000);
      expect(monoResult.channels).toBe(1);
      expect(monoResult.bitDepth).toBe(16);
      expect(monoResult.durationMs).toBe(1500);
      expect(monoResult.peaks.length).toBe(120);
      expect(Math.max(...monoResult.peaks)).toBeGreaterThan(0.5);

      const stereoWavBlob = encodeWav(
        [makeSineChannel(48000, 1.0, 0.4), makeSineChannel(48000, 1.0, 0.8)],
        48000,
        32,
      );
      const stereoFile = new File([stereoWavBlob], 'Prologue.wav', { type: '' });
      const stereoResult = await inspectImportedAudioFile(stereoFile);
      expect(stereoResult.channels).toBe(2);
      expect(stereoResult.bitDepth).toBe(32);
      expect(stereoResult.sampleRate).toBe(48000);
      expect(stereoResult.durationMs).toBe(1000);
      expect(Math.max(...stereoResult.peaks)).toBeGreaterThan(0.75);
    });

    it('parses WAV headers via totalFileBytes without requiring full file in buffer', async () => {
      const wavBlob = encodeWav([makeSineChannel(16000, 2.0, 0.5)], 16000, 16);
      const fullBuf = await blobToArrayBuffer(wavBlob);
      const headOnly = fullBuf.slice(0, 128);
      const header = parseWavHeader(headOnly, fullBuf.byteLength);
      expect(header).not.toBeNull();
      expect(header?.sampleRate).toBe(16000);
      expect(header?.durationMs).toBe(2000);
      expect(header?.bitDepth).toBe(16);
    });

    it('falls back to HTML audio duration probe for compressed formats (MP3/M4A) and estimates bitrate', async () => {
      // ID3 header + ~16 KB payload for 1 second (~128 kbps)
      const payload = new Uint8Array(16_000);
      payload[0] = 0x49;
      payload[1] = 0x44;
      payload[2] = 0x33;
      const mp3File = new File([payload], '04 - Forest Walk.mp3', {
        type: 'audio/mp3',
      });

      const result = await inspectImportedAudioFile(mp3File, {
        probeHtmlAudio: async () => 1.0,
      });

      expect(result.suggestedName).toBe('Forest Walk');
      expect(result.extension).toBe('mp3');
      expect(result.mimeType).toBe('audio/mpeg');
      expect(result.blob.type).toBe('audio/mpeg');
      expect(result.durationMs).toBe(1000);
      expect(result.bitrateKbps).toBe(128);
      expect(result.fileSizeBytes).toBe(16_000);
    });

    it('rejects empty files, non-audio files, and corrupted WAV files', async () => {
      const emptyFile = new File([], 'empty.mp3', { type: 'audio/mpeg' });
      await expect(inspectImportedAudioFile(emptyFile)).rejects.toThrow(/empty/i);

      const textFile = new File(['hello world'], 'readme.txt', {
        type: 'text/plain',
      });
      await expect(inspectImportedAudioFile(textFile)).rejects.toThrow(/unsupported/i);

      const badWav = new File(['RIFF1234WAVEgarbage'], 'broken.wav', {
        type: 'audio/wav',
      });
      await expect(inspectImportedAudioFile(badWav)).rejects.toThrow(/invalid|corrupted/i);
    });
  });

  describe('computeOverviewPeaksFromChannels', () => {
    it('handles empty channels safely and clamps values to [0, 1]', () => {
      expect(computeOverviewPeaksFromChannels([])).toEqual([]);
      const loud = new Float32Array([0, 1.5, -2.0, 0.25]);
      const peaks = computeOverviewPeaksFromChannels([loud], 4);
      expect(peaks).toEqual([0, 1, 1, 0.25]);
    });
  });

  describe('playbackBlob MIME support for imported extensions', () => {
    it('resolves and canonicalizes MIME types for mp3, ogg, flac, aac, wav, and m4a', () => {
      expect(resolveRecordingMimeType({ extension: 'mp3', mimeType: '' })).toBe(
        'audio/mpeg',
      );
      expect(resolveRecordingMimeType({ extension: 'ogg', mimeType: '' })).toBe(
        'audio/ogg',
      );
      expect(resolveRecordingMimeType({ extension: 'flac', mimeType: 'audio/x-flac' })).toBe(
        'audio/flac',
      );
      expect(resolveRecordingMimeType({ extension: 'aac', mimeType: 'audio/x-aac' })).toBe(
        'audio/aac',
      );

      const rawBlob = new Blob([new Uint8Array([1, 2, 3])], {
        type: 'audio/x-wav',
      });
      const normalized = normalizeAudioBlobType(rawBlob, {
        extension: 'wav',
        mimeType: 'audio/x-wav',
      });
      expect(normalized.type).toBe('audio/wav');
    });

    it('detects benign play() abort errors caused by rapid pause or track switch', () => {
      expect(
        isAbortPlaybackError({
          name: 'AbortError',
          message: 'The play() request was interrupted by a call to pause().',
        }),
      ).toBe(true);
      expect(
        isAbortPlaybackError({
          name: 'Error',
          message: 'The play() request was interrupted by a new load request.',
        }),
      ).toBe(true);
      expect(
        isAbortPlaybackError({
          name: 'NotSupportedError',
          message: 'The operation is not supported.',
        }),
      ).toBe(false);
    });
  });
});
