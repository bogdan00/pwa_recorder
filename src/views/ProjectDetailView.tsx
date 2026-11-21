import React from 'react';
import {
  ArrowLeft,
  Cloud,
  CloudUpload,
  Download,
  Headphones,
  Loader2,
  Mic,
  Pencil,
  RefreshCw,
  Share2,
  Trash2,
  Unlock,
  Users,
} from 'lucide-react';
import type {
  BookProject,
  PlaybackProgress,
  Recording,
} from '../types/models';
import { usePlayer } from '../player/PlayerContext';
import { formatBookNarrators, formatHumanDuration } from '../utils/format';
import { BookCover } from '../components/BookCover';
import { useConfirm } from '../components/ConfirmDialogContext';
import { RecordingCard } from '../components/RecordingCard';
import './ProjectDetailView.css';

interface ProjectDetailViewProps {
  project: BookProject;
  recordings: Recording[];
  progress?: PlaybackProgress;
  canSyncDrive: boolean;
  needsReconnectForCloudPlay?: boolean;
  isSyncing: boolean;
  hasMiniPlayer: boolean;
  onBack: () => void;
  onEditBook: () => void;
  onShareBook: () => void;
  onStartRecording: () => void;
  onSyncProject: () => void;
  onReconnectAndPlayChapter?: (recordingId: string) => void;
  onRenameRecording: (recordingId: string, newName: string) => Promise<void>;
  onReorderRecordings: (orderedIds: string[]) => Promise<void>;
  onDownloadRecording: (recording: Recording) => Promise<void>;
  onOpenQualityLab: (recording: Recording) => void;
  onDeleteLocalMaster: (recordingId: string) => Promise<void>;
  onShareRecording: (recording: Recording) => Promise<void>;
  onDeleteRecording: (recordingId: string) => Promise<void>;
  onDetachImportedBook?: () => Promise<void>;
  onRemoveImportedBook?: () => Promise<void>;
}

export const ProjectDetailView: React.FC<ProjectDetailViewProps> = ({
  project,
  recordings,
  progress,
  canSyncDrive,
  needsReconnectForCloudPlay = false,
  isSyncing,
  hasMiniPlayer,
  onBack,
  onEditBook,
  onShareBook,
  onStartRecording,
  onSyncProject,
  onReconnectAndPlayChapter,
  onRenameRecording,
  onReorderRecordings,
  onDownloadRecording,
  onOpenQualityLab,
  onDeleteLocalMaster,
  onShareRecording,
  onDeleteRecording,
  onDetachImportedBook,
  onRemoveImportedBook,
}) => {
  const player = usePlayer();
  const confirm = useConfirm();
  const totalMs = recordings.reduce((acc, r) => acc + r.durationMs, 0);
  const derivedNarrator = formatBookNarrators(recordings);
  const completedIds = new Set(progress?.completedRecordingIds ?? []);
  const isImported = Boolean(project.importedFrom);
  const isDriveReadOnly = project.accessRole === 'reader';
  const isReadOnly = isDriveReadOnly || isImported;

  const hasPendingSync =
    !isReadOnly &&
    (project.syncStatus !== 'synced' ||
      recordings.some(
        (r) =>
          r.syncStatus === 'pending_upload' ||
          r.syncStatus === 'local_only' ||
          r.syncStatus === 'error',
      ));

  const handleMove = async (fromIndex: number, delta: -1 | 1) => {
    const toIndex = fromIndex + delta;
    if (toIndex < 0 || toIndex >= recordings.length) return;
    const ids = recordings.map((r) => r.id);
    const [moved] = ids.splice(fromIndex, 1);
    ids.splice(toIndex, 0, moved);
    await onReorderRecordings(ids);
  };

  return (
    <div
      className={`project-page ${hasMiniPlayer ? 'project-page--with-mini' : ''}`}
    >
      <header className="project-topbar">
        <div className="app-container project-topbar__inner">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onBack}
            aria-label="Back to library"
          >
            <ArrowLeft size={18} />
            Library
          </button>

          <div className="project-topbar__actions">
            {canSyncDrive && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={onSyncProject}
                disabled={isSyncing}
                id="sync-book-btn"
                aria-label={
                  isImported
                    ? 'Check for updates from source book'
                    : 'Sync book to Google Drive'
                }
              >
                {isSyncing ? (
                  <Loader2 size={14} className="spin" />
                ) : isImported ? (
                  <RefreshCw size={14} />
                ) : hasPendingSync ? (
                  <CloudUpload size={14} />
                ) : (
                  <Cloud size={14} />
                )}
                {isSyncing
                  ? 'Syncing'
                  : isImported
                    ? 'Updates'
                    : isDriveReadOnly
                      ? 'Refresh'
                      : hasPendingSync
                        ? 'Sync'
                        : 'Synced'}
              </button>
            )}

            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onShareBook}
              id="share-book-btn"
              aria-label="Share book"
            >
              <Share2 size={14} />
              Share
            </button>

            {!isReadOnly && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={onEditBook}
                id="edit-book-btn"
              >
                <Pencil size={14} />
                Edit
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="app-container project-content">
        {/* Book metadata hero */}
        <section className="project-hero">
          <BookCover
            projectId={project.id}
            title={project.title}
            author={project.author}
            coverColor={project.coverColor}
            hasCover={project.hasCover}
            coverUpdatedAt={project.coverUpdatedAt}
            className="project-hero__cover"
          />

          <div className="project-hero__info">
            <h1 className="project-hero__title">{project.title}</h1>
            {project.author && (
              <p className="project-hero__author">by {project.author}</p>
            )}
            {derivedNarrator && (
              <div className="project-hero__credits">
                <span>Read by {derivedNarrator}</span>
              </div>
            )}

            {(isImported || project.isShared) && (
              <div className="project-hero__tags">
                {isImported ? (
                  <span
                    className={`badge ${
                      project.importedFrom?.sourceUnavailable
                        ? 'badge-amber'
                        : 'badge-sage'
                    }`}
                    data-testid="book-imported-badge"
                  >
                    <Download size={11} />
                    {project.importedFrom?.sourceUnavailable
                      ? 'Imported · Source Unavailable'
                      : 'Imported Copy'}
                  </span>
                ) : (
                  <span
                    className={`badge ${isDriveReadOnly ? 'badge-amber' : 'badge-sage'}`}
                    data-testid="book-shared-role-badge"
                  >
                    <Users size={11} />
                    {isDriveReadOnly ? 'Shared · Listener' : 'Shared · Co-Narrator'}
                  </span>
                )}
              </div>
            )}
          </div>
        </section>

        {project.description && (
          <p className="project-hero__desc">{project.description}</p>
        )}

        {isImported ? (
          <div
            className={`project-imported-banner ${
              project.importedFrom?.sourceUnavailable
                ? 'project-imported-banner--unavailable'
                : ''
            }`}
            role="status"
            data-testid="project-imported-banner"
          >
            <div className="project-imported-banner__text">
              <Download size={16} />
              <span>
                {project.importedFrom?.sourceUnavailable ? (
                  <>
                    <strong>Original source unavailable</strong> — The shared
                    source folder can no longer be reached, but your copied
                    audiobook stays safely stored in your library.
                  </>
                ) : (
                  <>
                    <strong>Imported copy</strong> — Stored in your library so
                    everyone sharing your library can listen. New chapters
                    mirror automatically when you sync.
                  </>
                )}
              </span>
            </div>
            {!isDriveReadOnly && (onDetachImportedBook || onRemoveImportedBook) && (
              <div className="project-imported-banner__actions">
                {onDetachImportedBook && (
                  <button
                    type="button"
                    id="detach-imported-book-btn"
                    className="btn btn-secondary btn-sm"
                    onClick={() =>
                      confirm({
                        title: 'Detach & Make Editable?',
                        description: (
                          <>
                            Stop mirroring updates from the original creator for{' '}
                            <strong>{project.title}</strong> and unlock
                            recording and editing on your copy?
                          </>
                        ),
                        confirmLabel: 'Make Editable',
                        tone: 'warning',
                        onConfirm: async () => {
                          await onDetachImportedBook();
                        },
                      })
                    }
                  >
                    <Unlock size={13} />
                    Make Editable
                  </button>
                )}
                {onRemoveImportedBook && (
                  <button
                    type="button"
                    id="remove-imported-book-btn"
                    className="btn btn-ghost btn-sm"
                    onClick={() =>
                      confirm({
                        title: 'Remove Imported Copy?',
                        description: (
                          <>
                            Remove your copied version of{' '}
                            <strong>{project.title}</strong> from your library
                            and Google Drive? The original creator&apos;s book
                            will not be affected.
                          </>
                        ),
                        confirmLabel: 'Remove Copy',
                        tone: 'danger',
                        onConfirm: async () => {
                          await onRemoveImportedBook();
                        },
                      })
                    }
                  >
                    <Trash2 size={13} />
                    Remove Copy
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          isDriveReadOnly && (
            <div className="project-readonly-banner" role="status">
              <Headphones size={16} />
              <span>
                <strong>Listener mode</strong> — This shared book is read-only.
                You can listen, stream, and download chapters anytime.
              </span>
            </div>
          )
        )}

        {/* Primary Listen + Record CTAs */}
        <div
          className={`project-cta-row ${recordings.length > 0 && !isReadOnly ? 'project-cta-row--dual' : ''}`}
        >
          {recordings.length > 0 && (
            <button
              type="button"
              className={`btn ${isReadOnly ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() =>
                void player.playBook(project, {
                  resumeSaved: true,
                  expand: true,
                })
              }
              id="listen-book-btn"
            >
              <Headphones size={18} />
              {progress ? 'Continue' : 'Listen'}
            </button>
          )}

          {!isReadOnly && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={onStartRecording}
              id="record-chapter-btn"
            >
              <Mic size={18} />
              {recordings.length > 0 ? 'Record Chapter' : 'Record First Chapter'}
            </button>
          )}
        </div>

        {/* Chapters list */}
        <section className="chapters-section" aria-label="Recorded chapters">
          <div className="chapters-section__header">
            <h2 className="chapters-section__title">Chapters</h2>
            <span className="chapters-section__summary">
              {recordings.length}{' '}
              {recordings.length === 1 ? 'recording' : 'recordings'}
              {totalMs > 0 ? ` · ${formatHumanDuration(totalMs)}` : ''}
            </span>
          </div>

          {recordings.length === 0 ? (
            <div className="chapters-empty">
              {isReadOnly ? (
                <>No chapters have been uploaded to this shared book yet.</>
              ) : (
                <>
                  No chapters recorded yet. Tap <strong>Record First Chapter</strong>{' '}
                  above to open the recording studio.
                </>
              )}
            </div>
          ) : (
            <div className="chapters-list">
              {recordings.map((rec, idx) => {
                const isActive = player.currentRecording?.id === rec.id;
                return (
                  <RecordingCard
                    key={rec.id}
                    recording={rec}
                    index={idx}
                    totalCount={recordings.length}
                    isActive={isActive}
                    isPlaying={isActive && player.isPlaying}
                    isLoading={isActive && player.isLoading}
                    isCompleted={completedIds.has(rec.id)}
                    canSyncDrive={canSyncDrive}
                    isReadOnly={isReadOnly}
                    onPlay={() => {
                      if (
                        rec.syncStatus === 'cloud_only' &&
                        needsReconnectForCloudPlay &&
                        onReconnectAndPlayChapter
                      ) {
                        onReconnectAndPlayChapter(rec.id);
                        return;
                      }
                      void player.playChapter(project, recordings, rec.id, false);
                    }}
                    onRename={(newName) => onRenameRecording(rec.id, newName)}
                    onMoveUp={() => handleMove(idx, -1)}
                    onMoveDown={() => handleMove(idx, 1)}
                    onDownloadLocal={() => onDownloadRecording(rec)}
                    onOpenQualityLab={() => onOpenQualityLab(rec)}
                    onDeleteLocalMaster={() => onDeleteLocalMaster(rec.id)}
                    onShareAudio={() => onShareRecording(rec)}
                    onRetrySync={async () => onSyncProject()}
                    onDelete={() => onDeleteRecording(rec.id)}
                  />
                );
              })}
            </div>
          )}
        </section>
      </main>
    </div>
  );
};
