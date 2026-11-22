import { useCallback, useEffect, useState } from 'react';
import type { AppSettings, SharedBookLink } from '../types/models';
import {
  deleteProject,
  getProject,
  listProjects,
  putProject,
} from '../storage/db';
import { recordSyncDebugEvent } from '../drive/debugLog';
import { DriveApiError, DriveClient } from '../drive/driveClient';
import { googleAuth, type GoogleAuthState } from '../drive/googleAuth';
import { pickSharedDriveFolder } from '../drive/googlePicker';
import {
  type JoinShareInvite,
  parseJoinInviteInput,
} from '../drive/shareUtils';
import {
  importSharedBookIntoLibrary,
  inspectSharedDriveFolder,
  isUnsharedPersonalBook,
  shareLocalBooksIntoSharedLibrary,
  syncAllWithDrive,
  syncSingleProjectWithDrive,
  trashDriveFolder,
} from '../drive/syncService';

export type JoinBookMode = 'import' | 'link';

export interface UseDriveSyncOptions {
  settingsRef: React.MutableRefObject<AppSettings>;
  googleClientId: string;
  onUpdateSettings: (next: AppSettings) => void;
  reloadData: () => Promise<void>;
  showToast: (message: string, actionLabel?: string, onAction?: () => void) => void;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
  onSetPendingJoinInvite: (invite: JoinShareInvite | null) => void;
  onClearJoinHash: () => void;
  onPromptShareExistingBooks?: (info: {
    folderName: string;
    unsharedCount: number;
    onConfirmShare: () => Promise<void>;
  }) => void;
}

export function canAutoSyncDrive(): boolean {
  return googleAuth.hasValidToken() || googleAuth.canRefreshSilently();
}

export function needsReconnectToDrive(): boolean {
  return !canAutoSyncDrive() && googleAuth.getState().wasConnected;
}

export function useDriveSync({
  settingsRef,
  googleClientId,
  onUpdateSettings,
  reloadData,
  showToast,
  onOpenSettings,
  onCloseSettings,
  onSetPendingJoinInvite,
  onClearJoinHash,
  onPromptShareExistingBooks,
}: UseDriveSyncOptions) {
  const [authState, setAuthState] = useState<GoogleAuthState>(() =>
    googleAuth.getState(),
  );
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatusMessage, setSyncStatusMessage] = useState<string | null>(
    null,
  );
  const [isJoiningShare, setIsJoiningShare] = useState(false);

  useEffect(() => {
    googleAuth.configure(googleClientId);
    return googleAuth.subscribe(setAuthState);
  }, [googleClientId]);

  const handleSyncAll = useCallback(
    async (overrideSettings?: AppSettings) => {
      if (isSyncing) return;
      if (!canAutoSyncDrive()) {
        onOpenSettings();
        showToast('Connect Google Drive in Settings to sync');
        return;
      }

      const activeSettings = overrideSettings ?? settingsRef.current;
      setIsSyncing(true);
      setSyncStatusMessage('Syncing with Google Drive…');
      try {
        const result = await syncAllWithDrive(activeSettings, (u) =>
          setSyncStatusMessage(u.message),
        );
        if (
          result.rootFolderId !== activeSettings.driveRootFolderId ||
          result.rootAccessRole !== activeSettings.driveAccessRole
        ) {
          onUpdateSettings({
            ...activeSettings,
            driveRootFolderId: result.rootFolderId,
            driveAccessRole: result.rootAccessRole,
          });
        }
        await reloadData();
        if (result.errors.length > 0) {
          showToast(`Synced with ${result.errors.length} error(s)`);
        } else {
          showToast(
            result.pushedRecordings > 0 || result.pulledProjects > 0
              ? `Drive synced (${result.pushedRecordings} uploaded, ${result.pulledProjects} pulled)`
              : 'Google Drive is up to date',
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Google Drive sync failed';
        setSyncStatusMessage(msg);
        showToast(msg);
      } finally {
        setIsSyncing(false);
      }
    },
    [isSyncing, onOpenSettings, onUpdateSettings, reloadData, settingsRef, showToast],
  );

  const handleSharePersonalBooksToLibrary = useCallback(
    async (overrideSettings?: AppSettings) => {
      if (!canAutoSyncDrive()) {
        onOpenSettings();
        showToast('Connect Google Drive in Settings first');
        return;
      }
      const activeSettings = overrideSettings ?? settingsRef.current;
      if (
        activeSettings.driveLibraryMode !== 'shared' ||
        activeSettings.driveAccessRole === 'reader'
      ) {
        return;
      }

      const all = await listProjects();
      const eligible = all.filter(isUnsharedPersonalBook);
      if (eligible.length === 0) {
        showToast('All your books are already in the shared library');
        return;
      }

      setIsSyncing(true);
      setSyncStatusMessage(
        `Sharing ${eligible.length} personal ${eligible.length === 1 ? 'book' : 'books'}…`,
      );
      try {
        const res = await shareLocalBooksIntoSharedLibrary(
          eligible.map((p) => p.id),
          activeSettings,
          { onProgress: (u) => setSyncStatusMessage(u.message) },
        );
        await reloadData();
        if (res.errors.length > 0) {
          showToast(
            `Shared ${res.sharedProjects} book(s) with ${res.errors.length} error(s)`,
          );
        } else if (res.sharedProjects > 0) {
          showToast(
            `Shared ${res.sharedProjects} ${res.sharedProjects === 1 ? 'book' : 'books'} into "${activeSettings.driveSharedFolderName || 'Shared Library'}"`,
          );
        }
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : 'Could not share personal books';
        setSyncStatusMessage(msg);
        showToast(msg);
      } finally {
        setIsSyncing(false);
      }
    },
    [onOpenSettings, reloadData, settingsRef, showToast],
  );

  const handleSyncProject = useCallback(
    async (projectId: string, silent = false) => {
      if (!canAutoSyncDrive()) return;
      const activeSettings = settingsRef.current;
      setIsSyncing(true);
      setSyncStatusMessage('Syncing book to Google Drive…');
      try {
        const res = await syncSingleProjectWithDrive(
          projectId,
          activeSettings,
          (u) => setSyncStatusMessage(u.message),
        );
        if (res.rootFolderId !== activeSettings.driveRootFolderId) {
          onUpdateSettings({
            ...activeSettings,
            driveRootFolderId: res.rootFolderId,
          });
        }
        await reloadData();
        if (!silent) {
          if (res.sourceUnavailable) {
            showToast('Original source is unavailable — your copy stays safe');
          } else if (res.mirroredChapters && res.mirroredChapters > 0) {
            showToast(
              `Mirrored ${res.mirroredChapters} new ${res.mirroredChapters === 1 ? 'chapter' : 'chapters'}`,
            );
          } else if (res.mirroredChapters === 0) {
            showToast('Imported book is up to date');
          } else {
            showToast('Book synced to Google Drive');
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Drive sync failed';
        setSyncStatusMessage(msg);
        if (!silent) showToast(msg);
      } finally {
        setIsSyncing(false);
      }
    },
    [onUpdateSettings, reloadData, settingsRef, showToast],
  );

  // Must invoke googleAuth.requestSignIn() synchronously inside button click for iOS PWA
  const handleConnectDrive = useCallback(
    (options?: {
      skipAutoSync?: boolean;
      onConnected?: () => Promise<void> | void;
    }) => {
      void googleAuth
        .requestSignIn()
        .then(async (token) => {
          try {
            const client = new DriveClient(token);
            const info = await client.getUserInfo();
            googleAuth.setUserProfile(info.email, info.displayName);
          } catch {
            // Optional user profile fetch
          }
          showToast('Connected to Google Drive');
          if (options?.onConnected) {
            await options.onConnected();
          } else if (!options?.skipAutoSync) {
            await handleSyncAll();
          }
        })
        .catch((err) => {
          showToast(err instanceof Error ? err.message : 'Sign-in cancelled');
        });
    },
    [handleSyncAll, showToast],
  );

  const handleSyncOrReconnectAll = useCallback(() => {
    if (needsReconnectToDrive()) {
      handleConnectDrive();
      return;
    }
    void handleSyncAll();
  }, [handleConnectDrive, handleSyncAll]);

  const handleSyncOrReconnectProject = useCallback(
    (projectId: string) => {
      if (needsReconnectToDrive()) {
        handleConnectDrive({
          skipAutoSync: true,
          onConnected: () => handleSyncProject(projectId),
        });
        return;
      }
      void handleSyncProject(projectId);
    },
    [handleConnectDrive, handleSyncProject],
  );

  const handleJoinFolder = useCallback(
    async (options: {
      folderId: string;
      name: string;
      scope: 'library' | 'book';
      role: 'writer' | 'reader';
      mode?: JoinBookMode;
      shareExistingBooks?: boolean;
    }): Promise<{
      ok: boolean;
      needsPicker?: boolean;
      error?: string;
      importedProjectId?: string;
    }> => {
      recordSyncDebugEvent('share', 'join_start', {
        folderId: options.folderId,
        name: options.name,
        requestedScope: options.scope,
        requestedRole: options.role,
        requestedMode: options.mode ?? 'default',
        shareExistingBooks: options.shareExistingBooks ?? 'unspecified',
      });
      if (!canAutoSyncDrive()) {
        recordSyncDebugEvent('share', 'join_blocked_not_connected', {});
        return { ok: false, error: 'Please connect Google Drive first.' };
      }

      setIsJoiningShare(true);
      try {
        const info = await inspectSharedDriveFolder(options.folderId);
        const resolvedScope = info.scope || options.scope;
        const resolvedRole: 'writer' | 'reader' =
          info.accessRole === 'reader' ? 'reader' : 'writer';
        const resolvedName = info.name || options.name || 'Shared Audiobooks';

        recordSyncDebugEvent('share', 'join_inspected', {
          folderId: info.folderId,
          resolvedName,
          resolvedScope,
          resolvedRole,
          rawAccessRole: info.accessRole,
          requestedMode: options.mode ?? 'default',
        });

        const activeSettings = settingsRef.current;
        const canImportToActiveLibrary = !(
          activeSettings.driveLibraryMode === 'shared' &&
          activeSettings.driveAccessRole === 'reader'
        );

        if (
          resolvedScope === 'book' &&
          options.mode === 'import' &&
          canImportToActiveLibrary
        ) {
          const imported = await importSharedBookIntoLibrary(
            info.folderId,
            activeSettings,
            {
              onProgress: (u) => setSyncStatusMessage(u.message),
            },
          );
          if (imported.rootFolderId !== activeSettings.driveRootFolderId) {
            onUpdateSettings({
              ...activeSettings,
              driveRootFolderId: imported.rootFolderId,
            });
          }
          onSetPendingJoinInvite(null);
          onClearJoinHash();
          await reloadData();
          recordSyncDebugEvent('share', 'join_import_success', {
            projectId: imported.projectId,
            title: imported.title,
            copiedChapters: imported.copiedChapters,
            alreadyExisted: imported.alreadyExisted,
          });
          showToast(
            imported.alreadyExisted
              ? `Updated "${imported.title}" from source`
              : `Imported "${imported.title}" into your library`,
          );
          return { ok: true, importedProjectId: imported.projectId };
        }

        let nextSettings: AppSettings;
        if (resolvedScope === 'book') {
          const existing = activeSettings.sharedBookFolders ?? [];
          const nextEntry: SharedBookLink = {
            folderId: info.folderId,
            title: resolvedName,
            role: resolvedRole,
            addedAt: Date.now(),
          };
          const filtered = existing.filter((b) => b.folderId !== info.folderId);
          nextSettings = {
            ...activeSettings,
            sharedBookFolders: [...filtered, nextEntry],
          };
        } else {
          nextSettings = {
            ...activeSettings,
            driveLibraryMode: 'shared',
            driveRootFolderId: info.folderId,
            driveSharedFolderName: resolvedName,
            driveAccessRole: info.accessRole,
          };
        }

        onUpdateSettings(nextSettings);
        onSetPendingJoinInvite(null);
        onClearJoinHash();

        await handleSyncAll(nextSettings);

        let sharedExistingCount = 0;
        if (resolvedScope === 'library' && resolvedRole === 'writer') {
          const allLocal = await listProjects();
          const unsharedPersonal = allLocal.filter(isUnsharedPersonalBook);
          if (options.shareExistingBooks === true && unsharedPersonal.length > 0) {
            const shareRes = await shareLocalBooksIntoSharedLibrary(
              unsharedPersonal.map((p) => p.id),
              nextSettings,
              { onProgress: (u) => setSyncStatusMessage(u.message) },
            );
            sharedExistingCount = shareRes.sharedProjects;
            await reloadData();
          } else if (
            options.shareExistingBooks === undefined &&
            unsharedPersonal.length > 0 &&
            onPromptShareExistingBooks
          ) {
            onPromptShareExistingBooks({
              folderName: resolvedName,
              unsharedCount: unsharedPersonal.length,
              onConfirmShare: () =>
                handleSharePersonalBooksToLibrary(nextSettings),
            });
          }
        }

        recordSyncDebugEvent('share', 'join_link_success', {
          folderId: info.folderId,
          resolvedScope,
          resolvedRole,
          sharedExistingCount,
        });
        showToast(
          resolvedScope === 'book'
            ? `Joined shared book "${resolvedName}"`
            : sharedExistingCount > 0
              ? `Connected to "${resolvedName}" & shared ${sharedExistingCount} existing ${sharedExistingCount === 1 ? 'book' : 'books'}`
              : `Connected to shared library "${resolvedName}"`,
        );
        return { ok: true };
      } catch (err) {
        if (err instanceof DriveApiError && (err.status === 404 || err.status === 403)) {
          recordSyncDebugEvent('share', 'join_needs_picker', {
            folderId: options.folderId,
            status: err.status,
            error: err.message,
          });
          return {
            ok: false,
            needsPicker: true,
            error:
              'Google Drive requires you to pick this shared folder once so StoryTape can access it safely.',
          };
        }
        const msg =
          err instanceof Error ? err.message : 'Could not link shared folder.';
        recordSyncDebugEvent('share', 'join_error', {
          folderId: options.folderId,
          error: msg,
        });
        showToast(msg);
        return { ok: false, error: msg };
      } finally {
        setIsJoiningShare(false);
      }
    },
    [
      handleSharePersonalBooksToLibrary,
      handleSyncAll,
      onClearJoinHash,
      onPromptShareExistingBooks,
      onSetPendingJoinInvite,
      onUpdateSettings,
      reloadData,
      settingsRef,
      showToast,
    ],
  );

  const handleJoinSharedFolderFromSettings = useCallback(
    async (rawInput: string) => {
      const invite = parseJoinInviteInput(rawInput);
      if (!invite) {
        showToast('Paste a valid StoryTape invite link or Google Drive folder URL');
        return;
      }
      if (invite.clientId && !settingsRef.current.googleClientId.trim()) {
        onUpdateSettings({
          ...settingsRef.current,
          googleClientId: invite.clientId,
        });
      }
      if (!canAutoSyncDrive()) {
        onCloseSettings();
        onSetPendingJoinInvite(invite);
        return;
      }
      const res = await handleJoinFolder({ ...invite, mode: 'link' });
      if (!res.ok && res.needsPicker) {
        onCloseSettings();
        onSetPendingJoinInvite(invite);
      }
    },
    [
      handleJoinFolder,
      onCloseSettings,
      onSetPendingJoinInvite,
      onUpdateSettings,
      settingsRef,
      showToast,
    ],
  );

  const handlePickSharedFolder = useCallback(async () => {
    const token = await googleAuth.ensureValidAccessToken();
    if (!token) {
      showToast('Connect Google Drive first');
      return;
    }
    try {
      const picked = await pickSharedDriveFolder({
        accessToken: token,
        apiKey: settingsRef.current.googleApiKey,
        clientId: settingsRef.current.googleClientId,
        title: 'Select Shared StoryTape Folder',
      });
      if (!picked) return;
      await handleJoinFolder({
        folderId: picked.folderId,
        name: picked.name,
        scope: 'library',
        role: 'writer',
      });
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Could not open Google Picker',
      );
    }
  }, [handleJoinFolder, settingsRef, showToast]);

  const handleSwitchToPersonalLibrary = useCallback(async () => {
    const nextSettings: AppSettings = {
      ...settingsRef.current,
      driveLibraryMode: 'personal',
      driveRootFolderId: undefined,
      driveSharedFolderName: undefined,
      driveAccessRole: 'owner',
    };
    onUpdateSettings(nextSettings);
    showToast('Switched back to your personal Drive library');
    if (canAutoSyncDrive()) {
      await handleSyncAll(nextSettings);
    }
  }, [handleSyncAll, onUpdateSettings, settingsRef, showToast]);

  const handleUnlinkSharedBook = useCallback(
    (folderId: string) => {
      const nextLinks = (settingsRef.current.sharedBookFolders ?? []).filter(
        (b) => b.folderId !== folderId,
      );
      onUpdateSettings({
        ...settingsRef.current,
        sharedBookFolders: nextLinks,
      });
      showToast('Unlinked shared book from Drive sync');
    },
    [onUpdateSettings, settingsRef, showToast],
  );

  const handleDetachImportedBook = useCallback(
    async (projectId: string) => {
      const project = await getProject(projectId);
      if (!project || !project.importedFrom) return;
      const canAutoSync = canAutoSyncDrive();
      const hasLinkedDrive = canAutoSync || googleAuth.getState().wasConnected;
      await putProject({
        ...project,
        importedFrom: undefined,
        syncStatus: hasLinkedDrive ? 'pending_upload' : 'local_only',
        updatedAt: Date.now(),
      });
      await reloadData();
      showToast('Detached copy — you can now record and edit chapters');
      if (canAutoSync) {
        void handleSyncProject(projectId, true);
      }
    },
    [handleSyncProject, reloadData, showToast],
  );

  const handleRemoveImportedBook = useCallback(
    async (projectId: string, onAfterRemove?: () => void) => {
      const project = await getProject(projectId);
      await deleteProject(projectId);
      if (
        project?.driveFolderId &&
        project.accessRole !== 'reader' &&
        canAutoSyncDrive()
      ) {
        await trashDriveFolder(project.driveFolderId).catch(() => {});
      }
      await reloadData();
      onAfterRemove?.();
      showToast('Removed imported copy from library');
    },
    [reloadData, showToast],
  );

  return {
    authState,
    isSyncing,
    syncStatusMessage,
    isJoiningShare,
    handleSyncAll,
    handleSyncProject,
    handleSyncOrReconnectAll,
    handleSyncOrReconnectProject,
    handleConnectDrive,
    handleJoinFolder,
    handleJoinSharedFolderFromSettings,
    handlePickSharedFolder,
    handleSharePersonalBooksToLibrary,
    handleSwitchToPersonalLibrary,
    handleUnlinkSharedBook,
    handleDetachImportedBook,
    handleRemoveImportedBook,
  };
}
