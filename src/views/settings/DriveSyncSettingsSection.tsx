import React, { useState } from 'react';
import {
  Cloud,
  ExternalLink,
  FolderOpen,
  Link2,
  Loader2,
  RefreshCw,
  Share2,
  Users,
} from 'lucide-react';
import type { AppSettings } from '../../types/models';
import type { GoogleAuthState } from '../../drive/googleAuth';
import { getDriveFolderWebUrl } from '../../drive/shareUtils';
import { useConfirm } from '../../components/ConfirmDialogContext';
import { FieldHeaderWithHelp } from '../../components/InfoTip';
import { SETTINGS_HELP } from './settingsHelpContent';

export interface DriveSyncSettingsSectionProps {
  settings: AppSettings;
  authState: GoogleAuthState;
  isSyncing: boolean;
  syncStatusMessage: string | null;
  onUpdateSettings: (next: AppSettings) => void;
  onConnectDrive: () => void;
  onSignOutDrive: () => void;
  onSyncAll: () => void;
  onOpenShareLibrary: () => void;
  onJoinSharedFolder: (input: string) => Promise<void>;
  onPickSharedFolder: () => Promise<void>;
  onSwitchToPersonalLibrary: () => Promise<void>;
  onUnlinkSharedBook: (folderId: string) => void;
}

export const DriveSyncSettingsSection: React.FC<
  DriveSyncSettingsSectionProps
> = ({
  settings,
  authState,
  isSyncing,
  syncStatusMessage,
  onUpdateSettings,
  onConnectDrive,
  onSignOutDrive,
  onSyncAll,
  onOpenShareLibrary,
  onJoinSharedFolder,
  onPickSharedFolder,
  onSwitchToPersonalLibrary,
  onUnlinkSharedBook,
}) => {
  const confirm = useConfirm();
  const [joinInput, setJoinInput] = useState('');
  const [joiningFolder, setJoiningFolder] = useState(false);

  const requestSignOut = () =>
    confirm({
      title: 'Sign Out of Google Drive?',
      description:
        'Disconnect Google Drive sync on this device? Your local books and recordings stay safely stored on this device, and you can reconnect anytime.',
      confirmLabel: 'Sign Out',
      tone: 'warning',
      onConfirm: () => {
        onSignOutDrive();
      },
    });

  return (
    <>
      <section className="settings-section" aria-label="Google Drive Sync">
        <div className="settings-section__head">
          <h3 className="settings-section__title">
            <Cloud size={17} />
            Google Drive Folder
          </h3>
          <span
            className={`badge ${
              authState.status === 'connected'
                ? 'badge-sage'
                : authState.isRefreshing || authState.status === 'expired'
                  ? 'badge-amber'
                  : ''
            }`}
          >
            {authState.isRefreshing
              ? 'Refreshing…'
              : authState.status === 'connected'
                ? 'Connected'
                : authState.status === 'expired'
                  ? 'Reconnect Needed'
                  : authState.status === 'disconnected'
                    ? 'Disconnected'
                    : 'Not Configured'}
          </span>
        </div>

        {authState.userEmail && (
          <span className="field-hint">
            {authState.status === 'expired' ? (
              <>
                Linked to <strong>{authState.userEmail}</strong> · Tap Reconnect
                to refresh sync
              </>
            ) : authState.hasPersistentRefresh ? (
              <>
                Signed in as <strong>{authState.userEmail}</strong> · Stays
                signed in automatically
              </>
            ) : (
              <>
                Signed in as <strong>{authState.userEmail}</strong>
              </>
            )}
          </span>
        )}

        {authState.lastError && (
          <span className="badge badge-danger">{authState.lastError}</span>
        )}

        <div className="field">
          <FieldHeaderWithHelp
            label="Drive Root Folder Name"
            htmlFor="drive-root-folder-input"
            help={SETTINGS_HELP['drive-root-folder']}
          />
          <input
            id="drive-root-folder-input"
            type="text"
            className="input"
            value={settings.driveRootFolderName}
            onChange={(e) =>
              onUpdateSettings({
                ...settings,
                driveRootFolderName: e.target.value,
                driveRootFolderId: undefined,
              })
            }
            placeholder="StoryTape Audiobooks"
          />
          <span className="field-hint">
            Each book gets its own subfolder containing{' '}
            <code>project.json</code>, <code>cover.jpg</code>, and all chapter
            audio files.
          </span>
        </div>

        <div className="drive-actions-row">
          {authState.status === 'connected' ? (
            <>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={onSyncAll}
                disabled={isSyncing}
              >
                {isSyncing ? (
                  <Loader2 size={14} className="spin" />
                ) : (
                  <RefreshCw size={14} />
                )}
                {isSyncing ? 'Syncing…' : 'Sync All Now'}
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={onOpenShareLibrary}
                id="settings-share-library-btn"
              >
                <Share2 size={14} />
                Share Library
              </button>
              {settings.driveRootFolderId && (
                <a
                  href={getDriveFolderWebUrl(settings.driveRootFolderId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-ghost btn-sm"
                >
                  <ExternalLink size={14} />
                  Open Folder
                </a>
              )}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={requestSignOut}
                disabled={isSyncing}
              >
                Sign Out
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={onConnectDrive}
              >
                <Cloud size={15} />
                {authState.status === 'expired'
                  ? 'Reconnect Google Drive'
                  : 'Connect Google Drive'}
              </button>
              {authState.status === 'expired' && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={requestSignOut}
                  disabled={isSyncing}
                >
                  Sign Out
                </button>
              )}
            </>
          )}
        </div>

        {syncStatusMessage && (
          <span className="field-hint">{syncStatusMessage}</span>
        )}
      </section>

      {/* Family Sharing & Collaboration Controls */}
      <section
        className="settings-section"
        aria-label="Family and Collaborator Sharing"
        data-testid="settings-collab-box"
      >
        <div className="settings-section__head">
          <h3 className="settings-section__title">
            <Users size={17} />
            Family &amp; Collaborator Sharing
          </h3>
          <span
            className={`badge ${settings.driveLibraryMode === 'shared' ? 'badge-sage' : ''}`}
          >
            {settings.driveLibraryMode === 'shared'
              ? settings.driveAccessRole === 'reader'
                ? 'Shared · Listener'
                : 'Shared · Co-Narrator'
              : 'Personal Library'}
          </span>
        </div>

        {settings.driveLibraryMode === 'shared' && (
          <div className="collab-active-row">
            <span className="field-hint">
              Synced with shared folder{' '}
              <strong>
                {settings.driveSharedFolderName || 'Shared Audiobooks'}
              </strong>
              .
            </span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              id="switch-personal-library-btn"
              onClick={() =>
                confirm({
                  title: 'Switch to Personal Library?',
                  description: (
                    <>
                      Stop syncing with shared folder{' '}
                      <strong>
                        {settings.driveSharedFolderName || 'Shared Audiobooks'}
                      </strong>{' '}
                      and switch back to your personal Google Drive library?
                    </>
                  ),
                  confirmLabel: 'Switch Library',
                  tone: 'warning',
                  onConfirm: async () => {
                    await onSwitchToPersonalLibrary();
                  },
                })
              }
              disabled={isSyncing}
            >
              Switch to My Personal Library
            </button>
          </div>
        )}

        <div className="field">
          <label htmlFor="join-folder-input" className="field-label">
            Join a Shared Library or Book
          </label>
          <div className="collab-join-row">
            <input
              id="join-folder-input"
              type="text"
              className="input"
              value={joinInput}
              onChange={(e) => setJoinInput(e.target.value)}
              placeholder="Paste StoryTape invite link or Google Drive folder URL"
            />
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              id="settings-join-folder-btn"
              disabled={!joinInput.trim() || joiningFolder || isSyncing}
              onClick={async () => {
                setJoiningFolder(true);
                try {
                  await onJoinSharedFolder(joinInput);
                  setJoinInput('');
                } finally {
                  setJoiningFolder(false);
                }
              }}
            >
              <Link2 size={14} />
              {joiningFolder ? 'Joining…' : 'Join'}
            </button>
          </div>
        </div>

        {authState.status === 'connected' && (
          <div className="drive-actions-row">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              id="settings-google-picker-btn"
              onClick={() => void onPickSharedFolder()}
              disabled={isSyncing}
            >
              <FolderOpen size={14} />
              Browse Shared Folders (Google Picker)
            </button>
          </div>
        )}

        {(settings.sharedBookFolders?.length ?? 0) > 0 && (
          <div className="field">
            <span className="field-label">Linked Shared Books</span>
            <div className="shared-books-list">
              {settings.sharedBookFolders!.map((link) => (
                <div key={link.folderId} className="shared-book-row">
                  <div className="shared-book-row__info">
                    <span className="shared-book-row__title">{link.title}</span>
                    <span className="field-hint">
                      {link.role === 'reader' ? 'Listener' : 'Co-Narrator'}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() =>
                      confirm({
                        title: 'Unlink Shared Book?',
                        description: (
                          <>
                            Stop syncing <strong>{link.title}</strong> with this
                            device? This does not delete the book from Google
                            Drive.
                          </>
                        ),
                        confirmLabel: 'Unlink Book',
                        tone: 'warning',
                        onConfirm: () => {
                          onUnlinkSharedBook(link.folderId);
                        },
                      })
                    }
                  >
                    Unlink
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </>
  );
};
