import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AppSettings,
  BookProject,
  PlaybackProgress,
  Recording,
} from './types/models';
import {
  clearAllLocalMasters,
  clearSyncedAudioCache,
  deleteDraft,
  deleteProject,
  deleteProjectCover,
  deleteRecording,
  deleteRecordingMaster,
  getRecordingBlob,
  putProject,
  putProjectCover,
  putRecording,
  putRecordingBlob,
  reorderProjectRecordings,
} from './storage/db';
import {
  applyThemeToDocument,
  loadSettings,
  saveSettings,
} from './storage/settings';
import { googleAuth } from './drive/googleAuth';
import { shareAudioChapter } from './drive/shareUtils';
import {
  downloadCloudRecording,
  ensureShareableBookFolder,
  ensureShareableLibraryFolder,
} from './drive/syncService';
import { PlayerProvider, usePlayer } from './player/PlayerContext';
import { preparePlayableAudioBlob } from './player/playbackBlob';
import { downloadBlob } from './utils/blob';
import {
  buildChapterDriveFileName,
  createId,
  formatBytes,
  formatDurationMs,
} from './utils/format';
import {
  BookEditorSheet,
  type BookFormSubmission,
} from './components/BookEditorSheet';
import { AudioPlayerSheet } from './components/AudioPlayerSheet';
import {
  ConfirmProvider,
  useConfirm,
} from './components/ConfirmDialogContext';
import { IosInstallGuideModal } from './components/IosInstallGuideModal';
import { JoinShareModal } from './components/JoinShareModal';
import { MiniPlayerBar } from './components/MiniPlayerBar';
import { ShareSheet } from './components/ShareSheet';
import { ThemeSwitcherSheet } from './components/ThemeSwitcherSheet';
import {
  canAutoSyncDrive,
  useDriveSync,
} from './hooks/useDriveSync';
import { useHashRoute } from './hooks/useHashRoute';
import { useLibraryData } from './hooks/useLibraryData';
import { useToasts } from './hooks/useToasts';
import {
  pwaInstallController,
  type PwaInstallState,
} from './pwa/installPrompt';
import { LibraryView } from './views/LibraryView';
import { ProjectDetailView } from './views/ProjectDetailView';
import { QualityCompareView } from './views/QualityCompareView';
import {
  RecordingStudioView,
  type SavedStudioRecording,
} from './views/RecordingStudioView';
import { SettingsSheet, type SettingsTab } from './views/SettingsSheet';
import type { CapturedMicTestAudio } from './audio/audioDevices';
import type { RecordingEngine } from './audio/recordingEngine';

type ShareTarget =
  | { scope: 'library' }
  | { scope: 'book'; projectId: string };

export interface AppProps {
  onApplyPwaUpdate?: () => void;
  pwaUpdateReady?: boolean;
  engineFactory?: (projectId: string) => RecordingEngine;
}

interface StoryTapeShellProps extends AppProps {
  registerProgressHandler: (fn: (progress: PlaybackProgress) => void) => void;
}

const StoryTapeShell: React.FC<StoryTapeShellProps> = ({
  onApplyPwaUpdate,
  pwaUpdateReady,
  engineFactory,
  registerProgressHandler,
}) => {
  const player = usePlayer();
  const confirm = useConfirm();
  const { toasts, showToast } = useToasts();
  const {
    route,
    navigate,
    pendingJoinInvite,
    setPendingJoinInvite,
    clearJoinHash,
  } = useHashRoute();
  const {
    projects,
    allRecordings,
    drafts,
    recordingsByProject,
    progressByProject,
    reloadData,
    upsertProgress,
  } = useLibraryData();

  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Modals & transient status
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] =
    useState<SettingsTab>('recording');
  const [themeSwitcherOpen, setThemeSwitcherOpen] = useState(false);
  const [iosInstallGuideOpen, setIosInstallGuideOpen] = useState(false);
  const [pwaInstallState, setPwaInstallState] = useState<PwaInstallState>(() =>
    pwaInstallController.getState(),
  );
  const [bookEditorOpen, setBookEditorOpen] = useState(false);
  const [editingBook, setEditingBook] = useState<BookProject | null>(null);
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
  const [micTestCapture, setMicTestCapture] =
    useState<CapturedMicTestAudio | null>(null);

  const openSettings = useCallback((tab: SettingsTab = 'recording') => {
    setSettingsInitialTab(tab);
    setSettingsOpen(true);
  }, []);

  useEffect(() => {
    registerProgressHandler(upsertProgress);
  }, [registerProgressHandler, upsertProgress]);

  useEffect(() => {
    setPwaInstallState(pwaInstallController.getState());
    return pwaInstallController.subscribe(setPwaInstallState);
  }, []);

  const handleUpdateSettings = useCallback((next: AppSettings) => {
    settingsRef.current = next;
    setSettings(next);
    saveSettings(next);
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

  const drive = useDriveSync({
    settingsRef,
    googleClientId: settings.googleClientId,
    onUpdateSettings: handleUpdateSettings,
    reloadData,
    showToast,
    onOpenSettings: () => openSettings('drive'),
    onCloseSettings: () => setSettingsOpen(false),
    onSetPendingJoinInvite: setPendingJoinInvite,
    onClearJoinHash: clearJoinHash,
  });

  const handleInstallApp = useCallback(() => {
    const current = pwaInstallController.getState();
    if (current.canPromptNative) {
      // Invoke browser install prompt synchronously within the user tap handler
      void pwaInstallController.triggerNativeInstall().then((outcome) => {
        if (outcome === 'accepted') {
          showToast('StoryTape installed to your Home Screen!');
        }
      });
      return;
    }
    if (current.isIosManualInstall) {
      setSettingsOpen(false);
      setIosInstallGuideOpen(true);
    }
  }, [showToast]);

  const notifySavedWithOptionalReconnect = (
    message: string,
    projectId: string,
    canAutoSync: boolean,
  ) => {
    if (!canAutoSync && googleAuth.getState().wasConnected) {
      showToast(message, 'Reconnect & Sync', () =>
        drive.handleConnectDrive({
          skipAutoSync: true,
          onConnected: () => drive.handleSyncProject(projectId),
        }),
      );
    } else {
      showToast(message);
    }
  };

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

    const canAutoSync = canAutoSyncDrive();
    const hasLinkedDrive = canAutoSync || googleAuth.getState().wasConnected;

    const savedProject: BookProject = {
      id,
      title: data.title,
      author: data.author,
      narrator: '',
      dedicatedTo: '',
      description: data.description,
      language: '',
      tags: [],
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
      importedFrom: editingBook?.importedFrom,
      deletedRecordingIds: editingBook?.deletedRecordingIds,
      syncStatus: hasLinkedDrive ? 'pending_upload' : 'local_only',
      createdAt: editingBook?.createdAt ?? now,
      updatedAt: now,
    };

    await putProject(savedProject);

    await reloadData();
    notifySavedWithOptionalReconnect(
      isEdit ? 'Book updated' : `"${savedProject.title}" created`,
      savedProject.id,
      canAutoSync,
    );

    if (!isEdit) {
      navigate({ view: 'book', projectId: savedProject.id });
    }
    if (canAutoSync) {
      void drive.handleSyncProject(savedProject.id, true);
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
      drive.authState.userName?.trim() ||
      undefined;
    const canAutoSync = canAutoSyncDrive();
    const hasLinkedDrive = canAutoSync || googleAuth.getState().wasConnected;

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
      hasLocalMaster: Boolean(saved.localMaster),
      localMasterBytes: saved.localMaster?.blob.size,
      localMasterSampleRate: saved.localMaster?.sampleRate,
      localMasterBitDepth: saved.localMaster?.bitDepth,
      localMasterChannels: saved.localMaster?.channels,
      driveFileName: buildChapterDriveFileName(
        orderIndex,
        saved.name,
        saved.extension,
      ),
      syncStatus: hasLinkedDrive ? 'pending_upload' : 'local_only',
      createdAt: now,
      updatedAt: now,
    };

    await putRecording(rec, saved.blob, saved.localMaster?.blob);
    await putProject({
      ...project,
      syncStatus: hasLinkedDrive ? 'pending_upload' : project.syncStatus,
      updatedAt: now,
    });
    await reloadData();
    await player.refreshChaptersForProject(project.id);

    navigate({ view: 'book', projectId: project.id });
    notifySavedWithOptionalReconnect(
      saved.localMaster
        ? `Saved "${rec.name}" + local lossless master`
        : `Saved "${rec.name}"`,
      project.id,
      canAutoSync,
    );

    if (canAutoSync) {
      void drive.handleSyncProject(project.id, true);
    }
  };

  const handleDeleteLocalMaster = async (recordingId: string) => {
    const rec = allRecordings.find((r) => r.id === recordingId);
    confirm({
      title: 'Delete Local Lossless Master?',
      description: (
        <>
          Permanently delete the uncompressed 32-bit Float WAV master for{' '}
          <strong>{rec?.name || 'this chapter'}</strong>
          {rec?.localMasterBytes ? ` (${formatBytes(rec.localMasterBytes)})` : ''}?
          Your regular chapter audio will remain playable and synced, but the
          lossless master cannot be recovered.
        </>
      ),
      confirmLabel: 'Delete Master',
      tone: 'danger',
      onConfirm: async () => {
        await deleteRecordingMaster(recordingId);
        await reloadData();
        showToast('Deleted local lossless master (chapter audio kept)');
      },
    });
  };

  const handleRenameRecording = async (
    project: BookProject,
    recordingId: string,
    newName: string,
  ) => {
    const target = (recordingsByProject.get(project.id) ?? []).find(
      (r) => r.id === recordingId,
    );
    if (!target) return;
    const now = Date.now();
    await putRecording({ ...target, name: newName, updatedAt: now });
    await putProject({ ...project, updatedAt: now });
    await reloadData();
    await player.refreshChaptersForProject(project.id);
    if (canAutoSyncDrive()) {
      void drive.handleSyncProject(project.id, true);
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
    if (canAutoSyncDrive()) {
      void drive.handleSyncProject(project.id, true);
    }
  };

  const resolveRecordingBlob = async (recording: Recording): Promise<Blob | null> => {
    let blob = await getRecordingBlob(recording.id);
    if (!blob && recording.syncStatus === 'cloud_only') {
      blob = await downloadCloudRecording(recording.id);
      await reloadData();
    }
    if (!blob) return null;
    const prepared = await preparePlayableAudioBlob(blob, recording);
    if (prepared.repaired) {
      void putRecordingBlob(recording.id, prepared.blob).catch(() => {});
    }
    return prepared.blob;
  };

  const handleDownloadRecording = async (recording: Recording) => {
    try {
      const blob = await resolveRecordingBlob(recording);
      if (!blob) {
        showToast('Audio file not available locally');
        return;
      }
      downloadBlob(
        blob,
        buildChapterDriveFileName(
          recording.orderIndex,
          recording.name,
          recording.extension,
        ),
      );
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
      if (outcome === 'shared') showToast(`Shared "${recording.name}"`);
      else if (outcome === 'downloaded') {
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
    const rec = (recordingsByProject.get(project.id) ?? []).find(
      (r) => r.id === recordingId,
    );
    confirm({
      title: 'Delete Recording?',
      description: (
        <>
          Permanently delete <strong>{rec?.name || 'this recording'}</strong>?
          This removes the audio
          {rec?.hasLocalMaster ? ' and its local lossless master' : ''} from this
          device
          {canAutoSyncDrive()
            ? ' and marks it deleted on Google Drive sync'
            : ''}
          . This cannot be undone.
        </>
      ),
      confirmLabel: 'Delete Recording',
      tone: 'danger',
      onConfirm: async () => {
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
        if (canAutoSyncDrive()) {
          void drive.handleSyncProject(project.id, true);
        }
      },
    });
  };

  const activeBook =
    route.view !== 'library' && route.view !== 'mic-compare'
      ? projects.find((p) => p.id === route.projectId) ?? null
      : null;

  const activeCompareRecording =
    route.view === 'compare' && activeBook
      ? (recordingsByProject.get(activeBook.id) ?? []).find(
          (r) => r.id === route.recordingId,
        ) ?? null
      : null;

  const shareSheetBook =
    shareTarget?.scope === 'book'
      ? projects.find((p) => p.id === shareTarget.projectId) ?? null
      : null;

  const hideMiniPlayer =
    route.view === 'record' ||
    route.view === 'compare' ||
    route.view === 'mic-compare';

  const hasMiniPlayer =
    !hideMiniPlayer &&
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
          onOpenSettings={() => openSettings('recording')}
          onExit={() => {
            void reloadData();
            navigate({ view: 'book', projectId: activeBook.id });
          }}
          onToast={(msg) => showToast(msg)}
          onRecordingSaved={(saved) => handleRecordingSaved(activeBook, saved)}
          engineFactory={engineFactory}
        />
      ) : route.view === 'mic-compare' ? (
        <QualityCompareView
          micTestMode
          audioDevice={settings.audioDevice}
          initialMicCapture={micTestCapture}
          onMicCaptureChange={setMicTestCapture}
          onOpenSettings={() => openSettings('recording')}
          audioQuality={settings.audioQuality}
          hasMiniPlayer={hasMiniPlayer}
          onBack={() => navigate({ view: 'library' })}
          onApplyRecommendedQuality={(nextQuality) =>
            handleUpdateSettings({
              ...settingsRef.current,
              audioQuality: nextQuality,
            })
          }
          onToast={(msg) => showToast(msg)}
        />
      ) : route.view === 'compare' && activeBook && activeCompareRecording ? (
        <QualityCompareView
          project={activeBook}
          recording={activeCompareRecording}
          audioQuality={settings.audioQuality}
          hasMiniPlayer={hasMiniPlayer}
          onBack={() => navigate({ view: 'book', projectId: activeBook.id })}
          onApplyRecommendedQuality={(nextQuality) =>
            handleUpdateSettings({
              ...settingsRef.current,
              audioQuality: nextQuality,
            })
          }
          onDeleteLocalMaster={handleDeleteLocalMaster}
          onResolveCloudBlob={resolveRecordingBlob}
          onToast={(msg) => showToast(msg)}
        />
      ) : route.view === 'book' && activeBook ? (
        <ProjectDetailView
          project={activeBook}
          recordings={recordingsByProject.get(activeBook.id) ?? []}
          progress={progressByProject.get(activeBook.id)}
          canSyncDrive={
            drive.authState.status === 'connected' ||
            drive.authState.status === 'expired'
          }
          needsReconnectForCloudPlay={
            drive.authState.status === 'expired' &&
            !drive.authState.hasPersistentRefresh
          }
          isSyncing={drive.isSyncing}
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
          onSyncProject={() => drive.handleSyncOrReconnectProject(activeBook.id)}
          onReconnectAndPlayChapter={(recordingId) => {
            const book = activeBook;
            const chapters = recordingsByProject.get(book.id) ?? [];
            drive.handleConnectDrive({
              skipAutoSync: true,
              onConnected: async () => {
                await player.playChapter(book, chapters, recordingId, false);
                await reloadData();
              },
            });
          }}
          onRenameRecording={(recId, newName) =>
            handleRenameRecording(activeBook, recId, newName)
          }
          onReorderRecordings={(ids) =>
            handleReorderRecordings(activeBook, ids)
          }
          onDownloadRecording={handleDownloadRecording}
          onOpenQualityLab={(rec) => {
            player.pauseForRecording();
            navigate({
              view: 'compare',
              projectId: activeBook.id,
              recordingId: rec.id,
            });
          }}
          onDeleteLocalMaster={handleDeleteLocalMaster}
          onShareRecording={(rec) => handleShareRecording(activeBook, rec)}
          onDeleteRecording={(recId) =>
            handleDeleteRecording(activeBook, recId)
          }
          onDetachImportedBook={() =>
            drive.handleDetachImportedBook(activeBook.id)
          }
          onRemoveImportedBook={() => {
            if (player.project?.id === activeBook.id) {
              player.closePlayer();
            }
            return drive.handleRemoveImportedBook(activeBook.id, () =>
              navigate({ view: 'library' }),
            );
          }}
        />
      ) : (
        <LibraryView
          projects={projects}
          recordingsByProject={recordingsByProject}
          progressByProject={progressByProject}
          drafts={drafts}
          authState={drive.authState}
          driveLibraryMode={settings.driveLibraryMode}
          driveSharedFolderName={settings.driveSharedFolderName}
          driveAccessRole={settings.driveAccessRole}
          isSyncing={drive.isSyncing}
          hasMiniPlayer={hasMiniPlayer}
          showInstallBanner={pwaInstallState.showBanner}
          installPromptMode={
            pwaInstallState.canPromptNative
              ? 'native'
              : pwaInstallState.isIosManualInstall
                ? 'ios'
                : null
          }
          onInstallApp={handleInstallApp}
          onDismissInstallBanner={() => pwaInstallController.dismissBanner()}
          onOpenBook={(projectId) => navigate({ view: 'book', projectId })}
          onNewBook={() => {
            setEditingBook(null);
            setBookEditorOpen(true);
          }}
          onOpenThemeSwitcher={() => setThemeSwitcherOpen(true)}
          onOpenSettings={openSettings}
          onOpenShareLibrary={() => setShareTarget({ scope: 'library' })}
          onSyncNow={drive.handleSyncOrReconnectAll}
          onReconnectDrive={() => drive.handleConnectDrive()}
          onResumeDraft={(draft) => {
            player.pauseForRecording();
            navigate({
              view: 'record',
              projectId: draft.projectId,
              draftId: draft.id,
            });
          }}
          onDiscardDraft={(draftId) => {
            const draft = drafts.find((d) => d.id === draftId);
            const draftBook = draft
              ? projects.find((p) => p.id === draft.projectId)
              : undefined;
            const draftDurationMs =
              draft && draft.sampleRate > 0
                ? Math.round((draft.totalFrames / draft.sampleRate) * 1000)
                : 0;
            confirm({
              title: 'Discard Unfinished Draft?',
              description: (
                <>
                  Permanently discard the unsaved recording draft
                  {draftBook ? (
                    <>
                      {' '}
                      for <strong>{draftBook.title}</strong>
                    </>
                  ) : null}
                  {draftDurationMs > 0
                    ? ` (${formatDurationMs(draftDurationMs)})`
                    : ''}
                  ? This cannot be undone.
                </>
              ),
              confirmLabel: 'Discard Draft',
              tone: 'danger',
              onConfirm: async () => {
                await deleteDraft(draftId);
                await reloadData();
                showToast('Unfinished draft discarded');
              },
            });
          }}
          onContinueListening={(book) =>
            void player.playBook(book, { resumeSaved: true, expand: true })
          }
        />
      )}

      {/* Persistent Minimalistic Audiobook Player */}
      <MiniPlayerBar hidden={hideMiniPlayer} />
      <AudioPlayerSheet />

      {/* Book Create / Edit Metadata Sheet */}
      <BookEditorSheet
        open={bookEditorOpen}
        initialProject={editingBook}
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
        isDriveConnected={drive.authState.status === 'connected'}
        onClose={() => setShareTarget(null)}
        onConnectDrive={() => drive.handleConnectDrive({ skipAutoSync: true })}
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
        isDriveConnected={drive.authState.status === 'connected'}
        isJoining={drive.isJoiningShare}
        canImportToLibrary={
          !(
            settings.driveLibraryMode === 'shared' &&
            settings.driveAccessRole === 'reader'
          )
        }
        onClose={() => {
          setPendingJoinInvite(null);
          clearJoinHash();
        }}
        onConnectDrive={() => drive.handleConnectDrive({ skipAutoSync: true })}
        onJoinFolder={drive.handleJoinFolder}
        onToast={(msg) => showToast(msg)}
      />

      {/* Audio Quality, Microphone & Drive Settings Sheet */}
      <SettingsSheet
        open={settingsOpen}
        initialTab={settingsInitialTab}
        settings={settings}
        authState={drive.authState}
        pwaInstallState={pwaInstallState}
        isSyncing={drive.isSyncing}
        syncStatusMessage={drive.syncStatusMessage}
        lastMicCapture={micTestCapture}
        onMicTestCaptured={setMicTestCapture}
        onOpenMicQualityLab={(clip) => {
          if (clip) setMicTestCapture(clip);
          player.pauseForRecording();
          setSettingsOpen(false);
          navigate({ view: 'mic-compare' });
        }}
        onOpenThemeSwitcher={() => setThemeSwitcherOpen(true)}
        onClose={() => setSettingsOpen(false)}
        onUpdateSettings={handleUpdateSettings}
        onInstallApp={handleInstallApp}
        onConnectDrive={() => drive.handleConnectDrive()}
        onSignOutDrive={() => {
          googleAuth.signOut();
          showToast('Signed out of Google Drive');
        }}
        onSyncAll={drive.handleSyncOrReconnectAll}
        onOpenShareLibrary={() => {
          setSettingsOpen(false);
          setShareTarget({ scope: 'library' });
        }}
        onJoinSharedFolder={drive.handleJoinSharedFolderFromSettings}
        onPickSharedFolder={drive.handlePickSharedFolder}
        onSwitchToPersonalLibrary={drive.handleSwitchToPersonalLibrary}
        onUnlinkSharedBook={drive.handleUnlinkSharedBook}
        onClearSyncedCache={async () => {
          const count = await clearSyncedAudioCache();
          await reloadData();
          return count;
        }}
        onClearLocalMasters={async () => {
          const res = await clearAllLocalMasters();
          await reloadData();
          return res;
        }}
        onToast={(msg) => showToast(msg)}
      />

      {/* 1-Tap Color Theme Switcher Sheet */}
      <ThemeSwitcherSheet
        open={themeSwitcherOpen}
        currentTheme={settings.theme}
        onSelectTheme={(theme) =>
          handleUpdateSettings({ ...settingsRef.current, theme })
        }
        onClose={() => setThemeSwitcherOpen(false)}
      />

      {/* iOS / iPadOS Add to Home Screen Guide */}
      <IosInstallGuideModal
        open={iosInstallGuideOpen}
        onClose={() => setIosInstallGuideOpen(false)}
      />
    </>
  );
};

export const App: React.FC<AppProps> = (props) => {
  const progressHandlerRef = useRef<((progress: PlaybackProgress) => void) | null>(
    null,
  );
  const registerProgressHandler = useCallback(
    (fn: (progress: PlaybackProgress) => void) => {
      progressHandlerRef.current = fn;
    },
    [],
  );
  const handleProgressUpdated = useCallback((progress: PlaybackProgress) => {
    progressHandlerRef.current?.(progress);
  }, []);

  return (
    <ConfirmProvider>
      <PlayerProvider onProgressUpdated={handleProgressUpdated}>
        <StoryTapeShell
          {...props}
          registerProgressHandler={registerProgressHandler}
        />
      </PlayerProvider>
    </ConfirmProvider>
  );
};

export default App;
