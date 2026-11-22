import React from 'react';
import { Check, Download, HardDrive, Smartphone } from 'lucide-react';
import type { PwaInstallState } from '../../pwa/installPrompt';
import { useConfirm } from '../../components/ConfirmDialogContext';
import { FieldHeaderWithHelp } from '../../components/InfoTip';
import { APP_VERSION } from '../../utils/appVersion';
import { formatBytes } from '../../utils/format';
import { SETTINGS_HELP } from './settingsHelpContent';

export interface StorageAppSectionProps {
  pwaInstallState?: PwaInstallState;
  storageUsage: { usage: number; quota: number } | null;
  localMastersSummary: { count: number; totalBytes: number };
  onInstallApp?: () => void;
  onClearSyncedCache: () => Promise<number>;
  onClearLocalMasters?: () => Promise<{ count: number; freedBytes: number }>;
  onLocalMastersCleared: () => void;
  onToast: (message: string) => void;
}

export const StorageAppSection: React.FC<StorageAppSectionProps> = ({
  pwaInstallState,
  storageUsage,
  localMastersSummary,
  onInstallApp,
  onClearSyncedCache,
  onClearLocalMasters,
  onLocalMastersCleared,
  onToast,
}) => {
  const confirm = useConfirm();

  return (
    <section className="settings-section" aria-label="Storage and App Info">
      <div className="settings-section__head">
        <h3 className="settings-section__title">
          <HardDrive size={17} />
          Storage &amp; App
        </h3>
      </div>

      <div className="storage-card" data-testid="settings-storage-card">
        <FieldHeaderWithHelp
          label="Local Offline Storage"
          help={SETTINGS_HELP['local-offline-storage']}
          right={
            storageUsage ? (
              <span
                className="font-mono"
                style={{ fontSize: 12, color: 'var(--ink-muted)' }}
              >
                {formatBytes(storageUsage.usage)}
                {storageUsage.quota > 0
                  ? ` / ${formatBytes(storageUsage.quota)}`
                  : ''}
              </span>
            ) : undefined
          }
        />

        {storageUsage && storageUsage.quota > 0 && (
          <div className="storage-bar">
            <div
              className="storage-bar__fill"
              style={{
                width: `${Math.min(100, Math.max(1, (storageUsage.usage / storageUsage.quota) * 100))}%`,
              }}
            />
          </div>
        )}

        <div className="storage-card__actions">
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
                      ({formatBytes(localMastersSummary.totalBytes)}) from this
                      device? Your regular chapter recordings and Google Drive
                      backups will stay intact, but these uncompressed 32-bit
                      masters cannot be recovered.
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
