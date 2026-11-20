import type { WavBitDepthOption } from '../types/models';

function clampSample(v: number): number {
  if (v > 1) return 1;
  if (v < -1) return -1;
  return v;
}

function writeAscii(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i += 1) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Pure TypeScript RIFF/WAVE encoder supporting:
 * - 16-bit signed integer PCM (format tag 1)
 * - 24-bit signed integer PCM (format tag 1)
 * - 32-bit IEEE Float (format tag 3, mastering headroom)
 * Works for Mono (1 ch) and Stereo (2 ch).
 */
export function encodeWav(
  channelData: Float32Array[],
  sampleRate: number,
  bitDepth: WavBitDepthOption = 16,
): Blob {
  const numChannels = Math.max(1, channelData.length);
  const numFrames = channelData[0]?.length ?? 0;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numFrames * blockAlign;
  const formatTag = bitDepth === 32 ? 3 : 1; // 3 = IEEE_FLOAT, 1 = PCM

  const headerSize = 44;
  const buffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(buffer);

  // RIFF chunk descriptor
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');

  // fmt sub-chunk
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM / IEEE Float fmt chunk size
  view.setUint16(20, formatTag, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);

  // data sub-chunk
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = headerSize;

  if (bitDepth === 16) {
    for (let f = 0; f < numFrames; f += 1) {
      for (let ch = 0; ch < numChannels; ch += 1) {
        const s = clampSample(channelData[ch][f] || 0);
        const int16 = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
        view.setInt16(offset, int16, true);
        offset += 2;
      }
    }
  } else if (bitDepth === 24) {
    for (let f = 0; f < numFrames; f += 1) {
      for (let ch = 0; ch < numChannels; ch += 1) {
        const s = clampSample(channelData[ch][f] || 0);
        const int24 =
          s < 0 ? Math.round(s * 0x800000) : Math.round(s * 0x7fffff);
        view.setUint8(offset, int24 & 0xff);
        view.setUint8(offset + 1, (int24 >> 8) & 0xff);
        view.setUint8(offset + 2, (int24 >> 16) & 0xff);
        offset += 3;
      }
    }
  } else {
    // 32-bit IEEE Float preserves full float precision & headroom
    for (let f = 0; f < numFrames; f += 1) {
      for (let ch = 0; ch < numChannels; ch += 1) {
        view.setFloat32(offset, channelData[ch][f] || 0, true);
        offset += 4;
      }
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

export interface DecodedWavAudio {
  channels: Float32Array[];
  sampleRate: number;
  bitDepth: number;
  durationMs: number;
}

function readAscii(view: DataView, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += String.fromCharCode(view.getUint8(offset + i));
  }
  return out;
}

export function isWavBuffer(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 12) return false;
  const view = new DataView(buffer);
  return readAscii(view, 0, 4) === 'RIFF' && readAscii(view, 8, 4) === 'WAVE';
}

/**
 * Pure TypeScript RIFF/WAVE decoder supporting 16-bit PCM, 24-bit PCM,
 * and 32-bit IEEE Float (including WAVE_FORMAT_EXTENSIBLE) with zero
 * browser-decoder resampling or quantization loss.
 */
export function decodeWav(buffer: ArrayBuffer): DecodedWavAudio {
  if (!isWavBuffer(buffer)) {
    throw new Error('Invalid RIFF/WAVE header');
  }

  const view = new DataView(buffer);
  let offset = 12;
  let formatTag = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitDepth = 0;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buffer.byteLength) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkBody = offset + 8;

    if (chunkId === 'fmt ' && chunkSize >= 16 && chunkBody + 16 <= buffer.byteLength) {
      formatTag = view.getUint16(chunkBody, true);
      numChannels = view.getUint16(chunkBody + 2, true);
      sampleRate = view.getUint32(chunkBody + 4, true);
      bitDepth = view.getUint16(chunkBody + 14, true);
      if (formatTag === 0xfffe && chunkSize >= 40 && chunkBody + 26 <= buffer.byteLength) {
        // WAVE_FORMAT_EXTENSIBLE: first 2 bytes of SubFormat GUID carry actual tag (1=PCM, 3=Float)
        formatTag = view.getUint16(chunkBody + 24, true);
      }
    } else if (chunkId === 'data') {
      dataOffset = chunkBody;
      dataSize = Math.min(chunkSize, buffer.byteLength - chunkBody);
      break;
    }

    // RIFF chunks are word-aligned (pad byte when odd size)
    offset = chunkBody + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0 || numChannels < 1 || sampleRate < 1) {
    throw new Error('Incomplete WAV file: missing fmt or data chunk');
  }

  if (
    (formatTag !== 1 && formatTag !== 3) ||
    (bitDepth !== 16 && bitDepth !== 24 && bitDepth !== 32)
  ) {
    throw new Error(
      `Unsupported WAV format (tag=${formatTag}, bitDepth=${bitDepth})`,
    );
  }

  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const numFrames = Math.floor(dataSize / blockAlign);
  const channels = Array.from(
    { length: numChannels },
    () => new Float32Array(numFrames),
  );

  let pos = dataOffset;
  if (formatTag === 3 && bitDepth === 32) {
    for (let f = 0; f < numFrames; f += 1) {
      for (let ch = 0; ch < numChannels; ch += 1) {
        channels[ch][f] = view.getFloat32(pos, true);
        pos += 4;
      }
    }
  } else if (formatTag === 1 && bitDepth === 16) {
    for (let f = 0; f < numFrames; f += 1) {
      for (let ch = 0; ch < numChannels; ch += 1) {
        const v = view.getInt16(pos, true);
        channels[ch][f] = v < 0 ? v / 0x8000 : v / 0x7fff;
        pos += 2;
      }
    }
  } else if (formatTag === 1 && bitDepth === 24) {
    for (let f = 0; f < numFrames; f += 1) {
      for (let ch = 0; ch < numChannels; ch += 1) {
        const b0 = view.getUint8(pos);
        const b1 = view.getUint8(pos + 1);
        const b2 = view.getUint8(pos + 2);
        let int24 = b0 | (b1 << 8) | (b2 << 16);
        if (int24 & 0x800000) int24 |= ~0xffffff; // sign-extend 24-bit signed int
        channels[ch][f] = int24 < 0 ? int24 / 0x800000 : int24 / 0x7fffff;
        pos += 3;
      }
    }
  } else {
    // 32-bit signed integer PCM
    for (let f = 0; f < numFrames; f += 1) {
      for (let ch = 0; ch < numChannels; ch += 1) {
        const v = view.getInt32(pos, true);
        channels[ch][f] = v < 0 ? v / 0x80000000 : v / 0x7fffffff;
        pos += 4;
      }
    }
  }

  return {
    channels,
    sampleRate,
    bitDepth,
    durationMs: Math.round((numFrames / sampleRate) * 1000),
  };
}
