export type ConcreteThemeId =
  | 'pitch-oled'
  | 'braun-light'
  | 'eink-mono'
  | 'gruvbox-dark'
  | 'nord'
  | 'tokyo-night'
  | 'kanagawa'
  | 'everforest-dark'
  | 'rose-pine'
  | 'solarized-light';

export type ThemePreference = ConcreteThemeId | 'system';

export type ThemeConceptGroup = 'minimal' | 'ide-dark' | 'ide-light';

export const DEFAULT_THEME_ID: ConcreteThemeId = 'pitch-oled';
export const DEFAULT_LIGHT_THEME_ID: ConcreteThemeId = 'braun-light';

export interface ThemeDefinition {
  id: ConcreteThemeId;
  label: string;
  tagline: string;
  concept: ThemeConceptGroup;
  colorScheme: 'dark' | 'light';
  metaThemeColor: string;
  /** Preview swatches shown in picker: [canvas, surface, accent, record] */
  swatches: [string, string, string, string];
}

export const THEME_CONCEPT_LABELS: Record<ThemeConceptGroup, string> = {
  minimal: 'Ultra-Dark & Hardware Minimalist',
  'ide-dark': 'Developer IDE · Dark',
  'ide-light': 'Developer IDE · Light',
};

export const THEME_DEFINITIONS: ThemeDefinition[] = [
  // Ultra-Dark & Hardware Minimalist
  {
    id: 'pitch-oled',
    label: 'Pitch OLED',
    tagline: 'Pure #000 black · Leica signal red',
    concept: 'minimal',
    colorScheme: 'dark',
    metaThemeColor: '#000000',
    swatches: ['#000000', '#121212', '#F4F4F5', '#FF3B30'],
  },
  {
    id: 'braun-light',
    label: 'Braun / Rams',
    tagline: 'Anodized studio gray · Signal orange',
    concept: 'minimal',
    colorScheme: 'light',
    metaThemeColor: '#ECECE8',
    swatches: ['#ECECE8', '#F7F7F4', '#1A1A18', '#E8541E'],
  },
  {
    id: 'eink-mono',
    label: 'E-Ink Paper',
    tagline: 'Swiss monochrome print · Solitary red',
    concept: 'minimal',
    colorScheme: 'light',
    metaThemeColor: '#F4F3EF',
    swatches: ['#F4F3EF', '#FAF9F6', '#111110', '#C62828'],
  },

  // Developer IDE Dark Themes
  {
    id: 'gruvbox-dark',
    label: 'Gruvbox Hard',
    tagline: 'Retro analog dark IDE · Ochre & olive',
    concept: 'ide-dark',
    colorScheme: 'dark',
    metaThemeColor: '#1D2021',
    swatches: ['#1D2021', '#282828', '#FABD2F', '#FB4934'],
  },
  {
    id: 'nord',
    label: 'Nord Polar',
    tagline: 'Arctic matte slate · Frost cyan',
    concept: 'ide-dark',
    colorScheme: 'dark',
    metaThemeColor: '#242933',
    swatches: ['#242933', '#2E3440', '#88C0D0', '#BF616A'],
  },
  {
    id: 'tokyo-night',
    label: 'Tokyo Night',
    tagline: 'Crisp midnight IDE · Cobalt & coral',
    concept: 'ide-dark',
    colorScheme: 'dark',
    metaThemeColor: '#16161E',
    swatches: ['#16161E', '#1A1B26', '#7AA2F7', '#F7768E'],
  },
  {
    id: 'kanagawa',
    label: 'Kanagawa Ink',
    tagline: 'Sumi-ink woodblock · Carp gold',
    concept: 'ide-dark',
    colorScheme: 'dark',
    metaThemeColor: '#16161D',
    swatches: ['#16161D', '#1F1F28', '#E6C384', '#C34043'],
  },
  {
    id: 'everforest-dark',
    label: 'Everforest',
    tagline: 'Low-fatigue mossy dark · Birch & sage',
    concept: 'ide-dark',
    colorScheme: 'dark',
    metaThemeColor: '#232A2E',
    swatches: ['#232A2E', '#2D353B', '#DBBC7F', '#E67E80'],
  },
  {
    id: 'rose-pine',
    label: 'Rosé Pine',
    tagline: 'Matte twilight velvet · Rose & gold',
    concept: 'ide-dark',
    colorScheme: 'dark',
    metaThemeColor: '#191724',
    swatches: ['#191724', '#1F1D2E', '#F6C177', '#EB6F92'],
  },

  // Developer IDE Light Theme
  {
    id: 'solarized-light',
    label: 'Solarized Light',
    tagline: 'CIELAB parchment IDE · Solarized blue',
    concept: 'ide-light',
    colorScheme: 'light',
    metaThemeColor: '#EEE8D5',
    swatches: ['#EEE8D5', '#FDF6E3', '#268BD2', '#DC322F'],
  },
];

const THEME_BY_ID = new Map<string, ThemeDefinition>(
  THEME_DEFINITIONS.map((t) => [t.id, t]),
);

export function getThemeDefinition(id: ConcreteThemeId): ThemeDefinition {
  return THEME_BY_ID.get(id) ?? THEME_DEFINITIONS[0];
}

/**
 * Normalizes saved theme preferences, gracefully migrating removed legacy
 * `'dark'` (Warm Night) -> `'pitch-oled'` and `'light'` (Warm Paper) -> `'braun-light'`.
 */
export function normalizeThemePreference(value: unknown): ThemePreference {
  if (value === 'system') return 'system';
  if (value === 'dark') return DEFAULT_THEME_ID;
  if (value === 'light') return DEFAULT_LIGHT_THEME_ID;
  if (typeof value === 'string' && THEME_BY_ID.has(value)) {
    return value as ConcreteThemeId;
  }
  return DEFAULT_THEME_ID;
}
