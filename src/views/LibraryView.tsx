import React, { useMemo, useState } from 'react';
import {
  BookOpen,
  Cloud,
  CloudOff,
  CloudUpload,
  Download,
  Loader2,
  Palette,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Users,
  X,
} from 'lucide-react';
import type {
  ActiveDraft,
  BookProject,
  DriveLibraryMode,
  PlaybackProgress,
  Recording,
  ShareAccessRole,
} from '../types/models';
import type { GoogleAuthState } from '../drive/googleAuth';
import { formatDurationMs, formatHumanDuration } from '../utils/format';
import { BookCover } from '../components/BookCover';
import type { SettingsTab } from './SettingsSheet';
import './LibraryView.css';

interface LibraryViewProps {
  projects: BookProject[];
  recordingsByProject: Map<string, Recording[]>;
  progressByProject: Map<string, PlaybackProgress>;
  drafts: ActiveDraft[];
  authState: GoogleAuthState;
  driveLibraryMode?: DriveLibraryMode;
  driveSharedFolderName?: string;
  driveAccessRole?: ShareAccessRole;
  isSyncing: boolean;
  hasMiniPlayer: boolean;
  showInstallBanner?: boolean;
  installPromptMode?: 'native' | 'ios' | null;
  onInstallApp?: () => void;
  onDismissInstallBanner?: () => void;
  onOpenBook: (projectId: string) => void;
  onNewBook: () => void;
  onOpenThemeSwitcher: () => void;
  onOpenSettings: (tab?: SettingsTab) => void;
  onOpenShareLibrary: () => void;
  onSyncNow: () => void;
  onReconnectDrive?: () => void;
  onResumeDraft: (draft: ActiveDraft) => void;
  onDiscardDraft: (draftId: string) => void;
  onContinueListening: (project: BookProject) => void;
}

type SortKey = 'updated' | 'title' | 'newest';

export const LibraryView: React.FC<LibraryViewProps> = ({
  projects,
  recordingsByProject,
  progressByProject,
  drafts,
  authState,
  driveLibraryMode = 'personal',
  driveSharedFolderName,
  driveAccessRole = 'owner',
  isSyncing,
  hasMiniPlayer,
  showInstallBanner = false,
  installPromptMode = null,
  onInstallApp,
  onDismissInstallBanner,
  onOpenBook,
  onNewBook,
  onOpenThemeSwitcher,
  onOpenSettings,
  onOpenShareLibrary,
  onSyncNow,
  onReconnectDrive,
  onResumeDraft,
  onDiscardDraft,
  onContinueListening,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('updated');

  const pendingCount = useMemo(() => {
    let count = 0;
    recordingsByProject.forEach((recs) => {
      for (const r of recs) {
        if (
          r.syncStatus === 'pending_upload' ||
          r.syncStatus === 'local_only' ||
          r.syncStatus === 'error'
        ) {
          count += 1;
        }
      }
    });
    return count;
  }, [recordingsByProject]);

  // Most recent in-progress audiobook for Continue Listening banner
  const continueTarget = useMemo(() => {
    let best: {
      project: BookProject;
      recording: Recording;
      progress: PlaybackProgress;
    } | null = null;

    for (const p of projects) {
      const prog = progressByProject.get(p.id);
      if (!prog) continue;
      const recs = recordingsByProject.get(p.id) ?? [];
      const rec = recs.find((r) => r.id === prog.recordingId);
      if (!rec) continue;
      if (!best || prog.updatedAt > best.progress.updatedAt) {
        best = { project: p, recording: rec, progress: prog };
      }
    }
    return best;
  }, [projects, progressByProject, recordingsByProject]);

  const filteredProjects = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = projects.filter((p) => {
      if (!q) return true;
      const recs = recordingsByProject.get(p.id) ?? [];
      const inBook =
        p.title.toLowerCase().includes(q) ||
        p.author.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q);
      const inChapters = recs.some(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.notes.toLowerCase().includes(q) ||
          (r.recordedBy?.toLowerCase().includes(q) ?? false),
      );
      return inBook || inChapters;
    });

    const sorted = filtered.slice();
    if (sortBy === 'title') {
      sorted.sort((a, b) => a.title.localeCompare(b.title));
    } else if (sortBy === 'newest') {
      sorted.sort((a, b) => b.createdAt - a.createdAt);
    } else {
      sorted.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    return sorted;
  }, [projects, recordingsByProject, searchQuery, sortBy]);

  const latestDraft = drafts[0] ?? null;
  const draftBook = latestDraft
    ? projects.find((p) => p.id === latestDraft.projectId)
    : null;

  const baseIconUrl = `${import.meta.env.BASE_URL}icons/icon-192.png`;

  return (
    <div
      className={`library-page ${hasMiniPlayer ? 'library-page--with-mini' : ''}`}
    >
      <header className="library-header">
        <div className="app-container library-header__inner">
          <div className="brand-mark">
            <img
              src={baseIconUrl}
              alt=""
              className="brand-mark__icon"
              aria-hidden="true"
            />
            <h1 className="brand-mark__title">StoryTape</h1>
          </div>

          <div className="library-header__actions">
            <button
              type="button"
              className={`drive-pill ${
                authState.status === 'connected'
                  ? pendingCount > 0
                    ? 'drive-pill--pending'
                    : 'drive-pill--connected'
                  : authState.status === 'expired'
                    ? 'drive-pill--pending'
                    : ''
              }`}
              onClick={
                authState.status === 'connected' ||
                (authState.status === 'expired' && authState.hasPersistentRefresh)
                  ? onSyncNow
                  : authState.status === 'expired' && onReconnectDrive
                    ? onReconnectDrive
                    : () => onOpenSettings('drive')
              }
              aria-label="Google Drive sync status"
            >
              {isSyncing || authState.isRefreshing ? (
                <>
                  <Loader2 size={14} className="spin" />
                  <span>Syncing…</span>
                </>
              ) : authState.status === 'connected' ? (
                pendingCount > 0 ? (
                  <>
                    <CloudUpload size={14} />
                    <span>{pendingCount} to sync</span>
                  </>
                ) : (
                  <>
                    <Cloud size={14} />
                    <span>Synced</span>
                  </>
                )
              ) : authState.status === 'expired' ? (
                <>
                  <RefreshCw size={14} />
                  <span>{authState.hasPersistentRefresh ? 'Sync' : 'Reconnect'}</span>
                </>
              ) : (
                <>
                  <CloudOff size={14} />
                  <span>Drive</span>
                </>
              )}
            </button>

            <button
              type="button"
              className="icon-btn"
              onClick={onOpenThemeSwitcher}
              aria-label="Change color theme"
              id="open-theme-switcher-btn"
              title="Color theme"
            >
              <Palette size={19} />
            </button>

            <button
              type="button"
              className="icon-btn"
              onClick={onOpenShareLibrary}
              aria-label="Share family library"
              id="open-share-library-btn"
              title="Share family library"
            >
              <Users size={19} />
            </button>

            <button
              type="button"
              className="icon-btn"
              onClick={() => onOpenSettings('recording')}
              aria-label="Open settings"
              id="open-settings-btn"
            >
              <Settings size={20} />
            </button>
          </div>
        </div>
      </header>

      <main className="app-container library-content">
        {/* Shared Family Library active banner */}
        {driveLibraryMode === 'shared' && (
          <section
            className="shared-lib-banner"
            aria-label="Shared family library"
            data-testid="shared-library-banner"
          >
            <div className="shared-lib-banner__text">
              <span className="shared-lib-banner__title">
                <Users size={14} />
                {driveSharedFolderName || 'Shared Family Library'}
              </span>
              <span className="shared-lib-banner__sub">
                {driveAccessRole === 'reader'
                  ? 'Listener mode (read-only)'
                  : 'Co-Narrator access · Shared via Google Drive'}
              </span>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => onOpenSettings('drive')}
            >
              Manage
            </button>
          </section>
        )}

        {/* Crash-recovery draft banner */}
        {latestDraft && draftBook && (
          <section className="draft-banner" aria-label="Unfinished recording draft">
            <div className="draft-banner__text">
              <span className="draft-banner__title">Unfinished Recording Found</span>
              <span className="draft-banner__sub">
                {draftBook.title} ·{' '}
                {formatDurationMs(
                  (latestDraft.totalFrames / latestDraft.sampleRate) * 1000,
                )}
              </span>
            </div>
            <div className="draft-banner__actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => onDiscardDraft(latestDraft.id)}
              >
                Discard
              </button>
              <button
                type="button"
                className="btn btn-amber btn-sm"
                onClick={() => onResumeDraft(latestDraft)}
              >
                Resume
              </button>
            </div>
          </section>
        )}

        {/* PWA Install prompt banner (Chromium beforeinstallprompt or iOS Add to Home Screen) */}
        {showInstallBanner && installPromptMode && onInstallApp && (
          <section
            className="install-banner"
            aria-label="Install StoryTape app"
            data-testid="install-app-banner"
          >
            <div className="install-banner__lead">
              <img
                src={baseIconUrl}
                alt=""
                className="install-banner__icon"
                aria-hidden="true"
              />
              <div className="install-banner__text">
                <span className="install-banner__title">Install StoryTape</span>
                <span className="install-banner__sub">
                  Add to your Home Screen for full-screen offline recording
                </span>
              </div>
            </div>
            <div className="install-banner__actions">
              <button
                type="button"
                className="btn btn-amber btn-sm"
                id="install-app-btn"
                onClick={onInstallApp}
              >
                <Download size={14} />
                {installPromptMode === 'ios' ? 'How to Install' : 'Install'}
              </button>
              {onDismissInstallBanner && (
                <button
                  type="button"
                  className="icon-btn install-banner__dismiss"
                  id="dismiss-install-banner-btn"
                  onClick={onDismissInstallBanner}
                  aria-label="Dismiss install banner"
                >
                  <X size={16} />
                </button>
              )}
            </div>
          </section>
        )}

        {/* Continue Listening banner */}
        {continueTarget && !searchQuery && (
          <section
            className="continue-card"
            aria-label="Continue listening"
            data-testid="continue-listening-card"
          >
            <BookCover
              projectId={continueTarget.project.id}
              title={continueTarget.project.title}
              author={continueTarget.project.author}
              coverColor={continueTarget.project.coverColor}
              hasCover={continueTarget.project.hasCover}
              coverUpdatedAt={continueTarget.project.coverUpdatedAt}
              size="sm"
            />
            <button
              type="button"
              className="continue-card__info"
              onClick={() => onOpenBook(continueTarget.project.id)}
            >
              <span className="continue-card__eyebrow">Continue Listening</span>
              <span className="continue-card__book">
                {continueTarget.project.title}
              </span>
              <span className="continue-card__chapter">
                {continueTarget.recording.name} ·{' '}
                {formatHumanDuration(
                  Math.max(
                    0,
                    continueTarget.recording.durationMs -
                      continueTarget.progress.positionSec * 1000,
                  ),
                )}{' '}
                left
              </span>
            </button>
            <button
              type="button"
              className="continue-card__play"
              onClick={() => onContinueListening(continueTarget.project)}
              aria-label={`Continue listening to ${continueTarget.project.title}`}
            >
              <Play size={20} style={{ marginLeft: 2 }} />
            </button>
          </section>
        )}

        {/* Search & sort */}
        {projects.length > 0 && (
          <section className="browse-bar" aria-label="Browse audiobooks">
            <div className="browse-search-row">
              <div className="search-box">
                <Search size={16} className="search-box__icon" />
                <input
                  type="search"
                  className="search-box__input"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search books, authors, chapters…"
                  aria-label="Search audiobooks"
                />
                {searchQuery && (
                  <button
                    type="button"
                    className="search-box__clear"
                    onClick={() => setSearchQuery('')}
                    aria-label="Clear search"
                  >
                    <X size={15} />
                  </button>
                )}
              </div>

              <select
                className="sort-select"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortKey)}
                aria-label="Sort audiobooks"
              >
                <option value="updated">Recent</option>
                <option value="title">A–Z</option>
                <option value="newest">Newest</option>
              </select>
            </div>
          </section>
        )}

        {/* Book shelf grid or empty state */}
        {projects.length === 0 ? (
          <section className="empty-shelf">
            <div className="empty-shelf__icon" aria-hidden="true">
              <BookOpen size={28} />
            </div>
            <h2 className="empty-shelf__title">Start Your First Audiobook</h2>
            <p className="empty-shelf__body">
              Create a book with cover art, record chapters with waveform
              scrubbing, and keep everything backed up to your Google Drive
              folder.
            </p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onNewBook}
              id="empty-new-book-btn"
            >
              <Plus size={18} />
              Create First Book
            </button>
          </section>
        ) : filteredProjects.length === 0 ? (
          <section className="empty-shelf">
            <h2 className="empty-shelf__title">No Matching Books</h2>
            <p className="empty-shelf__body">
              Try a different search term.
            </p>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setSearchQuery('')}
            >
              Show All Books
            </button>
          </section>
        ) : (
          <section className="book-grid" aria-label="Audiobook library">
            {filteredProjects.map((project) => {
              const recs = recordingsByProject.get(project.id) ?? [];
              const totalMs = recs.reduce((acc, r) => acc + r.durationMs, 0);
              const prog = progressByProject.get(project.id);

              let progressRatio: number | undefined;
              if (prog && totalMs > 0) {
                const completedMs = recs
                  .filter((r) => prog.completedRecordingIds.includes(r.id))
                  .reduce((sum, r) => sum + r.durationMs, 0);
                const currentRec = recs.find((r) => r.id === prog.recordingId);
                const currentInProgressMs =
                  currentRec && !prog.completedRecordingIds.includes(currentRec.id)
                    ? Math.min(currentRec.durationMs, prog.positionSec * 1000)
                    : 0;
                progressRatio = Math.min(
                  1,
                  (completedMs + currentInProgressMs) / totalMs,
                );
              }

              const hasPending = recs.some(
                (r) =>
                  r.syncStatus === 'pending_upload' ||
                  r.syncStatus === 'local_only' ||
                  r.syncStatus === 'error',
              );

              return (
                <button
                  key={project.id}
                  type="button"
                  className="book-card"
                  onClick={() => onOpenBook(project.id)}
                  data-testid={`book-card-${project.id}`}
                >
                  <div className="book-card__cover-wrap">
                    <BookCover
                      projectId={project.id}
                      title={project.title}
                      author={project.author}
                      coverColor={project.coverColor}
                      hasCover={project.hasCover}
                      coverUpdatedAt={project.coverUpdatedAt}
                      progressRatio={progressRatio}
                    />
                    {project.importedFrom ? (
                      <span
                        className="book-card__imported-dot"
                        title={
                          project.importedFrom.sourceUnavailable
                            ? 'Imported copy (original source unavailable)'
                            : 'Imported copy (mirrors updates when synced)'
                        }
                        data-testid={`book-imported-dot-${project.id}`}
                      >
                        <Download size={11} />
                      </span>
                    ) : (
                      project.isShared && (
                        <span
                          className="book-card__shared-dot"
                          title={
                            project.accessRole === 'reader'
                              ? 'Shared book (Listener)'
                              : 'Shared book (Co-Narrator)'
                          }
                        >
                          <Users size={11} />
                        </span>
                      )
                    )}
                    {project.syncStatus === 'synced' && !hasPending && (
                      <span
                        className="book-card__sync-dot"
                        title="Synced to Google Drive"
                      >
                        <Cloud size={12} />
                      </span>
                    )}
                    {authState.status === 'connected' && hasPending && (
                      <span
                        className="book-card__sync-dot book-card__sync-dot--pending"
                        title="Has recordings pending Drive sync"
                      >
                        <CloudUpload size={12} />
                      </span>
                    )}
                  </div>

                  <span className="book-card__title">{project.title}</span>
                  {project.author && (
                    <span className="book-card__author">{project.author}</span>
                  )}
                  <span className="book-card__meta">
                    <span>
                      {recs.length} {recs.length === 1 ? 'chapter' : 'chapters'}
                    </span>
                    {totalMs > 0 && (
                      <>
                        <span>·</span>
                        <span>{formatHumanDuration(totalMs)}</span>
                      </>
                    )}
                  </span>
                </button>
              );
            })}
          </section>
        )}
      </main>

      {projects.length > 0 &&
        !(driveLibraryMode === 'shared' && driveAccessRole === 'reader') && (
          <button
            type="button"
            className={`btn btn-primary library-fab ${hasMiniPlayer ? 'library-fab--raised' : ''}`}
            onClick={onNewBook}
            id="new-book-fab"
          >
            <Plus size={18} />
            New Book
          </button>
        )}
    </div>
  );
};
