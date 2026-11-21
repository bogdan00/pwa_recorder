import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Cloud,
  Copy,
  ExternalLink,
  FolderSync,
  Globe,
  Headphones,
  Info,
  Link2,
  Loader2,
  Mic,
  RefreshCw,
  Share2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import type {
  DriveCollaboratorPermission,
  ShareAccessRole,
} from '../types/models';
import { DriveApiError } from '../drive/driveClient';
import {
  buildJoinShareUrl,
  copyTextToClipboard,
  getDriveFolderWebUrl,
  shareInviteLink,
} from '../drive/shareUtils';
import {
  listDriveFolderPermissions,
  removeDriveFolderPermission,
  setDriveFolderAnyoneLinkAccess,
  shareDriveFolderWithEmail,
} from '../drive/syncService';
import { useConfirm } from './ConfirmDialogContext';
import { ToggleRow } from './ToggleRow';
import './ShareSheet.css';

export interface ShareSheetProps {
  open: boolean;
  scope: 'library' | 'book';
  targetTitle: string;
  folderId?: string;
  accessRole?: ShareAccessRole;
  isDriveConnected: boolean;
  onClose: () => void;
  onConnectDrive: () => void;
  onPrepareFolder: () => Promise<{ folderId: string; title: string }>;
  onToast: (message: string) => void;
}

function getPermissionRoleBadge(
  perm: DriveCollaboratorPermission,
): { label: string; className: string } {
  if (perm.role === 'owner') {
    return { label: 'Owner', className: 'badge badge-sage' };
  }
  if (
    perm.role === 'writer' ||
    perm.role === 'organizer' ||
    perm.role === 'fileOrganizer'
  ) {
    return { label: 'Co-Narrator', className: 'badge badge-amber' };
  }
  return { label: 'Listener', className: 'badge' };
}

function getInitials(perm: DriveCollaboratorPermission): string {
  const source = (perm.displayName || perm.emailAddress || '?').trim();
  const parts = source.split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0][0] ?? ''}${parts[1][0] ?? ''}`.toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

function sortPermissions(
  list: DriveCollaboratorPermission[],
): DriveCollaboratorPermission[] {
  const rank = (p: DriveCollaboratorPermission): number => {
    if (p.role === 'owner') return 0;
    if (p.type === 'anyone') return 3;
    if (p.role === 'writer' || p.role === 'organizer' || p.role === 'fileOrganizer') {
      return 1;
    }
    return 2;
  };
  return [...list].sort((a, b) => rank(a) - rank(b));
}

export const ShareSheet: React.FC<ShareSheetProps> = ({
  open,
  scope,
  targetTitle,
  folderId,
  accessRole,
  isDriveConnected,
  onClose,
  onConnectDrive,
  onPrepareFolder,
  onToast,
}) => {
  const confirm = useConfirm();
  const [preparedFolder, setPreparedFolder] = useState<{
    folderId: string;
    title: string;
  } | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [selectedRole, setSelectedRole] = useState<'writer' | 'reader'>('writer');
  const [message, setMessage] = useState('');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const [permissions, setPermissions] = useState<DriveCollaboratorPermission[]>([]);
  const [loadingPermissions, setLoadingPermissions] = useState(false);
  const [permissionsRestricted, setPermissionsRestricted] = useState(false);
  const [permissionsError, setPermissionsError] = useState<string | null>(null);

  const [togglingAnyone, setTogglingAnyone] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const activeFolderId = folderId || preparedFolder?.folderId || '';
  const activeTitle =
    preparedFolder?.title ||
    targetTitle ||
    (scope === 'library' ? 'StoryTape Audiobooks' : 'Untitled Book');
  const isReadOnly = accessRole === 'reader';

  // Reset transient state whenever the sheet opens or target changes
  useEffect(() => {
    if (!open) return;
    setPreparedFolder(null);
    setPreparing(false);
    setPrepareError(null);
    setEmail('');
    setSelectedRole('writer');
    setMessage('');
    setInviting(false);
    setInviteError(null);
    setPermissions([]);
    setPermissionsRestricted(false);
    setPermissionsError(null);
    setTogglingAnyone(false);
    setRemovingId(null);
  }, [open, scope, folderId, targetTitle]);

  // Allow Escape to close the sheet
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  const loadPermissions = useCallback(
    async (targetFolderId: string, isActive: () => boolean = () => true) => {
      if (!targetFolderId) return;

      setLoadingPermissions(true);
      setPermissionsRestricted(false);
      setPermissionsError(null);

      try {
        const list = await listDriveFolderPermissions(targetFolderId);
        if (!isActive()) return;
        setPermissions(list);
      } catch (err) {
        if (!isActive()) return;
        if (err instanceof DriveApiError && err.status === 401) {
          setPermissionsError(
            'Google Drive session expired. Please reconnect to manage sharing.',
          );
        } else if (
          err instanceof DriveApiError &&
          (err.status === 403 || err.status === 404)
        ) {
          setPermissionsRestricted(true);
        } else {
          setPermissionsError(
            err instanceof Error
              ? err.message
              : 'Could not load collaborators right now.',
          );
        }
      } finally {
        if (isActive()) setLoadingPermissions(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!open || !isDriveConnected || !activeFolderId) return;
    let active = true;
    void loadPermissions(activeFolderId, () => active);
    return () => {
      active = false;
    };
  }, [open, isDriveConnected, activeFolderId, loadPermissions]);

  const inviteUrl = useMemo(() => {
    if (!activeFolderId) return '';
    return buildJoinShareUrl({
      folderId: activeFolderId,
      name: activeTitle,
      scope,
      role: selectedRole,
    });
  }, [activeFolderId, activeTitle, scope, selectedRole]);

  const anyonePermission = useMemo(
    () => permissions.find((p) => p.type === 'anyone') ?? null,
    [permissions],
  );
  const anyoneEnabled = Boolean(anyonePermission);
  const sortedPermissions = useMemo(
    () => sortPermissions(permissions),
    [permissions],
  );

  if (!open) return null;

  const handlePrepareFolder = async () => {
    if (preparing) return;
    setPreparing(true);
    setPrepareError(null);
    try {
      const result = await onPrepareFolder();
      setPreparedFolder(result);
      onToast('Share folder ready in Google Drive');
    } catch (err) {
      setPrepareError(
        err instanceof Error
          ? err.message
          : 'Could not create Google Drive share folder.',
      );
    } finally {
      setPreparing(false);
    }
  };

  const handleInviteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail || inviting || !activeFolderId || isReadOnly) return;

    setInviting(true);
    setInviteError(null);
    try {
      const created = await shareDriveFolderWithEmail(
        activeFolderId,
        trimmedEmail,
        selectedRole,
        message.trim() || undefined,
      );
      const normalized: DriveCollaboratorPermission = {
        ...created,
        emailAddress: created.emailAddress || trimmedEmail,
      };
      setPermissions((prev) => {
        const filtered = prev.filter(
          (p) =>
            p.id !== normalized.id &&
            (!normalized.emailAddress ||
              p.emailAddress?.toLowerCase() !==
                normalized.emailAddress.toLowerCase()),
        );
        return [...filtered, normalized];
      });
      setEmail('');
      onToast(
        `Invited ${trimmedEmail} as ${
          selectedRole === 'writer' ? 'Co-Narrator' : 'Listener'
        }`,
      );
    } catch (err) {
      setInviteError(
        err instanceof Error ? err.message : 'Failed to send Google Drive invite.',
      );
    } finally {
      setInviting(false);
    }
  };

  const handleToggleAnyoneLink = async () => {
    if (togglingAnyone || !activeFolderId || isReadOnly) return;

    const nextEnabled = !anyoneEnabled;
    setTogglingAnyone(true);
    setPermissionsError(null);
    try {
      const updated = await setDriveFolderAnyoneLinkAccess(
        activeFolderId,
        nextEnabled,
        'reader',
      );
      setPermissions((prev) => {
        const withoutAnyone = prev.filter((p) => p.type !== 'anyone');
        return updated ? [...withoutAnyone, updated] : withoutAnyone;
      });
      onToast(
        nextEnabled
          ? 'Anyone with the link can now listen'
          : 'Public link access turned off',
      );
    } catch (err) {
      setPermissionsError(
        err instanceof Error
          ? err.message
          : 'Could not update link sharing permission.',
      );
    } finally {
      setTogglingAnyone(false);
    }
  };

  const handleRemovePermission = async (perm: DriveCollaboratorPermission) => {
    if (removingId || !activeFolderId || isReadOnly) return;

    const label = perm.emailAddress || perm.displayName || 'collaborator';
    setRemovingId(perm.id);
    setPermissionsError(null);
    try {
      await removeDriveFolderPermission(activeFolderId, perm.id);
      setPermissions((prev) => prev.filter((p) => p.id !== perm.id));
      onToast(`Removed ${label}`);
    } catch (err) {
      setPermissionsError(
        err instanceof Error
          ? err.message
          : `Could not remove ${label}.`,
      );
    } finally {
      setRemovingId(null);
    }
  };

  const handleShareNativeLink = async () => {
    if (!inviteUrl) return;
    const result = await shareInviteLink({
      title:
        scope === 'library'
          ? 'StoryTape Family Library'
          : `StoryTape: ${activeTitle}`,
      text:
        scope === 'library'
          ? `Join our shared StoryTape audiobook library "${activeTitle}"`
          : `Listen to or co-narrate "${activeTitle}" on StoryTape`,
      url: inviteUrl,
    });
    if (result === 'shared') {
      onToast('Invite link shared');
    } else if (result === 'copied') {
      onToast('Invite link copied');
    }
  };

  const handleCopyInviteLink = async () => {
    if (!inviteUrl) return;
    const ok = await copyTextToClipboard(inviteUrl);
    onToast(ok ? 'Invite link copied' : 'Select and copy the link above');
  };

  const headingTitle =
    scope === 'library' ? 'Share Family Library' : `Share "${activeTitle}"`;

  return (
    <div
      className="sheet-backdrop modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-sheet-title"
      data-testid="share-sheet"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet-panel modal-sheet">
        <div className="sheet-header">
          <div className="share-sheet-heading">
            <span className="share-sheet-heading__icon" aria-hidden="true">
              <Users size={18} />
            </span>
            <h2 id="share-sheet-title" className="sheet-title">
              {headingTitle}
            </h2>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close share dialog"
          >
            <X size={20} />
          </button>
        </div>

        <div className="sheet-body">
          {/* State A — Not connected to Google Drive */}
          {!isDriveConnected && (
            <div className="share-callout">
              <div className="share-callout__head">
                <span className="share-callout__icon" aria-hidden="true">
                  <Cloud size={22} />
                </span>
                <div>
                  <h3 className="share-callout__title">
                    Connect Google Drive to Share
                  </h3>
                </div>
              </div>
              <p className="share-callout__desc">
                Connecting Google Drive lets you share{' '}
                {scope === 'library'
                  ? 'your family audiobook library'
                  : `"${activeTitle}"`}{' '}
                and invite family members as Co-Narrators (who can record new
                chapters) or Listeners (listen-only).
              </p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={onConnectDrive}
              >
                <Cloud size={16} />
                Connect Google Drive
              </button>
              <p className="share-callout__note">
                StoryTape only accesses the folders you create or open — never
                the rest of your Drive.
              </p>
            </div>
          )}

          {/* State B — Connected, but folder not yet synced */}
          {isDriveConnected && !activeFolderId && (
            <div className="share-callout">
              <div className="share-callout__head">
                <span className="share-callout__icon" aria-hidden="true">
                  <FolderSync size={22} />
                </span>
                <div>
                  <h3 className="share-callout__title">
                    Create a Shareable Drive Folder
                  </h3>
                </div>
              </div>
              <p className="share-callout__desc">
                {scope === 'library'
                  ? 'Sync your library folder to Google Drive first so you can invite family members and generate an invite link.'
                  : `Sync "${activeTitle}" to Google Drive first so it gets its own shareable folder and invite link.`}
              </p>
              {prepareError && (
                <div className="share-error-banner" role="alert">
                  {prepareError}
                </div>
              )}
              <button
                type="button"
                id="prepare-share-folder-btn"
                className="btn btn-primary"
                onClick={handlePrepareFolder}
                disabled={preparing}
              >
                {preparing ? (
                  <>
                    <Loader2 size={16} className="spin" />
                    Syncing folder…
                  </>
                ) : (
                  <>
                    <FolderSync size={16} />
                    Sync & Create Share Folder
                  </>
                )}
              </button>
            </div>
          )}

          {/* State C — Folder ready */}
          {isDriveConnected && activeFolderId && (
            <>
              {/* Section 1 — Invite Person by Google Email */}
              <section className="share-section" aria-label="Invite by email">
                <div className="share-section__head">
                  <h3 className="share-section__title">
                    <UserPlus size={16} />
                    Invite by Google Email
                  </h3>
                </div>

                {isReadOnly ? (
                  <div className="share-readonly-note">
                    <Info size={16} />
                    <span>
                      You currently have <strong>Listener</strong> (read-only)
                      access to this folder. Ask the folder owner or a
                      Co-Narrator to invite new people.
                    </span>
                  </div>
                ) : (
                  <form
                    className="share-invite-form"
                    onSubmit={handleInviteSubmit}
                  >
                    <div className="field">
                      <label htmlFor="share-email-input" className="field-label">
                        Google Account Email
                      </label>
                      <input
                        id="share-email-input"
                        type="email"
                        className="input"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="mom@gmail.com or grandpa@gmail.com"
                        disabled={inviting}
                        required
                      />
                    </div>

                    <div className="field">
                      <span className="field-label">Access Role</span>
                      <div
                        className="share-role-segment"
                        role="radiogroup"
                        aria-label="Collaborator role"
                      >
                        <button
                          type="button"
                          role="radio"
                          aria-checked={selectedRole === 'writer'}
                          className={`share-role-option ${
                            selectedRole === 'writer'
                              ? 'share-role-option--active'
                              : ''
                          }`}
                          onClick={() => setSelectedRole('writer')}
                          disabled={inviting}
                        >
                          <span className="share-role-option__label">
                            <Mic size={14} />
                            Co-Narrator (Can Record)
                          </span>
                          <span className="share-role-option__sub">
                            Record chapters &amp; edit details
                          </span>
                        </button>

                        <button
                          type="button"
                          role="radio"
                          aria-checked={selectedRole === 'reader'}
                          className={`share-role-option ${
                            selectedRole === 'reader'
                              ? 'share-role-option--active'
                              : ''
                          }`}
                          onClick={() => setSelectedRole('reader')}
                          disabled={inviting}
                        >
                          <span className="share-role-option__label">
                            <Headphones size={14} />
                            Listener (Listen Only)
                          </span>
                          <span className="share-role-option__sub">
                            Play &amp; download chapters safely
                          </span>
                        </button>
                      </div>
                    </div>

                    <div className="field">
                      <label
                        htmlFor="share-message-input"
                        className="field-label"
                      >
                        Personal Note (optional)
                      </label>
                      <input
                        id="share-message-input"
                        type="text"
                        className="input"
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        placeholder="Join our family audiobook library!"
                        disabled={inviting}
                        maxLength={240}
                      />
                    </div>

                    {inviteError && (
                      <div className="share-error-banner" role="alert">
                        {inviteError}
                      </div>
                    )}

                    <div className="share-invite-submit">
                      <button
                        type="submit"
                        id="share-invite-btn"
                        className="btn btn-primary"
                        disabled={inviting || !email.trim()}
                      >
                        {inviting ? (
                          <>
                            <Loader2 size={16} className="spin" />
                            Inviting…
                          </>
                        ) : (
                          <>
                            <UserPlus size={16} />
                            Invite to Folder
                          </>
                        )}
                      </button>
                    </div>
                  </form>
                )}
              </section>

              {/* Section 2 — Shareable StoryTape Invite Link */}
              <section
                className="share-section"
                aria-label="Shareable StoryTape invite link"
              >
                <div className="share-section__head">
                  <h3 className="share-section__title">
                    <Link2 size={16} />
                    StoryTape Invite Link
                  </h3>
                </div>

                <ToggleRow
                  title="Anyone with the link can listen"
                  description="Allows family with this link to open & listen even without an email invite"
                  checked={anyoneEnabled}
                  disabled={togglingAnyone || isReadOnly}
                  onToggle={handleToggleAnyoneLink}
                />

                <div className="share-link-preview-box">
                  <input
                    type="text"
                    readOnly
                    className="share-link-input"
                    value={inviteUrl}
                    aria-label="StoryTape invite link"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <span className="field-hint">
                    Send this link after inviting — opening it guides family
                    members straight into{' '}
                    {scope === 'library'
                      ? 'your shared library'
                      : `"${activeTitle}"`}
                    .
                  </span>
                </div>

                <div className="share-link-actions">
                  <button
                    type="button"
                    id="share-link-native-btn"
                    className="btn btn-amber btn-sm"
                    onClick={handleShareNativeLink}
                  >
                    <Share2 size={15} />
                    Share Invite Link
                  </button>
                  <button
                    type="button"
                    id="copy-invite-link-btn"
                    className="btn btn-secondary btn-sm"
                    onClick={handleCopyInviteLink}
                  >
                    <Copy size={15} />
                    Copy Link
                  </button>
                  <a
                    href={getDriveFolderWebUrl(activeFolderId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-ghost btn-sm share-external-link"
                  >
                    <ExternalLink size={15} />
                    Open in Google Drive
                  </a>
                </div>
              </section>

              {/* Section 3 — People with Access */}
              <section
                className="share-section"
                aria-label="People with access"
              >
                <div className="share-section__head">
                  <h3 className="share-section__title">
                    <Users size={16} />
                    People with Access
                    {!loadingPermissions &&
                      !permissionsRestricted &&
                      sortedPermissions.length > 0 && (
                        <span className="badge">
                          {sortedPermissions.length}
                        </span>
                      )}
                  </h3>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => void loadPermissions(activeFolderId)}
                    disabled={loadingPermissions}
                    aria-label="Refresh collaborators"
                  >
                    <RefreshCw
                      size={16}
                      className={loadingPermissions ? 'spin' : ''}
                    />
                  </button>
                </div>

                {permissionsError && (
                  <div className="share-error-banner" role="alert">
                    {permissionsError}
                  </div>
                )}

                {loadingPermissions && sortedPermissions.length === 0 ? (
                  <div className="share-collab-loading">
                    <Loader2 size={16} className="spin" />
                    <span>Loading collaborators…</span>
                  </div>
                ) : permissionsRestricted ? (
                  <div className="share-collab-empty">
                    <Info size={16} />
                    <span>
                      Collaborator list is only visible to folder owners and
                      editors.
                    </span>
                  </div>
                ) : sortedPermissions.length === 0 ? (
                  <div className="share-collab-empty">
                    <span>
                      Only you have access right now. Invite family members
                      above.
                    </span>
                  </div>
                ) : (
                  <ul className="share-collab-list">
                    {sortedPermissions.map((perm) => {
                      const isAnyone = perm.type === 'anyone';
                      const isOwner = perm.role === 'owner';
                      const badge = getPermissionRoleBadge(perm);
                      const primaryLabel = isAnyone
                        ? 'Anyone with link'
                        : perm.displayName || perm.emailAddress || 'Collaborator';
                      const secondaryLabel =
                        !isAnyone &&
                        perm.displayName &&
                        perm.emailAddress &&
                        perm.displayName !== perm.emailAddress
                          ? perm.emailAddress
                          : isAnyone
                            ? 'Public link access'
                            : null;
                      const removeTargetLabel =
                        perm.emailAddress || perm.displayName || 'collaborator';

                      return (
                        <li key={perm.id} className="share-collab-item">
                          <div className="share-collab-item__info">
                            <span
                              className={`share-collab-avatar ${
                                isAnyone ? 'share-collab-avatar--anyone' : ''
                              }`}
                              aria-hidden="true"
                            >
                              {isAnyone ? (
                                <Globe size={16} />
                              ) : (
                                getInitials(perm)
                              )}
                            </span>
                            <div className="share-collab-text">
                              <span className="share-collab-name">
                                {primaryLabel}
                              </span>
                              {secondaryLabel && (
                                <span className="share-collab-email">
                                  {secondaryLabel}
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="share-collab-actions">
                            <span className={badge.className}>
                              {badge.label}
                            </span>
                            {!isOwner && !isAnyone && !isReadOnly && (
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm share-remove-btn"
                                aria-label={`Remove ${removeTargetLabel}`}
                                disabled={removingId === perm.id}
                                onClick={() =>
                                  confirm({
                                    title: 'Remove Collaborator Access?',
                                    description: (
                                      <>
                                        Revoke Google Drive access for{' '}
                                        <strong>
                                          {perm.emailAddress ||
                                            perm.displayName ||
                                            'this collaborator'}
                                        </strong>
                                        ? They will no longer be able to access
                                        or sync updates for{' '}
                                        <strong>{activeTitle}</strong>.
                                      </>
                                    ),
                                    confirmLabel: 'Remove Access',
                                    tone: 'danger',
                                    onConfirm: () =>
                                      handleRemovePermission(perm),
                                  })
                                }
                              >
                                {removingId === perm.id ? (
                                  <Loader2 size={14} className="spin" />
                                ) : (
                                  'Remove'
                                )}
                              </button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>

        <div className="sheet-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
