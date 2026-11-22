import React from 'react';
import { ChevronRight, Palette } from 'lucide-react';
import type { AppSettings } from '../../types/models';
import { getThemeDefinition } from '../../styles/themes';
import { resolveEffectiveTheme } from '../../storage/settings';
import { ToggleRow } from '../../components/ToggleRow';

export interface AppearanceDefaultsSectionProps {
  settings: AppSettings;
  onUpdateSettings: (next: AppSettings) => void;
  onOpenThemeSwitcher: () => void;
}

export const AppearanceDefaultsSection: React.FC<
  AppearanceDefaultsSectionProps
> = ({ settings, onUpdateSettings, onOpenThemeSwitcher }) => {
  const effectiveTheme = getThemeDefinition(
    resolveEffectiveTheme(settings.theme),
  );
  const themeDisplayName =
    settings.theme === 'system'
      ? `System · ${effectiveTheme.label}`
      : effectiveTheme.label;

  return (
    <section className="settings-section" aria-label="Appearance and Defaults">
      <div className="settings-section__head">
        <h3 className="settings-section__title">
          <Palette size={17} />
          Appearance &amp; Defaults
        </h3>
      </div>

      <div className="field">
        <span className="field-label">Color Theme</span>
        <button
          type="button"
          id="settings-open-theme-btn"
          className="settings-theme-row"
          data-testid="settings-theme-row"
          onClick={onOpenThemeSwitcher}
        >
          <div className="settings-theme-row__info">
            <span className="settings-theme-row__name">{themeDisplayName}</span>
            <span className="settings-theme-row__sub">
              {effectiveTheme.tagline}
            </span>
          </div>
          <div className="settings-theme-row__right">
            <span className="theme-card__swatches" aria-hidden="true">
              {effectiveTheme.swatches.map((hex, idx) => (
                <span
                  key={idx}
                  className="theme-card__dot"
                  style={{ backgroundColor: hex }}
                />
              ))}
            </span>
            <ChevronRight
              size={16}
              className="settings-theme-row__chevron"
              aria-hidden="true"
            />
          </div>
        </button>
      </div>

      <div className="field">
        <label htmlFor="default-narrator-input" className="field-label">
          Default Narrator Name
        </label>
        <input
          id="default-narrator-input"
          type="text"
          className="input"
          value={settings.defaultNarrator}
          onChange={(e) =>
            onUpdateSettings({
              ...settings,
              defaultNarrator: e.target.value,
            })
          }
          placeholder="e.g. Dad / Mom (credits your recordings)"
        />
      </div>

      <ToggleRow
        title="Keep Screen Awake While Recording"
        description="Prevents your phone from locking mid-chapter (Screen Wake Lock)"
        checked={settings.keepScreenAwake}
        onToggle={() =>
          onUpdateSettings({
            ...settings,
            keepScreenAwake: !settings.keepScreenAwake,
          })
        }
      />
    </section>
  );
};
