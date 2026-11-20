import type {
  AppSettings,
  AudioQualitySettings,
  ThemePreference,
} from '../types/models';

const SETTINGS_STORAGE_KEY = 'storytape.settings.v1';

export const DEFAULT_AUDIO_QUALITY: AudioQualitySettings = {
  preset: 'standard',
  format: 'auto',
  sampleRate: 44100,
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
    theme: 'dark',
    keepScreenAwake: true,
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

export function resolveEffectiveTheme(pref: ThemePreference): 'dark' | 'light' {
  if (pref === 'dark' || pref === 'light') return pref;
  if (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: light)').matches
  ) {
    return 'light';
  }
  return 'dark';
}

export function applyThemeToDocument(pref: ThemePreference): void {
  if (typeof document === 'undefined') return;
  const resolved = resolveEffectiveTheme(pref);
  document.documentElement.setAttribute('data-theme', resolved);
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) {
    metaTheme.setAttribute(
      'content',
      resolved === 'dark' ? '#161311' : '#F8F3EC',
    );
  }
}
