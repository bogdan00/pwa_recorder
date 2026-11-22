import type {
  AppSettings,
  AudioQualitySettings,
  ConcreteThemeId,
  ThemePreference,
} from '../types/models';
import {
  DEFAULT_LIGHT_THEME_ID,
  DEFAULT_THEME_ID,
  getThemeDefinition,
  normalizeThemePreference,
} from '../styles/themes';

const SETTINGS_STORAGE_KEY = 'storytape.settings.v1';

export const DEFAULT_AUDIO_QUALITY: AudioQualitySettings = {
  preset: 'standard',
  format: 'auto',
  sampleRate: 48000,
  bitrateKbps: 128,
  bitrateMode: 'variable',
  channels: 1,
  wavBitDepth: 24,
  inputGain: 1.0,
  highPassFilter: true,
  softLimiter: true,
  noiseSuppression: true,
  autoGainControl: true,
  echoCancellation: false,
};

const DEFAULT_GOOGLE_CLIENT_ID =
  '837184798626-09o51gg0dbun11u12dttckjdltfidj1v.apps.googleusercontent.com';

export function getDefaultSettings(): AppSettings {
  const envClientId =
    (typeof import.meta !== 'undefined' &&
      import.meta.env &&
      import.meta.env.VITE_GOOGLE_CLIENT_ID) ||
    DEFAULT_GOOGLE_CLIENT_ID;
  const envApiKey =
    (typeof import.meta !== 'undefined' &&
      import.meta.env &&
      import.meta.env.VITE_GOOGLE_API_KEY) ||
    '';

  return {
    googleClientId: envClientId.trim(),
    googleApiKey: envApiKey.trim(),
    driveRootFolderName: 'StoryTape Audiobooks',
    driveRootFolderId: undefined,
    driveLibraryMode: 'personal',
    driveSharedFolderName: undefined,
    driveAccessRole: 'owner',
    sharedBookFolders: [],
    defaultNarrator: '',
    theme: DEFAULT_THEME_ID,
    keepScreenAwake: true,
    backgroundRecordingKeepalive: false,
    keepLocalMaster: false,
    audioQuality: { ...DEFAULT_AUDIO_QUALITY },
    audioDevice: {
      deviceId: 'default',
      deviceLabel: 'System Default Microphone',
    },
  };
}

export function loadSettings(): AppSettings {
  const defaults = getDefaultSettings();
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ...defaults,
      ...parsed,
      theme: normalizeThemePreference(parsed.theme),
      backgroundRecordingKeepalive: Boolean(parsed.backgroundRecordingKeepalive),
      keepLocalMaster: Boolean(parsed.keepLocalMaster),
      googleClientId:
        parsed.googleClientId?.trim() || defaults.googleClientId,
      googleApiKey:
        parsed.googleApiKey?.trim() || defaults.googleApiKey || '',
      driveRootFolderName:
        parsed.driveRootFolderName?.trim() || defaults.driveRootFolderName,
      driveLibraryMode:
        parsed.driveLibraryMode === 'shared' ? 'shared' : 'personal',
      sharedBookFolders: Array.isArray(parsed.sharedBookFolders)
        ? parsed.sharedBookFolders
        : [],
      audioQuality: {
        ...defaults.audioQuality,
        ...(parsed.audioQuality ?? {}),
      },
      audioDevice: {
        ...defaults.audioDevice,
        ...(parsed.audioDevice ?? {}),
      },
    };
  } catch {
    return defaults;
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage quota errors in private browsing modes
  }
}

export function resolveEffectiveTheme(pref: ThemePreference): ConcreteThemeId {
  const normalized = normalizeThemePreference(pref);
  if (normalized !== 'system') {
    return normalized;
  }
  if (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: light)').matches
  ) {
    return DEFAULT_LIGHT_THEME_ID;
  }
  return DEFAULT_THEME_ID;
}

export function applyThemeToDocument(pref: ThemePreference): void {
  if (typeof document === 'undefined') return;
  const resolved = resolveEffectiveTheme(pref);
  const def = getThemeDefinition(resolved);
  document.documentElement.setAttribute('data-theme', resolved);
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) {
    metaTheme.setAttribute('content', def.metaThemeColor);
  }
}
