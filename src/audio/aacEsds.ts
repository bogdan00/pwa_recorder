/**
 * ISO/IEC 14496-1 / 14496-3 / 14496-12 AAC AudioSpecificConfig & MP4 `esds` helpers.
 *
 * Works around WebKit Bug #302253 (shipped in iOS 26 / Safari 26 AudioEncoder):
 * Safari's WebCodecs `AudioEncoder` for `mp4a.40.2` emits a full 39-byte ESDS
 * descriptor payload (`0x03 0x80 0x80 0x80 ...`) in `meta.decoderConfig.description`
 * instead of the spec-mandated raw 2-byte ISO 14496-3 `AudioSpecificConfig`
 * (e.g. `[0x11, 0x88]` for 48 kHz mono AAC-LC). Passing that raw ESDS payload to
 * `mp4-muxer` wraps an `esds` inside another `esds`, which iOS AVFoundation then
 * rejects on playback with `NotSupportedError: The operation is not supported.`.
 *
 * This module both:
 * 1. Normalizes `AudioEncoder` `decoderConfig.description` at encode time so all
 *    newly recorded `.m4a` files contain a clean, spec-compliant `esds` box.
 * 2. Detects and repairs legacy double-wrapped `esds` `.m4a` files in-place at
 *    playback/decode time while preserving exact `moov` byte length (via a trailing
 *    `free` box) so `mdat` and `stco`/`co64` chunk offsets remain 100% intact.
 */

const MPEG4_SAMPLING_FREQUENCIES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
  8000, 7350,
] as const;

const TAG_ES_DESCR = 0x03;
const TAG_DECODER_CONFIG_DESCR = 0x04;
const TAG_DEC_SPECIFIC_INFO = 0x05;

function toUint8Array(source: AllowSharedBufferSource): Uint8Array {
  if (source instanceof Uint8Array) {
    return source;
  }
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  }
  return new Uint8Array(source);
}

/**
 * Builds a spec-compliant ISO/IEC 14496-3 `AudioSpecificConfig` for AAC-LC (objectType = 2).
 */
export function buildMpeg4AudioSpecificConfig(
  sampleRate: number,
  numChannels: number,
): Uint8Array {
  const objectType = 2; // AAC-LC
  const channelConfig = Math.max(1, Math.min(7, Math.round(numChannels)));
  const freqIndex = (MPEG4_SAMPLING_FREQUENCIES as readonly number[]).indexOf(
    Math.round(sampleRate),
  );

  if (freqIndex >= 0) {
    // 5 bits objectType | 4 bits freqIndex | 4 bits channelConfig | 3 bits GASpecificConfig (0)
    const byte0 = ((objectType & 0x1f) << 3) | ((freqIndex >> 1) & 0x07);
    const byte1 = ((freqIndex & 0x01) << 7) | ((channelConfig & 0x0f) << 3);
    return new Uint8Array([byte0, byte1]);
  }

  // Explicit 24-bit samplingFrequency (freqIndex = 15): 5 + 4 + 24 + 4 + 3 = 40 bits (5 bytes)
  const sr = Math.max(1, Math.round(sampleRate)) & 0xffffff;
  return new Uint8Array([
    ((objectType & 0x1f) << 3) | 0x07, // objectType(5) + top 3 bits of 0x0f (111)
    0x80 | ((sr >> 17) & 0x7f), // bottom bit of 0x0f (1) + top 7 bits of sr
    (sr >> 9) & 0xff,
    (sr >> 1) & 0xff,
    ((sr & 0x01) << 7) | ((channelConfig & 0x0f) << 3),
  ]);
}

interface ParsedDescriptor {
  tag: number;
  payloadStart: number;
  payloadEnd: number;
  nextOffset: number;
}

function readDescriptor(
  bytes: Uint8Array,
  offset: number,
  end: number,
): ParsedDescriptor | null {
  if (offset + 2 > end) return null;
  const tag = bytes[offset];
  let pos = offset + 1;
  let size = 0;
  let count = 0;
  let byte = 0;
  do {
    if (pos >= end || count >= 4) return null;
    byte = bytes[pos];
    pos += 1;
    count += 1;
    size = (size << 7) | (byte & 0x7f);
  } while ((byte & 0x80) !== 0);

  const payloadEnd = pos + size;
  if (payloadEnd > end) return null;

  return {
    tag,
    payloadStart: pos,
    payloadEnd,
    nextOffset: payloadEnd,
  };
}

/**
 * Parses ONE layer of an ISO 14496-1 ESDS payload (`ES_DescrTag 0x03` ->
 * `DecoderConfigDescrTag 0x04` -> `DecSpecificInfoTag 0x05`) and returns the
 * raw `DecSpecificInfo` bytes if valid, or `null` if `bytes` is not an ESDS payload.
 */
function parseSingleLayerDecSpecificInfo(bytes: Uint8Array): Uint8Array | null {
  let offset = 0;
  const end = bytes.byteLength;

  // Handle full `esds` box header (`[size(4), 'e','s','d','s', ver/flags(4)]`)
  if (
    end >= 16 &&
    bytes[4] === 0x65 && // 'e'
    bytes[5] === 0x73 && // 's'
    bytes[6] === 0x64 && // 'd'
    bytes[7] === 0x73 // 's'
  ) {
    offset = 12;
  } else if (
    // Handle fullbox version+flags prefix (`0, 0, 0, 0`) before ES_DescrTag
    end >= 12 &&
    bytes[0] === 0 &&
    bytes[1] === 0 &&
    bytes[2] === 0 &&
    bytes[3] === 0 &&
    bytes[4] === TAG_ES_DESCR
  ) {
    offset = 4;
  }

  if (offset >= end || bytes[offset] !== TAG_ES_DESCR) {
    return null;
  }

  const esDescr = readDescriptor(bytes, offset, end);
  if (!esDescr || esDescr.tag !== TAG_ES_DESCR) return null;

  // ES_Descriptor fixed header: 2B ES_ID + 1B flags
  let cursor = esDescr.payloadStart;
  if (cursor + 3 > esDescr.payloadEnd) return null;
  const flags = bytes[cursor + 2];
  cursor += 3;

  // Optional fields governed by flags
  if (flags & 0x80) cursor += 2; // streamDependenceFlag -> dependsOn_ES_ID
  if (flags & 0x40) {
    // URL_Flag -> 1B length + URLstring
    if (cursor >= esDescr.payloadEnd) return null;
    const urlLen = bytes[cursor];
    cursor += 1 + urlLen;
  }
  if (flags & 0x20) cursor += 2; // OCRstreamFlag -> OCR_ES_Id
  if (cursor > esDescr.payloadEnd) return null;

  // Walk child descriptors inside ES_Descriptor to find DecoderConfigDescriptor (0x04)
  while (cursor < esDescr.payloadEnd) {
    const child = readDescriptor(bytes, cursor, esDescr.payloadEnd);
    if (!child) return null;
    if (child.tag === TAG_DECODER_CONFIG_DESCR) {
      // DecoderConfigDescriptor fixed header:
      // 1B objectTypeIndication + 1B streamType + 3B bufferSizeDB + 4B maxBitrate + 4B avgBitrate = 13B
      let dcCursor = child.payloadStart + 13;
      if (dcCursor > child.payloadEnd) return null;
      while (dcCursor < child.payloadEnd) {
        const sub = readDescriptor(bytes, dcCursor, child.payloadEnd);
        if (!sub) return null;
        if (sub.tag === TAG_DEC_SPECIFIC_INFO) {
          if (sub.payloadEnd <= sub.payloadStart) return null;
          return bytes.slice(sub.payloadStart, sub.payloadEnd);
        }
        dcCursor = sub.nextOffset;
      }
      return null;
    }
    cursor = child.nextOffset;
  }

  return null;
}

/**
 * Unwraps an ESDS-wrapped descriptor (including nested double-wrapped ESDS payloads)
 * and returns the innermost raw `AudioSpecificConfig`, or `null` if `bytes` is not ESDS-wrapped.
 */
export function extractAudioSpecificConfigFromEsdsPayload(
  bytes: Uint8Array,
  maxDepth = 4,
): Uint8Array | null {
  let current = parseSingleLayerDecSpecificInfo(bytes);
  if (!current) return null;

  let depth = 1;
  while (depth < maxDepth) {
    const nested = parseSingleLayerDecSpecificInfo(current);
    if (!nested) break;
    current = nested;
    depth += 1;
  }

  return current;
}

/**
 * Normalizes a WebCodecs `AudioEncoder` AAC `meta.decoderConfig.description` into a
 * raw ISO/IEC 14496-3 `AudioSpecificConfig` suitable for `mp4-muxer`.
 *
 * - On Chromium (already raw 2-byte/5-byte `AudioSpecificConfig`): returned unchanged.
 * - On iOS 26 / Safari 26 (WebKit Bug #302253 full ESDS payload): unwraps to raw `AudioSpecificConfig`.
 * - If omitted/empty: synthesizes a spec-compliant AAC-LC `AudioSpecificConfig`.
 */
export function normalizeAacDecoderDescription(
  description: AllowSharedBufferSource | undefined,
  sampleRate: number,
  numChannels: number,
): Uint8Array {
  if (!description) {
    return buildMpeg4AudioSpecificConfig(sampleRate, numChannels);
  }
  const raw = toUint8Array(description);
  if (raw.byteLength === 0) {
    return buildMpeg4AudioSpecificConfig(sampleRate, numChannels);
  }

  const unwrapped = extractAudioSpecificConfigFromEsdsPayload(raw);
  if (unwrapped && unwrapped.byteLength > 0) {
    return unwrapped;
  }

  return raw.slice();
}

/**
 * Builds a spec-compliant ISO/IEC 14496-12 `esds` fullbox (version 0, flags 0)
 * wrapping the provided raw `AudioSpecificConfig` bytes.
 */
export function buildStandardEsdsBox(audioSpecificConfig: Uint8Array): Uint8Array {
  const len = audioSpecificConfig.byteLength;
  if (len === 0 || len > 95) {
    throw new RangeError(
      `Unsupported AudioSpecificConfig length (${len}) for single-byte descriptor size`,
    );
  }

  const totalSize = 49 + len;
  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);
  let pos = 0;

  // FullBox header: size(4) + 'esds'(4) + version/flags(4)
  view.setUint32(pos, totalSize, false);
  pos += 4;
  out[pos++] = 0x65; // 'e'
  out[pos++] = 0x73; // 's'
  out[pos++] = 0x64; // 'd'
  out[pos++] = 0x73; // 's'
  view.setUint32(pos, 0, false);
  pos += 4;

  // TAG(3) = ES_DescrTag
  view.setUint32(pos, 0x03808080, false);
  pos += 4;
  out[pos++] = 32 + len;
  view.setUint16(pos, 1, false); // ES_ID = 1
  pos += 2;
  out[pos++] = 0; // flags = 0

  // TAG(4) = DecoderConfigDescrTag
  view.setUint32(pos, 0x04808080, false);
  pos += 4;
  out[pos++] = 18 + len;
  out[pos++] = 0x40; // objectTypeIndication = MPEG-4 Audio
  out[pos++] = 0x15; // streamType(5=audio) << 2 | upstream(0) | reserved(1)
  out[pos++] = 0; // 24-bit bufferSizeDB
  out[pos++] = 0;
  out[pos++] = 0;
  view.setUint32(pos, 130071, false); // maxBitrate
  pos += 4;
  view.setUint32(pos, 130071, false); // avgBitrate
  pos += 4;

  // TAG(5) = DecSpecificInfoTag (AudioSpecificConfig)
  view.setUint32(pos, 0x05808080, false);
  pos += 4;
  out[pos++] = len;
  out.set(audioSpecificConfig, pos);
  pos += len;

  // TAG(6) = SLConfigDescrTag
  view.setUint32(pos, 0x06808080, false);
  pos += 4;
  out[pos++] = 1;
  out[pos++] = 2;

  return out;
}

interface Mp4Box {
  type: string;
  start: number;
  end: number;
  headerSize: number;
  size: number;
  isLargeSize: boolean;
}

function readAscii4(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function readBox(view: DataView, offset: number, parentEnd: number): Mp4Box | null {
  if (offset + 8 > parentEnd) return null;
  const size32 = view.getUint32(offset, false);
  const type = readAscii4(view, offset + 4);

  if (size32 === 1) {
    if (offset + 16 > parentEnd) return null;
    const hi = view.getUint32(offset + 8, false);
    const lo = view.getUint32(offset + 12, false);
    const size = hi * 0x100000000 + lo;
    if (size < 16 || offset + size > parentEnd) return null;
    return {
      type,
      start: offset,
      end: offset + size,
      headerSize: 16,
      size,
      isLargeSize: true,
    };
  }

  if (size32 === 0) {
    const size = parentEnd - offset;
    if (size < 8) return null;
    return {
      type,
      start: offset,
      end: parentEnd,
      headerSize: 8,
      size,
      isLargeSize: false,
    };
  }

  if (size32 < 8 || offset + size32 > parentEnd) return null;
  return {
    type,
    start: offset,
    end: offset + size32,
    headerSize: 8,
    size: size32,
    isLargeSize: false,
  };
}

function listChildBoxes(
  view: DataView,
  start: number,
  end: number,
): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  let cursor = start;
  while (cursor + 8 <= end) {
    const box = readBox(view, cursor, end);
    if (!box) break;
    boxes.push(box);
    if (box.end <= cursor) break;
    cursor = box.end;
  }
  return boxes;
}

function writeBoxSize(view: DataView, box: Mp4Box, newSize: number): void {
  if (box.isLargeSize) {
    const hi = Math.floor(newSize / 0x100000000);
    const lo = newSize >>> 0;
    view.setUint32(box.start + 8, hi, false);
    view.setUint32(box.start + 12, lo, false);
  } else {
    view.setUint32(box.start, newSize >>> 0, false);
  }
}

export function isMp4Buffer(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 12) return false;
  const view = new DataView(buffer);
  return readAscii4(view, 4) === 'ftyp';
}

export interface Mp4EsdsRepairResult {
  repaired: boolean;
  buffer: ArrayBuffer;
}

/**
 * Inspects an ISO-BMFF (`.m4a`/`.mp4`) buffer and repairs a double-wrapped `esds` box
 * caused by WebKit Bug #302253 (`mp4-muxer` wrapping Safari's 39-byte ESDS payload inside
 * a second `esds` box).
 *
 * Replaces `esds` in-place, shrinks its ancestor container sizes up through `trak`,
 * and appends an exact-delta `free` box at the end of `moov` so `moov`'s total byte length
 * and all `stco`/`co64` offsets into `mdat` remain 100% unchanged.
 *
 * Healthy `.m4a` files and non-MP4 buffers are returned untouched with `repaired: false`.
 */
export function repairDoubleWrappedEsdsMp4(
  buffer: ArrayBuffer,
): Mp4EsdsRepairResult {
  if (!isMp4Buffer(buffer)) {
    return { repaired: false, buffer };
  }

  const view = new DataView(buffer);
  const topBoxes = listChildBoxes(view, 0, buffer.byteLength);
  const moov = topBoxes.find((b) => b.type === 'moov');
  if (!moov) {
    return { repaired: false, buffer };
  }

  const moovChildren = listChildBoxes(view, moov.start + moov.headerSize, moov.end);
  for (const trak of moovChildren) {
    if (trak.type !== 'trak') continue;
    const mdia = listChildBoxes(view, trak.start + trak.headerSize, trak.end).find(
      (b) => b.type === 'mdia',
    );
    if (!mdia) continue;

    const minf = listChildBoxes(view, mdia.start + mdia.headerSize, mdia.end).find(
      (b) => b.type === 'minf',
    );
    if (!minf) continue;

    const stbl = listChildBoxes(view, minf.start + minf.headerSize, minf.end).find(
      (b) => b.type === 'stbl',
    );
    if (!stbl) continue;

    const stsd = listChildBoxes(view, stbl.start + stbl.headerSize, stbl.end).find(
      (b) => b.type === 'stsd',
    );
    if (!stsd || stsd.start + stsd.headerSize + 8 > stsd.end) continue;

    // `stsd` FullBox has 4B version/flags + 4B entry_count before child sample entries
    const sampleEntries = listChildBoxes(
      view,
      stsd.start + stsd.headerSize + 8,
      stsd.end,
    );
    const mp4a = sampleEntries.find((b) => b.type === 'mp4a');
    if (!mp4a || mp4a.start + mp4a.headerSize + 28 > mp4a.end) continue;

    // `mp4a` AudioSampleEntry has 28B fixed fields before child boxes (e.g. `esds`)
    const mp4aChildren = listChildBoxes(
      view,
      mp4a.start + mp4a.headerSize + 28,
      mp4a.end,
    );
    const esds = mp4aChildren.find((b) => b.type === 'esds');
    if (!esds || esds.start + esds.headerSize + 4 > esds.end) continue;

    // `esds` FullBox payload starts after 4B version/flags
    const esdsPayload = new Uint8Array(
      buffer,
      esds.start + esds.headerSize + 4,
      esds.end - (esds.start + esds.headerSize + 4),
    );
    const outerDecSpecific = parseSingleLayerDecSpecificInfo(esdsPayload);
    if (!outerDecSpecific) continue;

    // Only repair if the outer DecSpecificInfo ITSELF contains a nested ESDS descriptor!
    const innerAsc = extractAudioSpecificConfigFromEsdsPayload(outerDecSpecific);
    if (!innerAsc || innerAsc.byteLength === 0) {
      return { repaired: false, buffer };
    }

    const newEsdsBox = buildStandardEsdsBox(innerAsc);
    const delta = esds.size - newEsdsBox.byteLength;
    if (delta < 8) {
      // Need at least 8 bytes to append a valid `free` padding box at the end of `moov`
      return { repaired: false, buffer };
    }

    const src = new Uint8Array(buffer);
    const out = new Uint8Array(buffer.byteLength);

    // 1. Everything before the old `esds` box
    out.set(src.subarray(0, esds.start), 0);
    // 2. Clean single-wrapped `esds` box
    out.set(newEsdsBox, esds.start);
    // 3. Remaining bytes inside `moov` after `esds` (shifted left by `delta`)
    const afterEsdsDest = esds.start + newEsdsBox.byteLength;
    out.set(src.subarray(esds.end, moov.end), afterEsdsDest);
    // 4. Exact-delta `free` box at the end of `moov` so `moov` size & `mdat` offset stay identical
    const freeBoxStart = moov.end - delta;
    const outView = new DataView(out.buffer);
    outView.setUint32(freeBoxStart, delta, false);
    out[freeBoxStart + 4] = 0x66; // 'f'
    out[freeBoxStart + 5] = 0x72; // 'r'
    out[freeBoxStart + 6] = 0x65; // 'e'
    out[freeBoxStart + 7] = 0x65; // 'e'
    // 5. Everything after `moov` (e.g. `mdat`) at its exact original offset
    out.set(src.subarray(moov.end), moov.end);

    // Shrink sizes of ancestor boxes from `mp4a` up through `trak` by `delta` (`moov` stays unchanged)
    for (const ancestor of [trak, mdia, minf, stbl, stsd, mp4a]) {
      writeBoxSize(outView, ancestor, ancestor.size - delta);
    }

    return { repaired: true, buffer: out.buffer };
  }

  return { repaired: false, buffer };
}
