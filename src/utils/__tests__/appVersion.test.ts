import { describe, expect, it } from 'vitest';
import {
  APP_VERSION,
  APP_VERSION_PATTERN,
  formatAppVersion,
} from '../appVersion';

describe('appVersion', () => {
  it('formats UTC dates as zero-padded YYYY_MM_DD_HH_MM', () => {
    const d1 = new Date(Date.UTC(2026, 0, 5, 7, 9, 42));
    expect(formatAppVersion(d1)).toBe('2026_01_05_07_09');

    const d2 = new Date(Date.UTC(2026, 10, 20, 15, 22, 0));
    expect(formatAppVersion(d2)).toBe('2026_11_20_15_22');
    expect(formatAppVersion(d2) > formatAppVersion(d1)).toBe(true);
  });

  it('exposes a valid build-injected APP_VERSION string', () => {
    expect(APP_VERSION).toMatch(APP_VERSION_PATTERN);
  });
});
