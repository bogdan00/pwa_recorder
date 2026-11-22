import React, { useEffect, useState } from 'react';
import {
  BookOpen,
  CheckCircle2,
  Cloud,
  Copy,
  ExternalLink,
  FolderOpen,
  Headphones,
  KeyRound,
  Library,
  Link2,
  Loader2,
  Mic,
  RefreshCw,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import type { AppSettings } from '../types/models';
import type { JoinBookMode } from '../hooks/useDriveSync';
import { googleAuth } from '../drive/googleAuth';
import { pickSharedDriveFolder } from '../drive/googlePicker';
import {
  getDriveFolderWebUrl,
  type JoinShareInvite,
} from '../drive/shareUtils';
import './JoinShareModal.css';

export interface JoinShareModalProps {
  open: boolean;
  invite: JoinShareInvite | null;
  settings: AppSettings;
  isDriveConnected: boolean;
  isJoining: boolean;
  canImportToLibrary?: boolean;
  unsharedPersonalBooksCount?: number;
  onClose: () => void;
  onConnectDrive: () => void;
  onJoinFolder: (options: {
    folderId: string;
    name: string;
    scope: 'library' | 'book';
    role: 'writer' | 'reader';
    mode?: JoinBookMode;
    shareExistingBooks?: boolean;
  }) => Promise<{ ok: boolean; needsPicker?: boolean; error?: string }>;
  onToast: (message: string) => void;
}

export const JoinShareModal: React.FC<JoinShareModalProps> = ({
  open,
  invite,
  settings,
  isDriveConnected,
  isJoining,
  canImportToLibrary = true,
  unsharedPersonalBooksCount = 0,
  onClose,
  onConnectDrive,
  onJoinFolder,
  onToast,
}) => {
  const [needsPicker, setNeedsPicker] = useState(false);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [requestedAccess, setRequestedAccess] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joinMode, setJoinMode] = useState<JoinBookMode>('import');
  const [shareExistingBooks, setShareExistingBooks] = useState(true);

  const busy = isJoining || pickingFolder;

  useEffect(() => {
    if (!open || !invite) return;
    setNeedsPicker(false);
    setPickingFolder(false);
    setRequestedAccess(false);
    setJoinError(null);
    const defaultMode: JoinBookMode =
      invite.scope === 'book' && invite.role === 'reader' && canImportToLibrary
        ? 'import'
        : 'link';
    setJoinMode(defaultMode);
    setShareExistingBooks(true);
  }, [open, invite, canImportToLibrary]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, busy, onClose]);

  if (!open || !invite) return null;

  const isLibrary = invite.scope === 'library';
  const isCoNarrator = invite.role === 'writer';
  const showShareExistingPrompt =
    isLibrary && isCoNarrator && unsharedPersonalBooksCount > 0;
  const effectiveMode: JoinBookMode =
    !isLibrary && canImportToLibrary ? joinMode : 'link';
  const isImportMode = !isLibrary && effectiveMode === 'import';

  const roleDescription = isLibrary
    ? isCoNarrator
      ? 'Listen to every book in this family library and record new chapters together.'
      : 'Stream and download all audiobooks in this shared family library.'
    : isImportMode
      ? 'Saves a copy into your Google Drive library so it syncs across your devices and shared family library, and mirrors new chapters when you sync.'
      : isCoNarrator
        ? 'Links directly to this shared book on your shelf so you can listen and co-narrate chapters.'
        : 'Links directly to this shared book on your shelf for listening anytime without copying files.';

  const handleConfirmJoin = async () => {
    if (busy) return;
    setJoinError(null);
    try {
      const result = await onJoinFolder({
        folderId: invite.folderId,
        name: invite.name,
        scope: invite.scope,
        role: invite.role,
        mode: isLibrary ? undefined : effectiveMode,
        shareExistingBooks: showShareExistingPrompt
          ? shareExistingBooks
          : undefined,
      });
      if (result.ok) {
        setNeedsPicker(false);
        setJoinError(null);
      } else if (result.needsPicker) {
        setNeedsPicker(true);
        setJoinError(null);
      } else {
        setJoinError(
          result.error || 'Could not join this shared folder. Please try again.',
        );
      }
    } catch (err) {
      setJoinError(
        err instanceof Error ? err.message : 'Could not join this shared folder.',
      );
    }
  };

  const handleOpenPicker = async () => {
    if (busy) return;
    const token = googleAuth.getAccessToken();
    if (!token) {
      onToast('Reconnect Google Drive first to pick the shared folder');
      onConnectDrive();
      return;
    }

    setPickingFolder(true);
    setJoinError(null);
    try {
      const picked = await pickSharedDriveFolder({
        accessToken: token,
        apiKey: settings.googleApiKey,
        clientId: settings.googleClientId || invite.clientId,
        title: `Select "${invite.name}"`,
      });
      if (!picked) {
        onToast('Folder selection cancelled');
        return;
      }

      const result = await onJoinFolder({
        folderId: picked.folderId,
        name: picked.name,
        scope: invite.scope,
        role: invite.role,
        mode: isLibrary ? undefined : effectiveMode,
        shareExistingBooks: showShareExistingPrompt
          ? shareExistingBooks
          : undefined,
      });
      if (result.ok) {
        setNeedsPicker(false);
        setJoinError(null);
      } else {
        if (result.needsPicker) setNeedsPicker(true);
        setJoinError(
          result.error || 'Could not link the selected Google Drive folder.',
        );
      }
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Could not open Google Picker. Please try again.';
      setJoinError(msg);
      onToast(msg);
    } finally {
      setPickingFolder(false);
    }
  };

  return (
    <div
      className="sheet-backdrop modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="join-share-title"
      data-testid="join-share-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="sheet-panel modal-sheet join-share-modal">
        <div className="sheet-header">
          <div className="join-share-heading">
            <span className="join-share-heading__icon" aria-hidden="true">
              <Users size={18} />
            </span>
            <h2 id="join-share-title" className="sheet-title">
              {isLibrary ? 'Join Shared Audiobook Library' : 'Join Shared Book'}
            </h2>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            disabled={busy}
            aria-label="Close join dialog"
          >
            <X size={20} />
          </button>
        </div>

        <div className="sheet-body">
          {/* Invite summary */}
          <div className="join-invite-card">
            <div className="join-invite-card__badges">
              <span className="badge">
                {isLibrary ? <Library size={12} /> : <BookOpen size={12} />}
                {isLibrary ? 'Family Library' : 'Single Book'}
              </span>
              <span
                className={`badge ${
                  isCoNarrator ? 'badge-amber' : 'badge-sage'
                }`}
              >
                {isCoNarrator ? <Mic size={12} /> : <Headphones size={12} />}
                {isCoNarrator ? 'Co-Narrator' : 'Listener'}
              </span>
            </div>
            <h3 className="join-invite-card__name">{invite.name}</h3>
            <p className="join-invite-card__desc">{roleDescription}</p>
          </div>

          {/* Single-book mode choice: Import Copy (default for Listeners) vs Link Live */}
          {!isLibrary && canImportToLibrary && (
            <div
              className="join-mode-selector"
              role="radiogroup"
              aria-label="How to add this shared book"
              data-testid="join-book-mode-selector"
            >
              <button
                type="button"
                role="radio"
                id="join-mode-import"
                aria-checked={effectiveMode === 'import'}
                className={`join-mode-option ${
                  effectiveMode === 'import' ? 'join-mode-option--active' : ''
                }`}
                onClick={() => setJoinMode('import')}
                disabled={busy}
              >
                <span className="join-mode-option__head">
                  <Copy size={15} />
                  Import Copy to My Library
                </span>
                <span className="join-mode-option__sub">
                  Copies into your Drive library so family members sharing your
                  library see it automatically, and mirrors new chapters on sync.
                </span>
              </button>

              <button
                type="button"
                role="radio"
                id="join-mode-link"
                aria-checked={effectiveMode === 'link'}
                className={`join-mode-option ${
                  effectiveMode === 'link' ? 'join-mode-option--active' : ''
                }`}
                onClick={() => setJoinMode('link')}
                disabled={busy}
              >
                <span className="join-mode-option__head">
                  <Link2 size={15} />
                  {isCoNarrator ? 'Link Live (Co-Narrate)' : 'Link Live (No Copy)'}
                </span>
                <span className="join-mode-option__sub">
                  {isCoNarrator
                    ? 'Connects directly to the shared folder so you can record chapters together.'
                    : 'Connects directly to the shared folder on this device without copying files.'}
                </span>
              </button>
            </div>
          )}

          {/* Ask whether to also share existing personal books when joining a writable shared library */}
          {showShareExistingPrompt && (
            <label
              htmlFor="join-share-existing-books-toggle"
              className={`join-share-existing-card ${
                shareExistingBooks ? 'join-share-existing-card--checked' : ''
              }`}
              data-testid="join-share-existing-books-card"
            >
              <input
                id="join-share-existing-books-toggle"
                type="checkbox"
                className="join-share-existing-card__checkbox"
                checked={shareExistingBooks}
                onChange={(e) => setShareExistingBooks(e.target.checked)}
                disabled={busy}
              />
              <span className="join-share-existing-card__text">
                <span className="join-share-existing-card__title">
                  Also share my {unsharedPersonalBooksCount} existing{' '}
                  {unsharedPersonalBooksCount === 1 ? 'book' : 'books'} into{' '}
                  &ldquo;{invite.name}&rdquo;
                </span>
                <span className="join-share-existing-card__sub">
                  Copies your existing personal recordings into the shared
                  folder so family members can listen too. Your original
                  private copies stay untouched.
                </span>
              </span>
            </label>
          )}

          {/* Two-step progress indicator */}
          <div className="join-steps" aria-label="Join steps">
            <span
              className={`join-step-chip ${
                isDriveConnected
                  ? 'join-step-chip--done'
                  : 'join-step-chip--active'
              }`}
            >
              {isDriveConnected ? <CheckCircle2 size={14} /> : '1.'}
              Connect Drive
            </span>
            <span className="join-step-divider" aria-hidden="true" />
            <span
              className={`join-step-chip ${
                isDriveConnected ? 'join-step-chip--active' : ''
              }`}
            >
              {isImportMode ? '2. Import & Sync' : '2. Link & Sync'}
            </span>
          </div>

          {/* Step 1 — Connect Google Drive */}
          {!isDriveConnected ? (
            <div className="join-action-card">
              <h4 className="join-action-card__title">
                Step 1 — Connect Google Drive
              </h4>
              <p className="join-action-card__desc">
                Sign in with the Google account that received this invite so
                StoryTape can {isImportMode ? 'import' : 'sync'}{' '}
                {isLibrary ? 'the shared library' : `"${invite.name}"`}.
              </p>
              <div className="join-action-card__buttons">
                <button
                  type="button"
                  id="join-connect-drive-btn"
                  className="btn btn-primary"
                  onClick={onConnectDrive}
                  disabled={busy}
                >
                  <Cloud size={16} />
                  Connect Google Drive to Join
                </button>
              </div>
            </div>
          ) : (
            /* Step 2 — Import or Link Shared Folder */
            <div className="join-action-card">
              <h4 className="join-action-card__title">
                {isImportMode
                  ? 'Step 2 — Import Copy to Your Library'
                  : 'Step 2 — Link & Sync Shared Folder'}
              </h4>
              <p className="join-action-card__desc">
                {isImportMode ? (
                  <>
                    You&apos;re connected to Google Drive. Tap below to import a
                    synced copy of <strong>{invite.name}</strong> into your
                    library folder.
                  </>
                ) : (
                  <>
                    You&apos;re connected to Google Drive. Tap below to link{' '}
                    <strong>{invite.name}</strong> and sync its audiobooks to
                    this device.
                  </>
                )}
              </p>
              <div className="join-action-card__buttons">
                <button
                  type="button"
                  id="join-confirm-btn"
                  className="btn btn-primary"
                  onClick={() => void handleConfirmJoin()}
                  disabled={busy}
                >
                  {isJoining ? (
                    <>
                      <Loader2 size={16} className="spin" />
                      {isImportMode ? 'Importing copy…' : 'Joining & syncing…'}
                    </>
                  ) : isImportMode ? (
                    <>
                      <Copy size={16} />
                      Import to My Library
                    </>
                  ) : (
                    <>
                      <FolderOpen size={16} />
                      Join &amp; Sync Now
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Google Picker privacy fallback when drive.file scope needs folder selection */}
          {isDriveConnected && needsPicker && (
            <div className="join-picker-card" data-testid="join-picker-card">
              <div className="join-picker-card__head">
                <ShieldCheck size={17} />
                <span>One-Time Folder Selection Required</span>
              </div>
              <p className="join-picker-card__text">
                If the owner already shared this folder with you, select it once
                in Google Picker so StoryTape can access only this folder.
              </p>
              <div className="join-picker-card__actions">
                <button
                  type="button"
                  id="join-google-picker-btn"
                  className="btn btn-amber"
                  onClick={() => void handleOpenPicker()}
                  disabled={busy}
                >
                  {pickingFolder ? (
                    <>
                      <Loader2 size={16} className="spin" />
                      Opening Google Picker…
                    </>
                  ) : (
                    <>
                      <FolderOpen size={16} />
                      Pick Shared Folder in Google Drive
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Native Google Drive "Request access" handoff when recipient lacks Drive permission */}
          {isDriveConnected && (needsPicker || Boolean(joinError)) && (
            <div
              className="join-request-card"
              data-testid="join-request-access-card"
            >
              <div className="join-request-card__head">
                <KeyRound size={16} />
                <span>Don&apos;t Have Permission Yet?</span>
              </div>
              <p className="join-request-card__text">
                If you don&apos;t see <strong>{invite.name}</strong> in Google
                Picker, open the folder in Google Drive and tap{' '}
                <strong>Request access</strong>. Google will notify the owner to
                approve your account.
              </p>
              <div className="join-request-card__actions">
                <a
                  id="join-request-access-btn"
                  href={getDriveFolderWebUrl(invite.folderId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-secondary btn-sm join-external-link"
                  onClick={() => setRequestedAccess(true)}
                >
                  <ExternalLink size={15} />
                  Request Access in Google Drive
                </a>
                {requestedAccess && (
                  <button
                    type="button"
                    id="join-retry-after-request-btn"
                    className="btn btn-amber btn-sm"
                    onClick={() => void handleConfirmJoin()}
                    disabled={busy}
                  >
                    <RefreshCw size={14} className={isJoining ? 'spin' : ''} />
                    Check Access &amp; Retry
                  </button>
                )}
              </div>
              {requestedAccess && (
                <p className="join-request-card__hint">
                  Once the owner approves your Drive request (via email or in
                  their Share sheet), tap <strong>Check Access &amp; Retry</strong>{' '}
                  or pick the folder above.
                </p>
              )}
            </div>
          )}

          {joinError && (
            <div className="join-error-banner" role="alert">
              {joinError}
            </div>
          )}
        </div>

        <div className="sheet-footer">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};
