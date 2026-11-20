import React from 'react';
import { Check, Palette, X } from 'lucide-react';
import {
  THEME_CONCEPT_LABELS,
  THEME_DEFINITIONS,
  type ThemeConceptGroup,
  type ThemePreference,
} from '../styles/themes';
import './ThemeSwitcherSheet.css';

const GROUP_ORDER: ThemeConceptGroup[] = ['minimal', 'ide-dark', 'ide-light'];

interface ThemePickerGridProps {
  currentTheme: ThemePreference;
  onSelectTheme: (theme: ThemePreference) => void;
}

export const ThemePickerGrid: React.FC<ThemePickerGridProps> = ({
  currentTheme,
  onSelectTheme,
}) => {
  return (
    <div className="theme-picker">
      <div className="theme-picker__system-row">
        <span className="theme-picker__hint">
          Tap any palette to preview live
        </span>
        <button
          type="button"
          className={`opt-pill ${currentTheme === 'system' ? 'opt-pill--active' : ''}`}
          onClick={() => onSelectTheme('system')}
        >
          System
        </button>
      </div>

      {GROUP_ORDER.map((group) => {
        const items = THEME_DEFINITIONS.filter((t) => t.concept === group);
        if (items.length === 0) return null;

        return (
          <div key={group} className="theme-group">
            <span className="theme-group__label">
              {THEME_CONCEPT_LABELS[group]}
            </span>
            <div
              className="theme-grid"
              role="radiogroup"
              aria-label={THEME_CONCEPT_LABELS[group]}
            >
              {items.map((t) => {
                const active = currentTheme === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`theme-card ${active ? 'theme-card--active' : ''}`}
                    data-theme-option={t.id}
                    onClick={() => onSelectTheme(t.id)}
                  >
                    <div className="theme-card__top">
                      <span className="theme-card__name">
                        {active && <Check size={13} aria-hidden="true" />}
                        {t.label}
                      </span>
                      <span className="theme-card__swatches" aria-hidden="true">
                        {t.swatches.map((hex, idx) => (
                          <span
                            key={idx}
                            className="theme-card__dot"
                            style={{ backgroundColor: hex }}
                          />
                        ))}
                      </span>
                    </div>
                    <span className="theme-card__sub">{t.tagline}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
};

interface ThemeSwitcherSheetProps {
  open: boolean;
  currentTheme: ThemePreference;
  onSelectTheme: (theme: ThemePreference) => void;
  onClose: () => void;
}

export const ThemeSwitcherSheet: React.FC<ThemeSwitcherSheetProps> = ({
  open,
  currentTheme,
  onSelectTheme,
  onClose,
}) => {
  if (!open) return null;

  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="theme-switcher-title"
      data-testid="theme-switcher-sheet"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet-panel">
        <div className="sheet-header">
          <h2 id="theme-switcher-title" className="sheet-title theme-sheet__title">
            <Palette size={18} aria-hidden="true" />
            Color Theme
          </h2>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close theme switcher"
          >
            <X size={20} />
          </button>
        </div>

        <div className="sheet-body">
          <ThemePickerGrid
            currentTheme={currentTheme}
            onSelectTheme={onSelectTheme}
          />
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
