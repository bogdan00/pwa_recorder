import type { AudioExtension, ChannelCountOption } from '../types/models';
import { blobToArrayBuffer } from '../utils/blob';
import { isMp4Buffer, repairDoubleWrappedEsdsMp4 } from './aacEsds';
import { decodeWav, isWavBuffer } from './wavEncoder';

export const IMPORT_AUDIO_ACCEPT =
  'audio/*,.m4a,.m4b,.mp3,.wav,.webm,.ogg,.oga,.opus,.flac,.aac,.mp4';

/** Safety ceiling (500 MB) to prevent instant browser OOM on massive video/archive files. */
export const MAX_IMPORT_AUDIO_FILE_BYTES = 500 * 1024 * 1024;

/** Maximum compressed file size (25 MB) for in-memory Web Audio decoding to extract peaks & exact sample rate. */
const MAX_DECODE_AUDIO_DATA_BYTES = 25 * 1024 * 1024;

/** Maximum WAV file size (32 MB) for full PCM peak extraction. Larger WAVs still import via O(1) header parsing. */
const MAX_WAV_PEAK_DECODE_BYTES = 32 * 1024 * 1024;

export interface DetectedAudioFormat {
  extension: AudioExtension;
  mimeType: string;
}

export interface WavHeaderInfo {
  sampleRate: number;
  channels: ChannelCountOption;
  bitDepth: number;
  durationMs: number;
  totalFrames: number;
}

export interface ImportedAudioAnalysis {
  file: File;
  blob: Blob;
  originalFileName: string;
  suggestedName: string;
  extension: AudioExtension;
  mimeType: string;
  durationMs: number;
  sampleRate: number;
  channels: ChannelCountOption;
  bitrateKbps?: number;
  bitDepth?: number;
  fileSizeBytes: number;
  peaks: number[];
}

export interface InspectImportedAudioOptions {
  fallbackIndex?: number;
  probeHtmlAudio?: (blob: Blob) => Promise<number>;
}

const EXTENSION_FORMAT_MAP: Record<string, DetectedAudioFormat> = {
  wav: { extension: 'wav', mimeType: 'audio/wav' },
  wave: { extension: 'wav', mimeType: 'audio/wav' },
  m4a: { extension: 'm4a', mimeType: 'audio/mp4' },
  m4b: { extension: 'm4a', mimeType: 'audio/mp4' },
  mp4: { extension: 'm4a', mimeType: 'audio/mp4' },
  mp3: { extension: 'mp3', mimeType: 'audio/mpeg' },
  webm: { extension: 'webm', mimeType: 'audio/webm' },
  ogg: { extension: 'ogg', mimeType: 'audio/ogg' },
  oga: { extension: 'ogg', mimeType: 'audio/ogg' },
  opus: { extension: 'ogg', mimeType: 'audio/ogg' },
  flac: { extension: 'flac', mimeType: 'audio/flac' },
  aac: { extension: 'aac', mimeType: 'audio/aac' },
};

const MIME_FORMAT_MAP: Record<string, DetectedAudioFormat> = {
  'audio/wav': { extension: 'wav', mimeType: 'audio/wav' },
  'audio/x-wav': { extension: 'wav', mimeType: 'audio/wav' },
  'audio/wave': { extension: 'wav', mimeType: 'audio/wav' },
  'audio/mp4': { extension: 'm4a', mimeType: 'audio/mp4' },
  'audio/x-m4a': { extension: 'm4a', mimeType: 'audio/mp4' },
  'audio/m4a': { extension: 'm4a', mimeType: 'audio/mp4' },
  'video/mp4': { extension: 'm4a', mimeType: 'audio/mp4' },
  'audio/mpeg': { extension: 'mp3', mimeType: 'audio/mpeg' },
  'audio/mp3': { extension: 'mp3', mimeType: 'audio/mpeg' },
  'audio/x-mpeg': { extension: 'mp3', mimeType: 'audio/mpeg' },
  'audio/webm': { extension: 'webm', mimeType: 'audio/webm' },
  'video/webm': { extension: 'webm', mimeType: 'audio/webm' },
  'audio/ogg': { extension: 'ogg', mimeType: 'audio/ogg' },
  'audio/opus': { extension: 'ogg', mimeType: 'audio/ogg' },
  'audio/flac': { extension: 'flac', mimeType: 'audio/flac' },
  'audio/x-flac': { extension: 'flac', mimeType: 'audio/flac' },
  'audio/aac': { extension: 'aac', mimeType: 'audio/aac' },
  'audio/x-aac': { extension: 'aac', mimeType: 'audio/aac' },
};

function hasKnownNonAudioMagic(bytes?: Uint8Array): boolean {
  if (!bytes || bytes.length < 4) return false;
  // PNG
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return true;
  }
  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return true;
  }
  // PDF (%PDF)
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return true;
  }
  // ZIP (PK\x03\x04)
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return true;
  }
  // GIF8
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return true;
  }
  return false;
}

function sniffAudioMagic(bytes?: Uint8Array): DetectedAudioFormat | null {
  if (!bytes || bytes.length < 4) return null;
  // RIFF....WAVE
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  ) {
    return { extension: 'wav', mimeType: 'audio/wav' };
  }
  // ISO BMFF / MP4 / M4A (....ftyp)
  if (
    bytes.length >= 8 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    return { extension: 'm4a', mimeType: 'audio/mp4' };
  }
  // FLAC (fLaC)
  if (
    bytes[0] === 0x66 &&
    bytes[1] === 0x4c &&
    bytes[2] === 0x61 &&
    bytes[3] === 0x43
  ) {
    return { extension: 'flac', mimeType: 'audio/flac' };
  }
  // Ogg (OggS)
  if (
    bytes[0] === 0x4f &&
    bytes[1] === 0x67 &&
    bytes[2] === 0x67 &&
    bytes[3] === 0x53
  ) {
    return { extension: 'ogg', mimeType: 'audio/ogg' };
  }
  // EBML / WebM
  if (
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return { extension: 'webm', mimeType: 'audio/webm' };
  }
  // ID3-tagged MP3
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return { extension: 'mp3', mimeType: 'audio/mpeg' };
  }
  return null;
}

/**
 * Detects canonical audio extension & MIME type using container magic bytes,
 * file extension, and declared MIME type while rejecting known non-audio payloads.
 */
export function detectImportedAudioFormat(
  fileName: string,
  rawMimeType?: string,
  headerBytes?: Uint8Array,
): DetectedAudioFormat | null {
  if (hasKnownNonAudioMagic(headerBytes)) {
    return null;
  }

  const byMagic = sniffAudioMagic(headerBytes);
  if (byMagic) {
    return byMagic;
  }

  const baseMime = (rawMimeType || '').split(';')[0].trim().toLowerCase();
  if (
    baseMime &&
    baseMime !== 'application/octet-stream' &&
    !baseMime.startsWith('audio/') &&
    baseMime !== 'video/mp4' &&
    baseMime !== 'video/webm'
  ) {
    return null;
  }

  const lastDot = fileName.lastIndexOf('.');
  if (lastDot > 0 && lastDot < fileName.length - 1) {
    const ext = fileName.slice(lastDot + 1).trim().toLowerCase();
    const byExt = EXTENSION_FORMAT_MAP[ext];
    if (byExt) return byExt;
  }

  if (baseMime && baseMime in MIME_FORMAT_MAP) {
    return MIME_FORMAT_MAP[baseMime];
  }

  return null;
}

/**
 * Derives a clean chapter title from an uploaded filename by removing directory
 * prefixes, extension, optional leading track prefixes (`01 - `, `01_`, `1. `),
 * and underscores.
 */
export function deriveChapterNameFromFileName(
  fileName: string,
  fallbackIndex = 0,
): string {
  const baseName = fileName.split(/[/\\]/).pop() ?? fileName;
  const withoutExt = baseName.replace(/\.[^./\\]+$/, '');
  const normalizedSpaces = withoutExt
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Strip common leading track numbers (e.g. "01 - Intro", "02. Next", "03_Chapter")
  // only when non-empty text remains afterwards.
  const withoutTrackPrefix = normalizedSpaces.replace(
    /^\d{1,3}\s*(?:[-–—.]\s*|\s+)(?=\S)/,
    '',
  );

  const candidate = (withoutTrackPrefix || normalizedSpaces)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

  return candidate || `Chapter ${fallbackIndex + 1}`;
}

/**
 * Sorts a batch of files naturally by filename (`Chapter 2.mp3` before `Chapter 10.mp3`).
 */
export function naturalSortFiles(files: readonly File[]): File[] {
  return files.slice().sort((a, b) =>
    a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: 'base',
    }),
  );
}

/**
 * Parses a RIFF/WAVE header in O(1) without allocating PCM Float32 buffers.
 */
export function parseWavHeader(
  buffer: ArrayBuffer,
  totalFileBytes = buffer.byteLength,
): WavHeaderInfo | null {
  if (!isWavBuffer(buffer) || buffer.byteLength < 44) return null;
  const view = new DataView(buffer);

  let formatTag = 0;
  let rawChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataSize = 0;
  let foundFmt = false;
  let foundData = false;

  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const chunkId = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataStart = offset + 8;

    if (chunkId === 'fmt ' && chunkDataStart + 16 <= buffer.byteLength) {
      formatTag = view.getUint16(chunkDataStart, true);
      rawChannels = view.getUint16(chunkDataStart + 2, true);
      sampleRate = view.getUint32(chunkDataStart + 4, true);
      bitsPerSample = view.getUint16(chunkDataStart + 14, true);
      foundFmt = true;
    } else if (chunkId === 'data') {
      const availableBytes = Math.max(0, totalFileBytes - chunkDataStart);
      dataSize = chunkSize > 0 ? Math.min(chunkSize, availableBytes) : availableBytes;
      foundData = true;
      break;
    }

    const advance = 8 + chunkSize + (chunkSize % 2);
    if (advance <= 8) break;
    offset += advance;
  }

  if (!foundFmt || !foundData) return null;
  if (formatTag !== 1 && formatTag !== 3 && formatTag !== 0xfffe) return null;
  if (rawChannels < 1 || sampleRate < 1000 || bitsPerSample < 8 || dataSize <= 0) {
    return null;
  }

  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = rawChannels * bytesPerSample;
  if (!Number.isFinite(blockAlign) || blockAlign <= 0) return null;

  const totalFrames = Math.floor(dataSize / blockAlign);
  if (totalFrames <= 0) return null;

  const durationMs = Math.max(1, Math.round((totalFrames / sampleRate) * 1000));
  const channels: ChannelCountOption = rawChannels >= 2 ? 2 : 1;

  return {
    sampleRate,
    channels,
    bitDepth: bitsPerSample,
    durationMs,
    totalFrames,
  };
}

/**
 * Computes compact normalized overview peaks (`0..1`) from planar Float32 channels
 * for the Audiobook Player waveform scrubber.
 */
export function computeOverviewPeaksFromChannels(
  channels: readonly Float32Array[],
  targetBars = 120,
): number[] {
  const totalFrames = channels[0]?.length ?? 0;
  if (totalFrames === 0 || targetBars <= 0) return [];

  const barCount = Math.min(targetBars, totalFrames);
  const step = totalFrames / barCount;
  const peaks = new Array<number>(barCount);

  for (let i = 0; i < barCount; i += 1) {
    const start = Math.floor(i * step);
    const end = Math.max(start + 1, Math.floor((i + 1) * step));
    // Stride inside very large buckets so long chapters stay fast (<2ms)
    const span = end - start;
    const stride = span > 2048 ? Math.floor(span / 1024) : 1;
    let maxAbs = 0;
    for (let ch = 0; ch < channels.length; ch += 1) {
      const data = channels[ch];
      for (let j = start; j < end && j < data.length; j += stride) {
        const v = Math.abs(data[j]);
        if (v > maxAbs) maxAbs = v;
      }
    }
    peaks[i] = Math.min(1, Math.max(0, Number(maxAbs.toFixed(3))));
  }

  return peaks;
}

/**
 * Probes an audio Blob's duration via an offscreen `<audio preload="metadata">` element.
 * Used as a memory-safe fallback for large compressed audio files (>25 MB) or codecs
 * supported by `<audio>` when Web Audio decoding is unavailable.
 */
export function probeAudioDurationWithElement(blob: Blob): Promise<number> {
  return new Promise((resolve, reject) => {
    if (
      typeof document === 'undefined' ||
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function'
    ) {
      reject(new Error('HTML audio metadata probe unavailable.'));
      return;
    }

    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    const objectUrl = URL.createObjectURL(blob);
    let settled = false;

    const cleanup = () => {
      window.clearTimeout(timer);
      audio.removeEventListener('loadedmetadata', onLoaded);
      audio.removeEventListener('durationchange', onLoaded);
      audio.removeEventListener('error', onError);
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(objectUrl);
    };

    const finishOk = (seconds: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(seconds);
    };

    const finishErr = (msg: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(msg));
    };

    const onLoaded = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        finishOk(audio.duration);
      }
    };

    const onError = () => {
      finishErr('Unable to read audio metadata.');
    };

    const timer = window.setTimeout(() => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        finishOk(audio.duration);
      } else {
        finishErr('Timed out while reading audio metadata.');
      }
    }, 10_000);

    audio.addEventListener('loadedmetadata', onLoaded);
    audio.addEventListener('durationchange', onLoaded);
    audio.addEventListener('error', onError);
    audio.src = objectUrl;
  });
}

async function decodeCompressedAudio(
  buffer: ArrayBuffer,
): Promise<{
  durationMs: number;
  sampleRate: number;
  channels: ChannelCountOption;
  peaks: number[];
} | null> {
  const AudioCtx =
    typeof window !== 'undefined'
      ? window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext
      : undefined;

  if (!AudioCtx) return null;

  const ctx = new AudioCtx();
  try {
    const decodeTarget = isMp4Buffer(buffer)
      ? repairDoubleWrappedEsdsMp4(buffer).buffer
      : buffer;
    const decoded = await ctx.decodeAudioData(decodeTarget.slice(0));
    if (!Number.isFinite(decoded.duration) || decoded.duration <= 0) {
      return null;
    }
    const planar: Float32Array[] = [];
    for (let ch = 0; ch < decoded.numberOfChannels; ch += 1) {
      planar.push(decoded.getChannelData(ch));
    }
    return {
      durationMs: Math.max(1, Math.round(decoded.duration * 1000)),
      sampleRate: decoded.sampleRate,
      channels: decoded.numberOfChannels >= 2 ? 2 : 1,
      peaks: computeOverviewPeaksFromChannels(planar, 120),
    };
  } catch {
    return null;
  } finally {
    await ctx.close().catch(() => {});
  }
}

/**
 * Inspects a user-selected audio `File`, validates format & readability,
 * extracts metadata (duration, sample rate, channels, bitrate/bit depth, overview peaks),
 * and returns a MIME-normalized `Blob` preserving the original audio bytes verbatim.
 */
export async function inspectImportedAudioFile(
  file: File,
  options: InspectImportedAudioOptions = {},
): Promise<ImportedAudioAnalysis> {
  if (!file || file.size === 0) {
    throw new Error('File is empty.');
  }
  if (file.size > MAX_IMPORT_AUDIO_FILE_BYTES) {
    throw new Error('File exceeds the 500 MB import limit.');
  }

  const headSlice = file.slice(0, 64);
  const headBuffer = await blobToArrayBuffer(headSlice);
  const headerBytes = new Uint8Array(headBuffer);

  const detected = detectImportedAudioFormat(file.name, file.type, headerBytes);
  if (!detected) {
    throw new Error(
      'Unsupported file type. Choose an MP3, M4A, WAV, WebM, OGG, FLAC, or AAC audio file.',
    );
  }

  const normalizedBlob = new Blob([file], { type: detected.mimeType });
  const suggestedName = deriveChapterNameFromFileName(
    file.name,
    options.fallbackIndex ?? 0,
  );

  // Fast path: WAV files parsed directly in pure TypeScript (no browser codec limits)
  if (detected.extension === 'wav') {
    const decodePeaks = file.size <= MAX_WAV_PEAK_DECODE_BYTES;
    const wavBuffer = await blobToArrayBuffer(
      decodePeaks ? file : file.slice(0, 65536),
    );
    const header = parseWavHeader(wavBuffer, file.size);
    if (!header) {
      throw new Error('Invalid or corrupted WAV audio file.');
    }

    let peaks: number[] = [];
    if (decodePeaks) {
      try {
        const decoded = decodeWav(wavBuffer);
        peaks = computeOverviewPeaksFromChannels(decoded.channels, 120);
      } catch {
        // Header was valid (e.g. exotic WAV subformat); keep empty overview peaks
      }
    }

    return {
      file,
      blob: normalizedBlob,
      originalFileName: file.name,
      suggestedName,
      extension: 'wav',
      mimeType: detected.mimeType,
      durationMs: header.durationMs,
      sampleRate: header.sampleRate,
      channels: header.channels,
      bitDepth: header.bitDepth,
      fileSizeBytes: file.size,
      peaks,
    };
  }

  // Compressed formats: prefer Web Audio decode for <= 25 MB (exact duration, sampleRate, channels, peaks)
  let durationMs = 0;
  let sampleRate = 0;
  let channels: ChannelCountOption = 1;
  let peaks: number[] = [];

  if (file.size <= MAX_DECODE_AUDIO_DATA_BYTES) {
    const buffer = await blobToArrayBuffer(file);
    const decoded = await decodeCompressedAudio(buffer);
    if (decoded) {
      durationMs = decoded.durationMs;
      sampleRate = decoded.sampleRate;
      channels = decoded.channels;
      peaks = decoded.peaks;
    }
  }

  // Fallback for large files (>25 MB) or when Web Audio decode isn't available
  if (durationMs <= 0) {
    const probe = options.probeHtmlAudio ?? probeAudioDurationWithElement;
    try {
      const durationSec = await probe(normalizedBlob);
      if (Number.isFinite(durationSec) && durationSec > 0) {
        durationMs = Math.max(1, Math.round(durationSec * 1000));
      }
    } catch {
      // Handled below
    }
  }

  if (durationMs <= 0) {
    throw new Error(
      'Could not read audio file — it may be corrupted or unsupported by this browser.',
    );
  }

  const bitrateKbps = Math.max(
    8,
    Math.round((file.size * 8) / (durationMs / 1000) / 1000),
  );

  return {
    file,
    blob: normalizedBlob,
    originalFileName: file.name,
    suggestedName,
    extension: detected.extension,
    mimeType: detected.mimeType,
    durationMs,
    sampleRate,
    channels,
    bitrateKbps,
    fileSizeBytes: file.size,
    peaks,
  };
}
