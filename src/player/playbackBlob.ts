import { isMp4Buffer, repairDoubleWrappedEsdsMp4 } from '../audio/aacEsds';
import { canPlayAudioContainer } from '../audio/qualityPresets';
import { decodeWav, encodeWav, isWavBuffer } from '../audio/wavEncoder';
import type { Recording } from '../types/models';
import { blobToArrayBuffer } from '../utils/blob';

type RecordingAudioMeta = Pick<Recording, 'mimeType' | 'extension'>;

const EXTENSION_MIME_MAP: Record<Recording['extension'], string> = {
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  webm: 'audio/webm;codecs=opus',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
};

const CANONICAL_MIME_ALIASES: Record<string, string> = {
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'video/mp4': 'audio/mp4',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/mp3': 'audio/mpeg',
  'audio/x-mpeg': 'audio/mpeg',
  'audio/x-flac': 'audio/flac',
  'audio/x-aac': 'audio/aac',
  'video/webm': 'audio/webm',
};

function isUsableAudioMime(mime?: string | null): mime is string {
  if (!mime) return false;
  const trimmed = mime.trim().toLowerCase();
  return trimmed.length > 0 && trimmed !== 'application/octet-stream';
}

function canonicalizeAudioMime(mime: string): string {
  const trimmed = mime.trim();
  const lower = trimmed.toLowerCase();
  return CANONICAL_MIME_ALIASES[lower] ?? trimmed;
}

/**
 * Resolves a concrete audio MIME type for a recording blob so extensionless `blob:` URLs
 * always declare a valid type on iOS Safari / AVFoundation.
 */
export function resolveRecordingMimeType(
  rec: RecordingAudioMeta,
  fallbackBlobType?: string,
): string {
  if (isUsableAudioMime(rec.mimeType)) {
    return canonicalizeAudioMime(rec.mimeType);
  }
  const byExt = EXTENSION_MIME_MAP[rec.extension];
  if (byExt) return byExt;
  if (isUsableAudioMime(fallbackBlobType)) {
    return canonicalizeAudioMime(fallbackBlobType);
  }
  return 'audio/mp4';
}

/**
 * Ensures an audio Blob carries an explicit audio MIME type rather than empty string
 * or `application/octet-stream` (which iOS Safari `<audio>` rejects with `NotSupportedError`).
 */
export function normalizeAudioBlobType(
  blob: Blob,
  rec: RecordingAudioMeta,
): Blob {
  const targetMime = resolveRecordingMimeType(rec, blob.type);
  const current = (blob.type || '').trim().toLowerCase();
  if (
    current === targetMime.toLowerCase() ||
    (isUsableAudioMime(current) && !(current in CANONICAL_MIME_ALIASES))
  ) {
    return blob;
  }
  return new Blob([blob], { type: targetMime });
}

export interface PreparedPlaybackBlob {
  blob: Blob;
  repaired: boolean;
}

/**
 * Prepares a stored or downloaded chapter blob for `<audio>` playback:
 * 1. Normalizes missing/generic MIME types (e.g. `application/octet-stream` from Drive).
 * 2. Proactively repairs legacy double-wrapped `esds` boxes in `.m4a` files recorded
 *    on iOS 26 Safari (WebKit Bug #302253) before the first `audio.play()` call.
 */
export async function preparePlayableAudioBlob(
  blob: Blob,
  rec: RecordingAudioMeta,
): Promise<PreparedPlaybackBlob> {
  const normalized = normalizeAudioBlobType(blob, rec);
  const mimeLower = (normalized.type || '').toLowerCase();
  const mightBeMp4 =
    rec.extension === 'm4a' ||
    mimeLower.includes('mp4') ||
    mimeLower.includes('m4a') ||
    mimeLower.includes('aac');

  if (!mightBeMp4 || normalized.size < 64) {
    return { blob: normalized, repaired: false };
  }

  try {
    const buffer = await blobToArrayBuffer(normalized);
    if (!isMp4Buffer(buffer)) {
      return { blob: normalized, repaired: false };
    }
    const { repaired, buffer: repairedBuffer } = repairDoubleWrappedEsdsMp4(buffer);
    if (!repaired) {
      return { blob: normalized, repaired: false };
    }
    return {
      blob: new Blob([repairedBuffer], { type: 'audio/mp4' }),
      repaired: true,
    };
  } catch {
    return { blob: normalized, repaired: false };
  }
}

function isFloatWavBuffer(buffer: ArrayBuffer): boolean {
  if (!isWavBuffer(buffer) || buffer.byteLength < 36) return false;
  const view = new DataView(buffer);
  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ' && offset + 10 <= buffer.byteLength) {
      const formatTag = view.getUint16(offset + 8, true);
      if (formatTag === 3) return true; // WAVE_FORMAT_IEEE_FLOAT
      if (formatTag === 0xfffe && offset + 34 <= buffer.byteLength) {
        // WAVE_FORMAT_EXTENSIBLE SubFormat first 2 bytes == 3 (IEEE_FLOAT)
        return view.getUint16(offset + 32, true) === 3;
      }
      return false;
    }
    offset += 8 + size + (size % 2);
  }
  return false;
}

/**
 * Converts a 32-bit IEEE Float WAV (`formatTag = 3`) in memory into a universally playable
 * 16-bit PCM WAV when a browser (e.g. iOS Safari `<audio>`) rejects IEEE Float WAV playback.
 */
export async function transcodeFloatWavForPlayback(
  blob: Blob,
): Promise<Blob | null> {
  try {
    const buffer = await blobToArrayBuffer(blob);
    if (!isFloatWavBuffer(buffer)) return null;
    const decoded = decodeWav(buffer);
    return encodeWav(decoded.channels, decoded.sampleRate, 16);
  } catch {
    return null;
  }
}

function extractErrorMeta(err: unknown): { name: string; message: string } | null {
  if (!err || typeof err !== 'object') return null;
  const candidate = err as { name?: unknown; message?: unknown };
  const name = typeof candidate.name === 'string' ? candidate.name : '';
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  if (!name && !message) return null;
  return { name, message };
}

export function isNotAllowedPlaybackError(err: unknown): boolean {
  const meta = extractErrorMeta(err);
  return meta?.name === 'NotAllowedError';
}

export function isAbortPlaybackError(err: unknown): boolean {
  const meta = extractErrorMeta(err);
  if (!meta) return false;
  return (
    meta.name === 'AbortError' ||
    /interrupted by a call to pause|interrupted by a new load request/i.test(
      meta.message,
    )
  );
}

export function isNotSupportedPlaybackError(err: unknown): boolean {
  const meta = extractErrorMeta(err);
  if (!meta) return false;
  return (
    meta.name === 'NotSupportedError' ||
    /operation is not supported|no supported source/i.test(meta.message)
  );
}

/**
 * Converts cryptic browser playback DOMExceptions (such as Safari's bare
 * `The operation is not supported.`) into clear, actionable guidance.
 */
export function formatPlaybackErrorMessage(
  err: unknown,
  rec: Pick<Recording, 'extension'>,
): string {
  if (isNotSupportedPlaybackError(err)) {
    if (rec.extension === 'webm' && !canPlayAudioContainer('webm')) {
      return 'This browser cannot play WEBM audio. Record in Auto (M4A) or WAV for iPhone playback.';
    }
    return `Unable to play this ${rec.extension.toUpperCase()} audio file in this browser.`;
  }
  const meta = extractErrorMeta(err);
  return meta?.message || 'Unable to play audio file.';
}
