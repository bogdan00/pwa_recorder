import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ActiveDraft,
  AppSettings,
  BookProject,
  PlaybackProgress,
  Recording,
  SharedBookLink,
} from './types/models';
import {
  clearSyncedAudioCache,
  deleteDraft,
  deleteProject,
  deleteProjectCover,
  deleteRecording,
  getRecordingBlob,
  listAllRecordings,
  listDrafts,
  listPlaybackProgress,
  listProjects,
  putProject,
  putProjectCover,
  putRecording,
  reorderProjectRecordings,
} from './storage/db';
import {
  applyThemeToDocument,
  loadSettings,
  saveSettings,
} from './storage/settings';
import { DriveApiError, DriveClient } from './drive/driveClient';
import { googleAuth, type GoogleAuthState } from './drive/googleAuth';
import { pickSharedDriveFolder } from './drive/googlePicker';
import {
  type JoinShareInvite,
  parseJoinInviteInput,
  shareAudioChapter,
} from './drive/shareUtils';
import {
  downloadCloudRecording,
  ensureShareableBookFolder,
  ensureShareableLibraryFolder,
  inspectSharedDriveFolder,
  syncAllWithDrive,
  syncSingleProjectWithDrive,
} from './drive/syncService';
import { PlayerProvider, usePlayer } from './player/PlayerContext';
import {
  buildChapterDriveFileName,
  createId,
} from './utils/format';
import {
  BookEditorSheet,
  type BookFormSubmission,
} from './components/BookEditorSheet';
import { AudioPlayerSheet } from './components/AudioPlayerSheet';
import { JoinShareModal } from './components/JoinShareModal';
import { MiniPlayerBar } from './components/MiniPlayerBar';
import { ShareSheet } from './components/ShareSheet';
import { LibraryView } from './views/LibraryView';
import { ProjectDetailView } from './views/ProjectDetailView';
import {
  RecordingStudioView,
  type SavedStudioRecording,
} from './views/RecordingStudioView';
import { SettingsSheet } from './views/SettingsSheet';
import type { RecordingEngine } from './audio/recordingEngine';

type Route =
  | { view: 'library' }
  | { view: 'book'; projectId: string }
  | { view: 'record'; projectId: string; draftId?: string | null };

type ShareTarget =
  | { scope: 'library' }
  | { scope: 'book'; projectId: string };

interface ToastItem {
  id: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

function parseHashRoute(): Route {
  const hash = window.location.hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart] = hash.split('?');
  const parts = pathPart.split('/').filter(Boolean);

  if (parts[0] === 'book' && parts[1]) {
    return { view: 'book', projectId: decodeURIComponent(parts[1]) };
  }
  if (parts[0] === 'record' && parts[1]) {
    const params = new URLSearchParams(queryPart || '');
    return {
      view: 'record',
      projectId: decodeURIComponent(parts[1]),
      draftId: params.get('draft') ?? undefined,
    };
  }
  return { view: 'library' };
}

function parseJoinInviteFromHash(): JoinShareInvite | null {
  if (typeof window === 'undefined') return null;
  if (!window.location.hash.includes('/join')) return null;
  return parseJoinInviteInput(window.location.hash);
}

function serializeRoute(route: Route): string {
  if (route.view === 'book') {
    return `#/book/${encodeURIComponent(route.projectId)}`;
  }
  if (route.view === 'record') {
    const base = `#/record/${encodeURIComponent(route.projectId)}`;
    return route.draftId
      ? `${base}?draft=${encodeURIComponent(route.draftId)}`
      : base;
  }
  return '#/';
}

export interface AppProps {
  onApplyPwaUpdate?: () => void;
  pwaUpdateReady?: boolean;
  engineFactory?: (projectId: string) => RecordingEngine;
}

const StoryTapeShell: React.FC<AppProps> = ({
  onApplyPwaUpdate,
  pwaUpdateReady,
  engineFactory,
}) => {
  const player = usePlayer();
  const [route, setRoute] = useState<Route>(() => parseHashRoute());
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [authState, setAuthState] = useState<GoogleAuthState>(() =>
    googleAuth.getState(),
  );

  // Local IndexedDB state
  const [projects, setProjects] = useState<BookProject[]>([]);
  const [allRecordings, setAllRecordings] = useState<Recording[]>([]);
  const [progressList, setProgressList] = useState<PlaybackProgress[]>([]);
  const [drafts, setDrafts] = useState<ActiveDraft[]>([]);

  // Modals & transient status
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bookEditorOpen, setBookEditorOpen] = useState(false);
  const [editingBook, setEditingBook] = useState<BookProject | null>(null);
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
  const [pendingJoinInvite, setPendingJoinInvite] =
    useState<JoinShareInvite | null>(() => parseJoinInviteFromHash());
  const [isJoiningShare, setIsJoiningShare] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatusMessage, setSyncStatusMessage] = useState<string | null>(
    null,
  );
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const toastTimersRef = useRef<Map<string, number>>(new Map());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const showToast = useCallback(
    (message: string, actionLabel?: string, onAction?: () => void) => {
      const id = createId('toast');
      setToasts((prev) => [
        ...prev.slice(-2),
        { id, message, actionLabel, onAction },
      ]);
      const timer = window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
        toastTimersRef.current.delete(id);
      }, 4200);
      toastTimersRef.current.set(id, timer);
    },
    [],
  );

  useEffect(() => {
    const timers = toastTimersRef.current;
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, []);

  const handleUpdateSettings = useCallback((next: AppSettings) => {
    settingsRef.current = next;
    setSettings(next);
    saveSettings(next);
  }, []);

  const navigate = useCallback((next: Route) => {
    const hash = serializeRoute(next);
    if (window.location.hash !== hash) {
      window.location.hash = hash;
    }
    setRoute(next);
  }, []);

  // Pre-fill Google OAuth Client ID if opened via a StoryTape invite link
  useEffect(() => {
    if (
      pendingJoinInvite?.clientId &&
      !settingsRef.current.googleClientId.trim()
    ) {
      handleUpdateSettings({
        ...settingsRef.current,
        googleClientId: pendingJoinInvite.clientId,
      });
    }
  }, [handleUpdateSettings, pendingJoinInvite]);

  useEffect(() => {
    const onHashChange = () => {
      const invite = parseJoinInviteFromHash();
      if (invite) {
        setPendingJoinInvite(invite);
      }
      setRoute(parseHashRoute());
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Load all IndexedDB data
  const reloadData = useCallback(async () => {
    const [proj, recs, prog, dr] = await Promise.all([
      listProjects(),
      listAllRecordings(),
      listPlaybackProgress(),
      listDrafts(),
    ]);
    setProjects(proj);
    setAllRecordings(recs);
    setProgressList(prog);
    setDrafts(dr);
  }, []);

  useEffect(() => {
    void reloadData();
  }, [reloadData]);

  // Apply theme & listen to OS theme changes when set to 'system'
  useEffect(() => {
    applyThemeToDocument(settings.theme);
    if (settings.theme !== 'system' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const handler = () => applyThemeToDocument('system');
    mq.addEventListener?.('change', handler);
    return () => mq.removeEventListener?.('change', handler);
  }, [settings.theme]);

  // Configure Google Auth client ID
  useEffect(() => {
    googleAuth.configure(settings.googleClientId);
    return googleAuth.subscribe(setAuthState);
  }, [settings.googleClientId]);

  // Derived maps
  const recordingsByProject = useMemo(() => {
    const map = new Map<string, Recording[]>();
    for (const r of allRecordings) {
      const list = map.get(r.projectId) ?? [];
      list.push(r);
      map.set(r.projectId, list);
    }
    map.forEach((list) =>
      list.sort((a, b) => a.orderIndex - b.orderIndex || a.createdAt - b.createdAt),
    );
    return map;
  }, [allRecordings]);

  const progressByProject = useMemo(() => {
    const map = new Map<string, PlaybackProgress>();
    for (const p of progressList) map.set(p.projectId, p);
    return map;
  }, [progressList]);

  // Sync handlers
  const handleSyncAll = useCallback(
    async (overrideSettings?: AppSettings) => {
      if (isSyncing) return;
      if (!googleAuth.hasValidToken()) {
        setSettingsOpen(true);
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
          handleUpdateSettings({
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
    [handleUpdateSettings, isSyncing, reloadData, showToast],
  );

  const handleSyncProject = useCallback(
    async (projectId: string, silent = false) => {
      if (!googleAuth.hasValidToken()) return;
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
          handleUpdateSettings({
            ...activeSettings,
            driveRootFolderId: res.rootFolderId,
          });
        }
        await reloadData();
        if (!silent) showToast('Book synced to Google Drive');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Drive sync failed';
        setSyncStatusMessage(msg);
        if (!silent) showToast(msg);
      } finally {
        setIsSyncing(false);
      }
    },
    [handleUpdateSettings, reloadData, showToast],
  );

  // Must invoke googleAuth.requestSignIn() synchronously inside button click for iOS PWA
  const handleConnectDrive = (options?: { skipAutoSync?: boolean }) => {
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
        if (!options?.skipAutoSync) {
          await handleSyncAll();
        }
      })
      .catch((err) => {
        showToast(err instanceof Error ? err.message : 'Sign-in cancelled');
      });
  };

  // Multi-user sharing & join handlers
  const clearJoinHash = useCallback(() => {
    if (window.location.hash.includes('/join')) {
      window.location.hash = '#/';
    }
  }, []);

  const handleJoinFolder = useCallback(
    async (options: {
      folderId: string;
      name: string;
      scope: 'library' | 'book';
      role: 'writer' | 'reader';
    }): Promise<{ ok: boolean; needsPicker?: boolean; error?: string }> => {
      if (!googleAuth.hasValidToken()) {
        return { ok: false, error: 'Please connect Google Drive first.' };
      }

      setIsJoiningShare(true);
      try {
        const info = await inspectSharedDriveFolder(options.folderId);
        const resolvedScope = info.scope || options.scope;
        const resolvedRole: 'writer' | 'reader' =
          info.accessRole === 'reader' ? 'reader' : 'writer';
        const resolvedName = info.name || options.name || 'Shared Audiobooks';

        let nextSettings: AppSettings;
        if (resolvedScope === 'book') {
          const existing = settingsRef.current.sharedBookFolders ?? [];
          const nextEntry: SharedBookLink = {
            folderId: info.folderId,
            title: resolvedName,
            role: resolvedRole,
            addedAt: Date.now(),
          };
          const filtered = existing.filter((b) => b.folderId !== info.folderId);
          nextSettings = {
            ...settingsRef.current,
            sharedBookFolders: [...filtered, nextEntry],
          };
        } else {
          nextSettings = {
            ...settingsRef.current,
            driveLibraryMode: 'shared',
            driveRootFolderId: info.folderId,
            driveSharedFolderName: resolvedName,
            driveAccessRole: info.accessRole,
          };
        }

        handleUpdateSettings(nextSettings);
        setPendingJoinInvite(null);
        clearJoinHash();

        await handleSyncAll(nextSettings);
        showToast(
          resolvedScope === 'book'
            ? `Joined shared book "${resolvedName}"`
            : `Connected to shared library "${resolvedName}"`,
        );
        return { ok: true };
      } catch (err) {
        if (err instanceof DriveApiError && (err.status === 404 || err.status === 403)) {
          return {
            ok: false,
            needsPicker: true,
            error:
              'Google Drive requires you to pick this shared folder once so StoryTape can access it safely.',
          };
        }
        const msg =
          err instanceof Error ? err.message : 'Could not link shared folder.';
        showToast(msg);
        return { ok: false, error: msg };
      } finally {
        setIsJoiningShare(false);
      }
    },
    [clearJoinHash, handleSyncAll, handleUpdateSettings, showToast],
  );

  const handleJoinSharedFolderFromSettings = useCallback(
    async (rawInput: string) => {
      const invite = parseJoinInviteInput(rawInput);
      if (!invite) {
        showToast('Paste a valid StoryTape invite link or Google Drive folder URL');
        return;
      }
      if (invite.clientId && !settingsRef.current.googleClientId.trim()) {
        handleUpdateSettings({
          ...settingsRef.current,
          googleClientId: invite.clientId,
        });
      }
      if (!googleAuth.hasValidToken()) {
        setSettingsOpen(false);
        setPendingJoinInvite(invite);
        return;
      }
      const res = await handleJoinFolder(invite);
      if (!res.ok && res.needsPicker) {
        setSettingsOpen(false);
        setPendingJoinInvite(invite);
      }
    },
    [handleJoinFolder, handleUpdateSettings, showToast],
  );

  const handlePickSharedFolder = useCallback(async () => {
    const token = googleAuth.getAccessToken();
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
  }, [handleJoinFolder, showToast]);

  const handleSwitchToPersonalLibrary = useCallback(async () => {
    const nextSettings: AppSettings = {
      ...settingsRef.current,
      driveLibraryMode: 'personal',
      driveRootFolderId: undefined,
      driveSharedFolderName: undefined,
      driveAccessRole: 'owner',
    };
    handleUpdateSettings(nextSettings);
    showToast('Switched back to your personal Drive library');
    if (googleAuth.hasValidToken()) {
      await handleSyncAll(nextSettings);
    }
  }, [handleSyncAll, handleUpdateSettings, showToast]);

  const handleUnlinkSharedBook = useCallback(
    (folderId: string) => {
      const nextLinks = (settingsRef.current.sharedBookFolders ?? []).filter(
        (b) => b.folderId !== folderId,
      );
      handleUpdateSettings({
        ...settingsRef.current,
        sharedBookFolders: nextLinks,
      });
      showToast('Unlinked shared book from Drive sync');
    },
    [handleUpdateSettings, showToast],
  );

  // Book CRUD
  const handleSaveBook = async (data: BookFormSubmission) => {
    const now = Date.now();
    const isEdit = Boolean(editingBook);
    const id = editingBook ? editingBook.id : createId('book');

    let hasCover = editingBook?.hasCover ?? false;
    let coverMimeType = editingBook?.coverMimeType;
    let coverUpdatedAt = editingBook?.coverUpdatedAt;

    if (data.coverChange === 'replace' && data.coverBlob) {
      await putProjectCover(id, data.coverBlob);
      hasCover = true;
      coverMimeType = data.coverMimeType || 'image/jpeg';
      coverUpdatedAt = now;
    } else if (data.coverChange === 'remove') {
      await deleteProjectCover(id);
      hasCover = false;
      coverMimeType = undefined;
      coverUpdatedAt = now;
    }

    const savedProject: BookProject = {
      id,
      title: data.title,
      author: data.author,
      narrator: data.narrator,
      dedicatedTo: data.dedicatedTo,
      description: data.description,
      language: data.language,
      tags: data.tags,
      coverColor: data.coverColor,
      hasCover,
      coverMimeType,
      coverUpdatedAt,
      driveFolderId: editingBook?.driveFolderId,
      driveMetadataFileId: editingBook?.driveMetadataFileId,
      driveCoverFileId:
        data.coverChange === 'remove' ? undefined : editingBook?.driveCoverFileId,
      isShared: editingBook?.isShared ?? settings.driveLibraryMode === 'shared',
      accessRole: editingBook?.accessRole ?? 'owner',
      deletedRecordingIds: editingBook?.deletedRecordingIds,
      syncStatus: googleAuth.hasValidToken() ? 'pending_upload' : 'local_only',
      createdAt: editingBook?.createdAt ?? now,
      updatedAt: now,
    };

    await putProject(savedProject);

    // Remember narrator as handy default for future books
    if (data.narrator && !settings.defaultNarrator) {
      handleUpdateSettings({ ...settings, defaultNarrator: data.narrator });
    }

    await reloadData();
    showToast(isEdit ? 'Book updated' : `"${savedProject.title}" created`);

    if (!isEdit) {
      navigate({ view: 'book', projectId: savedProject.id });
    }

    if (googleAuth.hasValidToken()) {
      void handleSyncProject(savedProject.id, true);
    }
  };

  const handleDeleteBook = async (projectId: string) => {
    if (player.project?.id === projectId) {
      player.closePlayer();
    }
    await deleteProject(projectId);
    await reloadData();
    navigate({ view: 'library' });
    showToast('Book removed from device');
  };

  // Recording saved from Recording Studio
  const handleRecordingSaved = async (
    project: BookProject,
    saved: SavedStudioRecording,
  ) => {
    const existing = recordingsByProject.get(project.id) ?? [];
    const now = Date.now();
    const orderIndex = existing.length;
    const narratorAttribution =
      settings.defaultNarrator.trim() ||
      authState.userName?.trim() ||
      project.narrator.trim() ||
      undefined;

    const rec: Recording = {
      id: createId('rec'),
      projectId: project.id,
      name: saved.name,
      notes: saved.notes,
      recordedBy: narratorAttribution,
      orderIndex,
      durationMs: saved.durationMs,
      mimeType: saved.mimeType,
      extension: saved.extension,
      sampleRate: saved.sampleRate,
      bitrateKbps: saved.bitrateKbps,
      bitDepth: saved.bitDepth,
      channels: saved.channels,
      deviceLabel: saved.deviceLabel,
      fileSizeBytes: saved.blob.size,
      peaks: saved.peaks,
      driveFileName: buildChapterDriveFileName(
        orderIndex,
        saved.name,
        saved.extension,
      ),
      syncStatus: googleAuth.hasValidToken() ? 'pending_upload' : 'local_only',
      createdAt: now,
      updatedAt: now,
    };

    await putRecording(rec, saved.blob);
    await putProject({
      ...project,
      syncStatus: googleAuth.hasValidToken() ? 'pending_upload' : project.syncStatus,
      updatedAt: now,
    });
    await reloadData();
    await player.refreshChaptersForProject(project.id);

    navigate({ view: 'book', projectId: project.id });
    showToast(`Saved "${rec.name}"`);

    if (googleAuth.hasValidToken()) {
      void handleSyncProject(project.id, true);
    }
  };

  const handleRenameRecording = async (
    project: BookProject,
    recordingId: string,
    newName: string,
  ) => {
    const list = recordingsByProject.get(project.id) ?? [];
    const target = list.find((r) => r.id === recordingId);
    if (!target) return;
    const now = Date.now();
    await putRecording({
      ...target,
      name: newName,
      updatedAt: now,
    });
    await putProject({ ...project, updatedAt: now });
    await reloadData();
    await player.refreshChaptersForProject(project.id);
    if (googleAuth.hasValidToken()) {
      void handleSyncProject(project.id, true);
    }
  };

  const handleReorderRecordings = async (
    project: BookProject,
    orderedIds: string[],
  ) => {
    await reorderProjectRecordings(project.id, orderedIds);
    await putProject({ ...project, updatedAt: Date.now() });
    await reloadData();
    await player.refreshChaptersForProject(project.id);
    if (googleAuth.hasValidToken()) {
      void handleSyncProject(project.id, true);
    }
  };

  const resolveRecordingBlob = async (recording: Recording): Promise<Blob | null> => {
    let blob = await getRecordingBlob(recording.id);
    if (!blob && recording.syncStatus === 'cloud_only') {
      blob = await downloadCloudRecording(recording.id);
      await reloadData();
    }
    return blob ?? null;
  };

  const handleDownloadRecording = async (recording: Recording) => {
    try {
      const blob = await resolveRecordingBlob(recording);
      if (!blob) {
        showToast('Audio file not available locally');
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = buildChapterDriveFileName(
        recording.orderIndex,
        recording.name,
        recording.extension,
      );
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Download failed');
    }
  };

  const handleShareRecording = async (
    project: BookProject,
    recording: Recording,
  ) => {
    try {
      const blob = await resolveRecordingBlob(recording);
      if (!blob) {
        showToast('Audio file not available to share');
        return;
      }
      const fileName = buildChapterDriveFileName(
        recording.orderIndex,
        recording.name,
        recording.extension,
      );
      const outcome = await shareAudioChapter({
        blob,
        fileName,
        title: `${project.title} — ${recording.name}`,
        text: `Listen to "${recording.name}" from ${project.title}`,
      });
      if (outcome === 'shared') {
        showToast(`Shared "${recording.name}"`);
      } else if (outcome === 'downloaded') {
        showToast(`Downloaded "${fileName}" to share`);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not share audio');
    }
  };

  const handleDeleteRecording = async (
    project: BookProject,
    recordingId: string,
  ) => {
    await deleteRecording(recordingId);
    const nextDeleted = Array.from(
      new Set([...(project.deletedRecordingIds ?? []), recordingId]),
    );
    await putProject({
      ...project,
      deletedRecordingIds: nextDeleted,
      updatedAt: Date.now(),
    });
    await reloadData();
    await player.refreshChaptersForProject(project.id);
    showToast('Recording deleted');
    if (googleAuth.hasValidToken()) {
      void handleSyncProject(project.id, true);
    }
  };

  const activeBook =
    route.view !== 'library'
      ? projects.find((p) => p.id === route.projectId) ?? null
      : null;

  const shareSheetBook =
    shareTarget?.scope === 'book'
      ? projects.find((p) => p.id === shareTarget.projectId) ?? null
      : null;

  const hasMiniPlayer =
    route.view !== 'record' &&
    Boolean(player.project && player.currentRecording && !player.isExpanded);

  return (
    <>
      {/* Non-intrusive Toast stack + PWA Update notification (never shown mid-recording) */}
      <div className="toast-stack" aria-live="polite">
        {pwaUpdateReady && route.view !== 'record' && onApplyPwaUpdate && (
          <div className="toast">
            <span>A new version of StoryTape is ready.</span>
            <button
              type="button"
              className="toast-action"
              onClick={onApplyPwaUpdate}
            >
              Update
            </button>
          </div>
        )}
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            <span>{t.message}</span>
            {t.actionLabel && t.onAction && (
              <button
                type="button"
                className="toast-action"
                onClick={t.onAction}
              >
                {t.actionLabel}
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Main Route View */}
      {route.view === 'record' && activeBook ? (
        <RecordingStudioView
          project={activeBook}
          existingRecordingCount={(recordingsByProject.get(activeBook.id) ?? []).length}
          settings={settings}
          resumeDraftId={route.draftId}
          onOpenSettings={() => setSettingsOpen(true)}
          onExit={() => {
            void reloadData();
            navigate({ view: 'book', projectId: activeBook.id });
          }}
          onToast={(msg) => showToast(msg)}
          onRecordingSaved={(saved) => handleRecordingSaved(activeBook, saved)}
          engineFactory={engineFactory}
        />
      ) : route.view === 'book' && activeBook ? (
        <ProjectDetailView
          project={activeBook}
          recordings={recordingsByProject.get(activeBook.id) ?? []}
          progress={progressByProject.get(activeBook.id)}
          canSyncDrive={authState.status === 'connected'}
          isSyncing={isSyncing}
          hasMiniPlayer={hasMiniPlayer}
          onBack={() => navigate({ view: 'library' })}
          onEditBook={() => {
            setEditingBook(activeBook);
            setBookEditorOpen(true);
          }}
          onShareBook={() =>
            setShareTarget({ scope: 'book', projectId: activeBook.id })
          }
          onStartRecording={() => {
            player.pauseForRecording();
            navigate({ view: 'record', projectId: activeBook.id });
          }}
          onSyncProject={() => void handleSyncProject(activeBook.id)}
          onRenameRecording={(recId, newName) =>
            handleRenameRecording(activeBook, recId, newName)
          }
          onReorderRecordings={(ids) =>
            handleReorderRecordings(activeBook, ids)
          }
          onDownloadRecording={handleDownloadRecording}
          onShareRecording={(rec) => handleShareRecording(activeBook, rec)}
          onDeleteRecording={(recId) =>
            handleDeleteRecording(activeBook, recId)
          }
        />
      ) : (
        <LibraryView
          projects={projects}
          recordingsByProject={recordingsByProject}
          progressByProject={progressByProject}
          drafts={drafts}
          authState={authState}
          driveLibraryMode={settings.driveLibraryMode}
          driveSharedFolderName={settings.driveSharedFolderName}
          driveAccessRole={settings.driveAccessRole}
          isSyncing={isSyncing}
          hasMiniPlayer={hasMiniPlayer}
          onOpenBook={(projectId) => navigate({ view: 'book', projectId })}
          onNewBook={() => {
            setEditingBook(null);
            setBookEditorOpen(true);
          }}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenShareLibrary={() => setShareTarget({ scope: 'library' })}
          onSyncNow={() => void handleSyncAll()}
          onResumeDraft={(draft) => {
            player.pauseForRecording();
            navigate({
              view: 'record',
              projectId: draft.projectId,
              draftId: draft.id,
            });
          }}
          onDiscardDraft={async (draftId) => {
            await deleteDraft(draftId);
            await reloadData();
            showToast('Unfinished draft discarded');
          }}
          onContinueListening={(book) =>
            void player.playBook(book, { resumeSaved: true, expand: true })
          }
        />
      )}

      {/* Persistent Minimalistic Audiobook Player */}
      <MiniPlayerBar hidden={route.view === 'record'} />
      <AudioPlayerSheet />

      {/* Book Create / Edit Metadata Sheet */}
      <BookEditorSheet
        open={bookEditorOpen}
        initialProject={editingBook}
        defaultNarrator={settings.defaultNarrator}
        onClose={() => setBookEditorOpen(false)}
        onSave={handleSaveBook}
        onDelete={editingBook ? handleDeleteBook : undefined}
      />

      {/* Multi-User Family Sharing & Invite Sheet */}
      <ShareSheet
        open={shareTarget !== null}
        scope={shareTarget?.scope ?? 'library'}
        targetTitle={
          shareTarget?.scope === 'book'
            ? shareSheetBook?.title || 'Audiobook'
            : settings.driveSharedFolderName ||
              settings.driveRootFolderName ||
              'StoryTape Audiobooks'
        }
        folderId={
          shareTarget?.scope === 'book'
            ? shareSheetBook?.driveFolderId
            : settings.driveRootFolderId
        }
        accessRole={
          shareTarget?.scope === 'book'
            ? shareSheetBook?.accessRole
            : settings.driveAccessRole
        }
        isDriveConnected={authState.status === 'connected'}
        onClose={() => setShareTarget(null)}
        onConnectDrive={() => handleConnectDrive({ skipAutoSync: true })}
        onPrepareFolder={async () => {
          if (shareTarget?.scope === 'book' && shareSheetBook) {
            const res = await ensureShareableBookFolder(
              shareSheetBook.id,
              settingsRef.current,
            );
            if (
              res.rootFolderId &&
              res.rootFolderId !== settingsRef.current.driveRootFolderId
            ) {
              handleUpdateSettings({
                ...settingsRef.current,
                driveRootFolderId: res.rootFolderId,
              });
            }
            await reloadData();
            return { folderId: res.folderId, title: res.title };
          }
          const lib = await ensureShareableLibraryFolder(settingsRef.current);
          handleUpdateSettings({
            ...settingsRef.current,
            driveRootFolderId: lib.folderId,
            driveAccessRole: lib.accessRole,
          });
          return { folderId: lib.folderId, title: lib.folderName };
        }}
        onToast={(msg) => showToast(msg)}
      />

      {/* Guided Join Shared Library / Book Modal (from #/join?... invite link) */}
      <JoinShareModal
        open={pendingJoinInvite !== null}
        invite={pendingJoinInvite}
        settings={settings}
        isDriveConnected={authState.status === 'connected'}
        isJoining={isJoiningShare}
        onClose={() => {
          setPendingJoinInvite(null);
          clearJoinHash();
        }}
        onConnectDrive={() => handleConnectDrive({ skipAutoSync: true })}
        onJoinFolder={handleJoinFolder}
        onToast={(msg) => showToast(msg)}
      />

      {/* Audio Quality, Microphone & Drive Settings Sheet */}
      <SettingsSheet
        open={settingsOpen}
        settings={settings}
        authState={authState}
        isSyncing={isSyncing}
        syncStatusMessage={syncStatusMessage}
        onClose={() => setSettingsOpen(false)}
        onUpdateSettings={handleUpdateSettings}
        onConnectDrive={() => handleConnectDrive()}
        onSignOutDrive={() => {
          googleAuth.signOut();
          showToast('Signed out of Google Drive');
        }}
        onSyncAll={() => void handleSyncAll()}
        onOpenShareLibrary={() => {
          setSettingsOpen(false);
          setShareTarget({ scope: 'library' });
        }}
        onJoinSharedFolder={handleJoinSharedFolderFromSettings}
        onPickSharedFolder={handlePickSharedFolder}
        onSwitchToPersonalLibrary={handleSwitchToPersonalLibrary}
        onUnlinkSharedBook={handleUnlinkSharedBook}
        onClearSyncedCache={async () => {
          const count = await clearSyncedAudioCache();
          await reloadData();
          return count;
        }}
        onToast={(msg) => showToast(msg)}
      />
    </>
  );
};

export const App: React.FC<AppProps> = (props) => {
  const [, setProgressTick] = useState(0);
  return (
    <PlayerProvider onProgressUpdated={() => setProgressTick((t) => t + 1)}>
      <StoryTapeShell {...props} />
    </PlayerProvider>
  );
};

export default App;
