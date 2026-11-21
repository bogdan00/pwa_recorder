import React from 'react';
import { Pause, Play } from 'lucide-react';
import { formatDurationMs } from '../../utils/format';

export interface QualityLabTransportBarProps {
  isPlaying: boolean;
  playheadSec: number;
  playDurationSec: number;
  onTogglePause: () => void;
}

export const QualityLabTransportBar: React.FC<QualityLabTransportBarProps> = ({
  isPlaying,
  playheadSec,
  playDurationSec,
  onTogglePause,
}) => (
  <div className="ql-transport-bar">
    <button
      type="button"
      className="btn btn-secondary btn-sm"
      onClick={onTogglePause}
      aria-label={isPlaying ? 'Pause comparison' : 'Play comparison'}
    >
      {isPlaying ? <Pause size={14} /> : <Play size={14} />}
      {isPlaying ? 'Pause' : 'Play'}
    </button>
    <div className="ql-progress-track">
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
      {formatDurationMs(playheadSec * 1000)}
    </span>
  </div>
);
