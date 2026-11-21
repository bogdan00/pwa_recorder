export function formatDurationMs(
  ms: number,
  options: { showTenths?: boolean } = {},
): string {
  const safeMs = Math.max(0, Number.isFinite(ms) ? ms : 0);
  const totalSec = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const tenths = Math.floor((safeMs % 1000) / 100);

  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  const core = hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;

  return options.showTenths ? `${core}.${tenths}` : core;
}

export function formatDurationSec(seconds: number): string {
  return formatDurationMs(Math.max(0, seconds) * 1000);
}

export function formatHumanDuration(ms: number): string {
  const totalMin = Math.round(Math.max(0, ms) / 60000);
  if (totalMin < 1) {
    const sec = Math.max(1, Math.round(Math.max(0, ms) / 1000));
    return `${sec}s`;
  }
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours === 0) return `${mins} min`;
  if (mins === 0) return `${hours} hr`;
  return `${hours} hr ${mins} min`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let idx = 0;
  let value = bytes;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const precision = value >= 100 || idx === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[idx]}`;
}

export function formatSampleRate(hz: number): string {
  if (hz % 1000 === 0) return `${hz / 1000} kHz`;
  return `${(hz / 1000).toFixed(1)} kHz`;
}

export function formatGainDb(multiplier: number): string {
  if (multiplier <= 0) return '-∞ dB';
  const db = 20 * Math.log10(multiplier);
  const sign = db > 0.05 ? '+' : '';
  return `${sign}${db.toFixed(1)} dB`;
}

export function sanitizeFileName(name: string, fallback = 'Untitled'): string {
  const cleaned = name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 120);
  return cleaned || fallback;
}

export function buildChapterDriveFileName(
  orderIndex: number,
  recordingName: string,
  extension: string,
): string {
  const prefix = String(orderIndex + 1).padStart(2, '0');
  const safeName = sanitizeFileName(recordingName, `Chapter ${orderIndex + 1}`);
  return `${prefix} - ${safeName}.${extension}`;
}

export function createId(prefix = 'id'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function downsamplePeaks(peaks: number[], targetCount = 120): number[] {
  if (peaks.length <= targetCount) return peaks.slice();
  const result: number[] = new Array(targetCount);
  const step = peaks.length / targetCount;
  for (let i = 0; i < targetCount; i += 1) {
    const start = Math.floor(i * step);
    const end = Math.max(start + 1, Math.floor((i + 1) * step));
    let maxVal = 0;
    for (let j = start; j < end && j < peaks.length; j += 1) {
      if (peaks[j] > maxVal) maxVal = peaks[j];
    }
    result[i] = Math.min(1, Math.max(0, Number(maxVal.toFixed(3))));
  }
  return result;
}
