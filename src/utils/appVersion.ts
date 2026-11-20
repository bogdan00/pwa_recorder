/**
 * Formats a UTC Date as `YYYY_MM_DD_HH_MM` (strictly monotonic across deploys
 * regardless of runner/developer timezone or daylight saving time).
 */
export function formatAppVersion(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hour = pad(date.getUTCHours());
  const minute = pad(date.getUTCMinutes());
  return `${year}_${month}_${day}_${hour}_${minute}`;
}

export const APP_VERSION_PATTERN = /^\d{4}_\d{2}_\d{2}_\d{2}_\d{2}$/;

export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' && __APP_VERSION__.trim().length > 0
    ? __APP_VERSION__.trim()
    : formatAppVersion(new Date());
