import React from 'react';
import { Loader2, Pause, Play, X } from 'lucide-react';
import { usePlayer } from '../player/PlayerContext';
import { BookCover } from './BookCover';
import './MiniPlayerBar.css';

interface MiniPlayerBarProps {
  hidden?: boolean;
}

export const MiniPlayerBar: React.FC<MiniPlayerBarProps> = ({ hidden }) => {
  const {
    project,
    currentRecording,
    coverUrl,
    isPlaying,
    isLoading,
    currentTime,
    duration,
    isExpanded,
    togglePlayPause,
    expandPlayer,
    closePlayer,
  } = usePlayer();

  if (hidden || isExpanded || !project || !currentRecording) {
    return null;
  }

  const pct =
    duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;

  return (
    <aside
      className="mini-player"
      aria-label="Audiobook mini player"
      data-testid="mini-player-bar"
    >
      <div className="mini-player__progress-track" aria-hidden="true">
        <div
          className="mini-player__progress-fill"
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="mini-player__row">
        <button
          type="button"
          className="mini-player__tap-zone"
          onClick={expandPlayer}
          aria-label={`Open player for ${currentRecording.name}`}
        >
          <BookCover
            title={project.title}
            author={project.author}
            coverColor={project.coverColor}
            previewUrl={coverUrl}
            size="sm"
          />
          <div className="mini-player__meta">
            <span className="mini-player__chapter">{currentRecording.name}</span>
            <span className="mini-player__book">{project.title}</span>
          </div>
        </button>

        <div className="mini-player__controls">
          <button
            type="button"
            className="mini-player__play-btn"
            onClick={() => void togglePlayPause()}
            aria-label={isPlaying ? 'Pause audiobook' : 'Play audiobook'}
          >
            {isLoading ? (
              <Loader2 size={18} className="spin" />
            ) : isPlaying ? (
              <Pause size={18} />
            ) : (
              <Play size={18} style={{ marginLeft: 2 }} />
            )}
          </button>

          <button
            type="button"
            className="icon-btn"
            onClick={closePlayer}
            aria-label="Close player"
          >
            <X size={18} />
          </button>
        </div>
      </div>
    </aside>
  );
};
