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
