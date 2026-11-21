import React from 'react';
import { Check, Download, HardDrive, Palette, Smartphone } from 'lucide-react';
import type { AppSettings } from '../../types/models';
import type { PwaInstallState } from '../../pwa/installPrompt';
import { useConfirm } from '../../components/ConfirmDialogContext';
import { ThemePickerGrid } from '../../components/ThemeSwitcherSheet';
import { ToggleRow } from '../../components/ToggleRow';
import { APP_VERSION } from '../../utils/appVersion';
import { formatBytes } from '../../utils/format';

export interface AppearanceStorageSectionProps {
  settings: AppSettings;
  pwaInstallState?: PwaInstallState;
  storageUsage: { usage: number; quota: number } | null;
  localMastersSummary: { count: number; totalBytes: number };
  onUpdateSettings: (next: AppSettings) => void;
  onInstallApp?: () => void;
  onClearSyncedCache: () => Promise<number>;
  onClearLocalMasters?: () => Promise<{ count: number; freedBytes: number }>;
  onLocalMastersCleared: () => void;
  onToast: (message: string) => void;
}

export const AppearanceStorageSection: React.FC<
  AppearanceStorageSectionProps
> = ({
  settings,
  pwaInstallState,
  storageUsage,
  localMastersSummary,
  onUpdateSettings,
  onInstallApp,
  onClearSyncedCache,
  onClearLocalMasters,
  onLocalMastersCleared,
  onToast,
}) => {
  const confirm = useConfirm();

  return (
    <section className="settings-section" aria-label="Appearance and Storage">
      <div className="settings-section__head">
        <h3 className="settings-section__title">
          <Palette size={17} />
          Appearance &amp; Defaults
        </h3>
      </div>

      <div className="field">
        <span className="field-label">Theme</span>
        <ThemePickerGrid
          currentTheme={settings.theme}
          onSelectTheme={(theme) => onUpdateSettings({ ...settings, theme })}
        />
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
          placeholder="e.g. Dad / Mom (auto-filled on new books)"
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

      {pwaInstallState &&
        (pwaInstallState.isInstalled ||
          pwaInstallState.canInstallFromSettings) && (
          <div
            className="settings-install-card"
            data-testid="settings-install-card"
          >
            <div className="settings-install-card__info">
              <span className="settings-install-card__title">
                <Smartphone size={15} />
                StoryTape App
              </span>
              <span className="settings-install-card__sub">
                {pwaInstallState.isInstalled
                  ? 'Running as an installed standalone app.'
                  : pwaInstallState.isIosManualInstall
                    ? 'Add to your iPhone or iPad Home Screen for full-screen offline use.'
                    : 'Install to your Home Screen for full-screen offline recording & playback.'}
              </span>
            </div>
            {pwaInstallState.isInstalled ? (
              <span className="settings-install-badge">
                <Check size={13} />
                Installed
              </span>
            ) : (
              onInstallApp && (
                <button
                  type="button"
                  className="btn btn-amber btn-sm"
                  id="settings-install-app-btn"
                  onClick={onInstallApp}
                >
                  <Download size={14} />
                  {pwaInstallState.isIosManualInstall
                    ? 'How to Install'
                    : 'Install App'}
                </button>
              )
            )}
          </div>
        )}

      {storageUsage && (
        <div className="field">
          <div className="gain-header">
            <span
              className="field-label"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <HardDrive size={14} />
              Local Offline Storage
            </span>
            <span
              className="font-mono"
              style={{ fontSize: 12, color: 'var(--ink-muted)' }}
            >
              {formatBytes(storageUsage.usage)}
              {storageUsage.quota > 0
                ? ` / ${formatBytes(storageUsage.quota)}`
                : ''}
            </span>
          </div>
          {storageUsage.quota > 0 && (
            <div className="storage-bar">
              <div
                className="storage-bar__fill"
                style={{
                  width: `${Math.min(100, Math.max(1, (storageUsage.usage / storageUsage.quota) * 100))}%`,
                }}
              />
            </div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() =>
                confirm({
                  title: 'Free Cached Audio?',
                  description:
                    'Remove local audio copies for chapters already backed up to Google Drive? They will re-download automatically when played while online. Unsynced recordings and local masters stay untouched.',
                  confirmLabel: 'Free Cached Audio',
                  tone: 'warning',
                  onConfirm: async () => {
                    const count = await onClearSyncedCache();
                    onToast(
                      count > 0
                        ? `Freed local audio cache for ${count} synced chapter${count === 1 ? '' : 's'}`
                        : 'No synced local audio cache to free',
                    );
                  },
                })
              }
            >
              Free Cached Audio for Synced Chapters
            </button>

            {onClearLocalMasters && localMastersSummary.count > 0 && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                data-testid="clear-local-masters-btn"
                onClick={() =>
                  confirm({
                    title: 'Delete All Local Masters?',
                    description: (
                      <>
                        Permanently delete{' '}
                        <strong>
                          {localMastersSummary.count} local lossless master
                          {localMastersSummary.count === 1 ? '' : 's'}
                        </strong>{' '}
                        ({formatBytes(localMastersSummary.totalBytes)}) from
                        this device? Your regular chapter recordings and Google
                        Drive backups will stay intact, but these uncompressed
                        32-bit masters cannot be recovered.
                      </>
                    ),
                    confirmLabel: 'Delete All Masters',
                    tone: 'danger',
                    onConfirm: async () => {
                      const res = await onClearLocalMasters();
                      onLocalMastersCleared();
                      onToast(
                        res.count > 0
                          ? `Deleted ${res.count} local master${res.count === 1 ? '' : 's'} (${formatBytes(res.freedBytes)} freed)`
                          : 'No local masters to delete',
                      );
                    },
                  })
                }
              >
                Delete Local Masters ({localMastersSummary.count} ·{' '}
                {formatBytes(localMastersSummary.totalBytes)})
              </button>
            )}
          </div>
        </div>
      )}

      <div className="settings-version-row">
        <span>App Version</span>
        <span
          className="font-mono settings-version-row__value"
          data-testid="app-version-value"
        >
          {APP_VERSION}
        </span>
      </div>
    </section>
  );
};
