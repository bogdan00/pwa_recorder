import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LIGHT_THEME_ID,
  DEFAULT_THEME_ID,
  getThemeDefinition,
  normalizeThemePreference,
  THEME_DEFINITIONS,
} from '../themes';
import {
  applyThemeToDocument,
  getDefaultSettings,
  loadSettings,
  resolveEffectiveTheme,
} from '../../storage/settings';

describe('StoryTape 10-theme registry & persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('ships exactly 10 curated themes defaulting to pitch-oled without Warm Night / Warm Paper', () => {
    expect(THEME_DEFINITIONS).toHaveLength(10);
    expect(DEFAULT_THEME_ID).toBe('pitch-oled');
    expect(getDefaultSettings().theme).toBe('pitch-oled');

    const ids = THEME_DEFINITIONS.map((t) => t.id);
    expect(ids).toContain('pitch-oled');
    expect(ids).toContain('braun-light');
    expect(ids).toContain('eink-mono');
    expect(ids).toContain('gruvbox-dark');
    expect(ids).toContain('nord');
    expect(ids).toContain('tokyo-night');
    expect(ids).toContain('kanagawa');
    expect(ids).toContain('everforest-dark');
    expect(ids).toContain('rose-pine');
    expect(ids).toContain('solarized-light');
    expect(ids).not.toContain('dark');
    expect(ids).not.toContain('light');
  });

  it('migrates legacy saved dark/light preferences gracefully to pitch-oled / braun-light', () => {
    expect(normalizeThemePreference('dark')).toBe('pitch-oled');
    expect(normalizeThemePreference('light')).toBe(DEFAULT_LIGHT_THEME_ID);
    expect(normalizeThemePreference('unknown-theme')).toBe('pitch-oled');
    expect(normalizeThemePreference('nord')).toBe('nord');
    expect(normalizeThemePreference('system')).toBe('system');

    localStorage.setItem(
      'storytape.settings.v1',
      JSON.stringify({ theme: 'dark' }),
    );
    expect(loadSettings().theme).toBe('pitch-oled');

    localStorage.setItem(
      'storytape.settings.v1',
      JSON.stringify({ theme: 'light' }),
    );
    expect(loadSettings().theme).toBe('braun-light');
  });

  it('applies data-theme and accurate meta theme-color for every theme', () => {
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      document.head.appendChild(meta);
    }

    for (const def of THEME_DEFINITIONS) {
      expect(resolveEffectiveTheme(def.id)).toBe(def.id);
      applyThemeToDocument(def.id);
      expect(document.documentElement.getAttribute('data-theme')).toBe(def.id);
      expect(meta.getAttribute('content')).toBe(def.metaThemeColor);
      expect(getThemeDefinition(def.id).label).toBe(def.label);
    }
  });
});
