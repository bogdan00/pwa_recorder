import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Check,
  Cloud,
  CloudDownload,
  CloudUpload,
  Download,
  FlaskConical,
  Loader2,
  MoreVertical,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Share2,
  Trash2,
} from 'lucide-react';
import type { Recording } from '../types/models';
import { formatBytes, formatDurationMs, formatSampleRate } from '../utils/format';
import './RecordingCard.css';

interface RecordingCardProps {
  recording: Recording;
  index: number;
  totalCount: number;
  isActive: boolean;
  isPlaying: boolean;
  isLoading: boolean;
  isCompleted: boolean;
  canSyncDrive: boolean;
  isReadOnly?: boolean;
  onPlay: () => void;
  onRename: (newName: string) => Promise<void>;
  onMoveUp: () => Promise<void>;
  onMoveDown: () => Promise<void>;
  onDownloadLocal: () => Promise<void>;
  onOpenQualityLab?: () => void;
  onDeleteLocalMaster?: () => Promise<void>;
  onShareAudio?: () => Promise<void>;
  onRetrySync: () => Promise<void>;
  onDelete: () => Promise<void>;
}

export const RecordingCard: React.FC<RecordingCardProps> = ({
  recording,
  index,
  totalCount,
  isActive,
  isPlaying,
  isLoading,
  isCompleted,
  canSyncDrive,
  isReadOnly = false,
  onPlay,
  onRename,
  onMoveUp,
  onMoveDown,
  onDownloadLocal,
  onOpenQualityLab,
  onDeleteLocalMaster,
  onShareAudio,
  onRetrySync,
  onDelete,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(recording.name);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onOutsideClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onOutsideClick);
    return () => document.removeEventListener('mousedown', onOutsideClick);
  }, [menuOpen]);

  const specBadge = (() => {
    const parts: string[] = [recording.extension.toUpperCase()];
    if (recording.sampleRate > 0) {
      parts.push(formatSampleRate(recording.sampleRate));
    }
    if (recording.extension === 'wav') {
      if (recording.bitDepth) {
        parts.push(
          recording.bitDepth === 32 ? '32f' : `${recording.bitDepth}-bit`,
        );
      }
    } else if (recording.bitrateKbps) {
      parts.push(`${recording.bitrateKbps}k`);
    }
    return parts.join(' · ');
  })();

  const renderSyncIndicator = () => {
    switch (recording.syncStatus) {
      case 'synced':
        return (
          <span
            className="rec-card__sync-icon rec-card__sync-icon--synced"
            title="Synced to Google Drive"
            aria-label="Synced to Google Drive"
          >
            <Cloud size={15} />
          </span>
        );
      case 'uploading':
        return (
          <span
            className="rec-card__sync-icon rec-card__sync-icon--pending"
            title="Uploading to Google Drive"
          >
            <Loader2 size={15} className="spin" />
          </span>
        );
      case 'pending_upload':
        return (
          <span
            className="rec-card__sync-icon rec-card__sync-icon--pending"
            title="Waiting to sync to Google Drive"
          >
            <CloudUpload size={15} />
          </span>
        );
      case 'cloud_only':
        return (
          <span
            className="rec-card__sync-icon"
            title="Stored in Google Drive (tap to stream & cache)"
          >
            <CloudDownload size={15} />
          </span>
        );
      case 'error':
        return (
          <span
            className="rec-card__sync-icon rec-card__sync-icon--error"
            title={recording.syncError || 'Drive sync error'}
          >
            <AlertCircle size={15} />
          </span>
        );
      default:
        return null;
    }
  };

  const handleRenameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = draftName.trim();
    if (!trimmed) return;
    await onRename(trimmed);
    setRenaming(false);
  };

  return (
    <div
      className={`rec-card ${isActive ? 'rec-card--active' : ''}`}
      data-testid={`recording-card-${recording.id}`}
    >
      {renaming ? (
        <form className="rec-rename-row" onSubmit={handleRenameSubmit}>
          <input
            type="text"
            className="input"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            autoFocus
            aria-label="Rename recording"
          />
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={!draftName.trim()}
          >
            Save
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setDraftName(recording.name);
              setRenaming(false);
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <>
          <button
            type="button"
            className="rec-card__play-area"
            onClick={onPlay}
            aria-label={`${isActive && isPlaying ? 'Pause' : 'Play'} ${recording.name}`}
          >
            <span
              className={`rec-card__index ${!isActive && isCompleted ? 'rec-card__index--done' : ''}`}
            >
              {isActive && isLoading ? (
                <Loader2 size={15} className="spin" />
              ) : isActive && isPlaying ? (
                <Pause size={15} />
              ) : isActive ? (
                <Play size={15} style={{ marginLeft: 2 }} />
              ) : isCompleted ? (
                <Check size={15} />
              ) : (
                String(index + 1).padStart(2, '0')
              )}
            </span>

            <div className="rec-card__info">
              <div className="rec-card__title-row">
                <span className="rec-card__title">{recording.name}</span>
              </div>
              <div className="rec-card__meta">
                {recording.durationMs > 0 ? (
                  <>
                    <span className="font-mono">
                      {formatDurationMs(recording.durationMs)}
                    </span>
                    <span className="rec-card__dot">·</span>
                  </>
                ) : recording.fileSizeBytes > 0 ? (
                  <>
                    <span className="font-mono">
                      {formatBytes(recording.fileSizeBytes)}
                    </span>
                    <span className="rec-card__dot">·</span>
                  </>
                ) : null}
                <span>{specBadge}</span>
                {recording.channels === 2 && (
                  <>
                    <span className="rec-card__dot">·</span>
                    <span>Stereo</span>
                  </>
                )}
                {recording.hasLocalMaster && (
                  <span
                    className="rec-card__master-badge"
                    data-testid="recording-master-badge"
                    title="Local lossless 32-bit Float WAV master saved on this device"
                  >
                    Master
                  </span>
                )}
                {recording.recordedBy && (
                  <>
                    <span className="rec-card__dot">·</span>
                    <span>Read by {recording.recordedBy}</span>
                  </>
                )}
              </div>
              {recording.notes && (
                <span className="rec-card__notes">{recording.notes}</span>
              )}
            </div>
          </button>

          <div className="rec-card__right">
            {renderSyncIndicator()}

            <div className="rec-menu-wrap" ref={menuRef}>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setMenuOpen((v) => !v)}
                aria-label={`More actions for ${recording.name}`}
                aria-expanded={menuOpen}
              >
                <MoreVertical size={18} />
              </button>

              {menuOpen && (
                <div className="rec-menu" role="menu">
                  {!isReadOnly && (
                    <>
                      <button
                        type="button"
                        className="rec-menu__item"
                        role="menuitem"
                        onClick={() => {
                          setMenuOpen(false);
                          setDraftName(recording.name);
                          setRenaming(true);
                        }}
                      >
                        <Pencil size={15} />
                        Rename
                      </button>
                      <button
                        type="button"
                        className="rec-menu__item"
                        role="menuitem"
                        disabled={index === 0}
                        onClick={() => {
                          setMenuOpen(false);
                          void onMoveUp();
                        }}
                      >
                        <ArrowUp size={15} />
                        Move Up
                      </button>
                      <button
                        type="button"
                        className="rec-menu__item"
                        role="menuitem"
                        disabled={index >= totalCount - 1}
                        onClick={() => {
                          setMenuOpen(false);
                          void onMoveDown();
                        }}
                      >
                        <ArrowDown size={15} />
                        Move Down
                      </button>
                    </>
                  )}
                  {onOpenQualityLab && (
                    <button
                      type="button"
                      className="rec-menu__item"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        onOpenQualityLab();
                      }}
                    >
                      <FlaskConical size={15} />
                      Export &amp; Quality Lab
                    </button>
                  )}
                  {onShareAudio && (
                    <button
                      type="button"
                      className="rec-menu__item"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        void onShareAudio();
                      }}
                    >
                      <Share2 size={15} />
                      Share Audio
                    </button>
                  )}
                  <button
                    type="button"
                    className="rec-menu__item"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      void onDownloadLocal();
                    }}
                  >
                    <Download size={15} />
                    Download Audio
                  </button>
                  {recording.hasLocalMaster && onDeleteLocalMaster && (
                    <button
                      type="button"
                      className="rec-menu__item"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        void onDeleteLocalMaster();
                      }}
                    >
                      <Trash2 size={15} />
                      Delete Local Master
                    </button>
                  )}
                  {!isReadOnly &&
                    canSyncDrive &&
                    recording.syncStatus !== 'synced' &&
                    recording.syncStatus !== 'cloud_only' && (
                      <button
                        type="button"
                        className="rec-menu__item"
                        role="menuitem"
                        onClick={() => {
                          setMenuOpen(false);
                          void onRetrySync();
                        }}
                      >
                        <RefreshCw size={15} />
                        Sync to Drive
                      </button>
                    )}
                  {!isReadOnly && (
                    <button
                      type="button"
                      className="rec-menu__item rec-menu__item--danger"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        void onDelete();
                      }}
                    >
                      <Trash2 size={15} />
                      Delete
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
};
