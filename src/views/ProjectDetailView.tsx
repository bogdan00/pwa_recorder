import React from 'react';
import {
  ArrowLeft,
  Cloud,
  CloudUpload,
  Headphones,
  Loader2,
  Mic,
  Pencil,
  Share2,
  Users,
} from 'lucide-react';
import type {
  BookProject,
  PlaybackProgress,
  Recording,
} from '../types/models';
import { usePlayer } from '../player/PlayerContext';
import { formatHumanDuration } from '../utils/format';
import { BookCover } from '../components/BookCover';
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
}) => {
  const player = usePlayer();
  const totalMs = recordings.reduce((acc, r) => acc + r.durationMs, 0);
  const completedIds = new Set(progress?.completedRecordingIds ?? []);
  const isReadOnly = project.accessRole === 'reader';

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
                aria-label="Sync book to Google Drive"
              >
                {isSyncing ? (
                  <Loader2 size={14} className="spin" />
                ) : hasPendingSync ? (
                  <CloudUpload size={14} />
                ) : (
                  <Cloud size={14} />
                )}
                {isSyncing
                  ? 'Syncing'
                  : isReadOnly
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
            <div className="project-hero__credits">
              {project.narrator && <span>Read by {project.narrator}</span>}
              {project.dedicatedTo && <span>For {project.dedicatedTo}</span>}
              {project.language && <span>{project.language}</span>}
            </div>

            {(project.tags.length > 0 || project.isShared) && (
              <div className="project-hero__tags">
                {project.isShared && (
                  <span
                    className={`badge ${isReadOnly ? 'badge-amber' : 'badge-sage'}`}
                    data-testid="book-shared-role-badge"
                  >
                    <Users size={11} />
                    {isReadOnly ? 'Shared · Listener' : 'Shared · Co-Narrator'}
                  </span>
                )}
                {project.tags.map((tag) => (
                  <span key={tag} className="badge">
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        </section>

        {project.description && (
          <p className="project-hero__desc">{project.description}</p>
        )}

        {isReadOnly && (
          <div className="project-readonly-banner" role="status">
            <Headphones size={16} />
            <span>
              <strong>Listener mode</strong> — This shared book is read-only. You
              can listen, stream, and download chapters anytime.
            </span>
          </div>
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
