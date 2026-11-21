import React from 'react';
import { Pause, Play } from 'lucide-react';
import { formatDurationMs } from '../../utils/format';

export interface QualityLabSampleButtonProps {
  label: string;
  isPlaying: boolean;
  isPaused: boolean;
  onClick: () => void;
  testId: string;
}

export const QualityLabSampleButton: React.FC<QualityLabSampleButtonProps> = ({
  label,
  isPlaying,
  isPaused,
  onClick,
  testId,
}) => {
  const actionLabel = isPlaying ? 'Pause' : isPaused ? 'Resume' : 'Play';
  return (
    <button
      type="button"
      className={`ql-sample-btn ${
        isPlaying
          ? 'ql-sample-btn--playing'
          : isPaused
            ? 'ql-sample-btn--paused'
            : ''
      }`}
      onClick={onClick}
      aria-pressed={isPlaying}
      aria-label={`${actionLabel} ${label}`}
      data-testid={testId}
    >
      <span className="ql-sample-btn__icon" aria-hidden="true">
        {isPlaying ? (
          <Pause size={17} fill="currentColor" />
        ) : (
          <Play size={17} fill="currentColor" />
        )}
      </span>
      <span className="ql-sample-btn__text">
        <span className="ql-sample-btn__name">{label}</span>
        <span className="ql-sample-btn__state">{actionLabel}</span>
      </span>
    </button>
  );
};

export interface QualityLabTransportBarProps {
  playheadSec: number;
  playDurationSec: number;
}

export const QualityLabTransportBar: React.FC<QualityLabTransportBarProps> = ({
  playheadSec,
  playDurationSec,
}) => (
  <div className="ql-transport-bar" data-testid="ql-progress-bar">
    <span className="font-mono ql-muted-mono" data-testid="ql-playhead-time">
      {formatDurationMs(playheadSec * 1000)}
    </span>
    <div
      className="ql-progress-track"
      role="progressbar"
      aria-label="Sample playback progress"
      aria-valuemin={0}
      aria-valuemax={Math.round(playDurationSec * 1000)}
      aria-valuenow={Math.round(playheadSec * 1000)}
    >
      <div
        className="ql-progress-fill"
        style={{
          width: `${
            playDurationSec > 0
              ? Math.min(100, (playheadSec / playDurationSec) * 100)
              : 0
          }%`,
        }}
      />
    </div>
    <span className="font-mono ql-muted-mono">
      {formatDurationMs(playDurationSec * 1000)}
    </span>
  </div>
);
