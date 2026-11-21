import React, { useEffect, useState } from 'react';
import {
  BookOpen,
  CheckCircle2,
  Cloud,
  ExternalLink,
  FolderOpen,
  Headphones,
  KeyRound,
  Library,
  Loader2,
  Mic,
  RefreshCw,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import type { AppSettings } from '../types/models';
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
  onClose: () => void;
  onConnectDrive: () => void;
  onJoinFolder: (options: {
    folderId: string;
    name: string;
    scope: 'library' | 'book';
    role: 'writer' | 'reader';
  }) => Promise<{ ok: boolean; needsPicker?: boolean; error?: string }>;
  onToast: (message: string) => void;
}

export const JoinShareModal: React.FC<JoinShareModalProps> = ({
  open,
  invite,
  settings,
  isDriveConnected,
  isJoining,
  onClose,
  onConnectDrive,
  onJoinFolder,
  onToast,
}) => {
  const [needsPicker, setNeedsPicker] = useState(false);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [requestedAccess, setRequestedAccess] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  const busy = isJoining || pickingFolder;

  useEffect(() => {
    if (!open) return;
    setNeedsPicker(false);
    setPickingFolder(false);
    setRequestedAccess(false);
    setJoinError(null);
  }, [open, invite?.folderId, invite?.scope, invite?.role]);

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

  const roleDescription = isLibrary
    ? isCoNarrator
      ? 'Listen to every book in this family library and record new chapters together.'
      : 'Stream and download all audiobooks in this shared family library.'
    : isCoNarrator
      ? 'This shared book will appear on your shelf so you can listen and co-narrate chapters.'
      : 'This shared book will appear on your shelf for listening anytime.';

  const handleConfirmJoin = async () => {
    if (busy) return;
    setJoinError(null);
    try {
      const result = await onJoinFolder({
        folderId: invite.folderId,
        name: invite.name,
        scope: invite.scope,
        role: invite.role,
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
              2. Link &amp; Sync
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
                StoryTape can sync{' '}
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
            /* Step 2 — Link & Sync Shared Folder */
            <div className="join-action-card">
              <h4 className="join-action-card__title">
                Step 2 — Link &amp; Sync Shared Folder
              </h4>
              <p className="join-action-card__desc">
                You&apos;re connected to Google Drive. Tap below to link{' '}
                <strong>{invite.name}</strong> and sync its audiobooks to this
                device.
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
                      Joining &amp; syncing…
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
