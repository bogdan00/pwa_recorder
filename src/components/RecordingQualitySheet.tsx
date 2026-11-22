import React, { useEffect } from 'react';
import { Activity, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import type { RecordingQualityReport } from '../audio/recordingQualityAnalyzer';
import { formatDurationMs } from '../utils/format';
import './RecordingQualitySheet.css';

interface RecordingQualitySheetProps {
  open: boolean;
  report: RecordingQualityReport | null;
  isRecording: boolean;
  onClose: () => void;
}

function formatMetricDb(val: number | null, suffix = 'dBFS'): string {
  if (val === null || !Number.isFinite(val)) return '—';
  return `${val > 0 ? '+' : ''}${val.toFixed(1)} ${suffix}`;
}

export const RecordingQualitySheet: React.FC<RecordingQualitySheetProps> = ({
  open,
  report,
  isRecording,
  onClose,
}) => {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const status = report?.status ?? 'listening';
  const statusToneClass =
    status === 'critical'
      ? 'quality-sheet__banner--critical'
      : status === 'warn'
        ? 'quality-sheet__banner--warn'
        : status === 'good'
          ? 'quality-sheet__banner--good'
          : 'quality-sheet__banner--listening';

  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="recording-quality-sheet-title"
      data-testid="recording-quality-sheet"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet-panel quality-sheet__panel">
        <div className="sheet-header">
          <div className="quality-sheet__title-wrap">
            <Activity size={18} aria-hidden="true" />
            <h2 id="recording-quality-sheet-title" className="sheet-title">
              Audio Health Monitor
            </h2>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close audio health monitor"
          >
            <X size={20} />
          </button>
        </div>

        <div className="sheet-body quality-sheet__body">
          <div className={`quality-sheet__banner ${statusToneClass}`}>
            <div className="quality-sheet__banner-head">
              {status === 'good' ? (
                <CheckCircle2 size={18} aria-hidden="true" />
              ) : status === 'listening' ? (
                <Info size={18} aria-hidden="true" />
              ) : (
                <AlertTriangle size={18} aria-hidden="true" />
              )}
              <span className="quality-sheet__banner-title">
                {report?.headline ?? 'Listening to microphone…'}
              </span>
            </div>
            {report?.primaryTip && (
              <p className="quality-sheet__banner-tip">{report.primaryTip}</p>
            )}
            <p className="quality-sheet__banner-sub">
              {isRecording
                ? 'Recording continues uninterrupted in the background (updates 1×/sec off-main-thread).'
                : 'Summary from this take — fix any alerts before recording a long chapter.'}
            </p>
          </div>

          {report && (
            <>
              <div className="quality-sheet__metrics" aria-label="Live audio metrics">
                <div className="quality-sheet__metric">
                  <span className="quality-sheet__metric-label">Speech</span>
                  <span className="quality-sheet__metric-val">
                    {formatMetricDb(report.metrics.speechRmsDb)}
                  </span>
                </div>
                <div className="quality-sheet__metric">
                  <span className="quality-sheet__metric-label">Noise Floor</span>
                  <span className="quality-sheet__metric-val">
                    {formatMetricDb(report.metrics.noiseFloorDb)}
                  </span>
                </div>
                <div className="quality-sheet__metric">
                  <span className="quality-sheet__metric-label">SNR</span>
                  <span className="quality-sheet__metric-val">
                    {report.metrics.snrDb !== null
                      ? `${report.metrics.snrDb.toFixed(1)} dB`
                      : '—'}
                  </span>
                </div>
                <div className="quality-sheet__metric">
                  <span className="quality-sheet__metric-label">Peak</span>
                  <span className="quality-sheet__metric-val">
                    {formatMetricDb(report.metrics.peakDb)}
                  </span>
                </div>
                <div className="quality-sheet__metric">
                  <span className="quality-sheet__metric-label">Clicks / Gaps</span>
                  <span className="quality-sheet__metric-val">
                    {report.metrics.totalClicks + report.metrics.totalTimestampGaps}
                  </span>
                </div>
                <div className="quality-sheet__metric">
                  <span className="quality-sheet__metric-label">Dropouts</span>
                  <span className="quality-sheet__metric-val">
                    {report.metrics.totalDropouts}
                  </span>
                </div>
              </div>

              <div className="quality-sheet__section">
                <h3 className="quality-sheet__section-title">
                  10 Real-Time Heuristics
                </h3>
                <ul className="quality-sheet__checks" data-testid="quality-checks-list">
                  {report.checks.map((chk) => (
                    <li
                      key={chk.code}
                      className={`quality-sheet__check quality-sheet__check--${chk.severity}`}
                      data-testid={`quality-check-${chk.code}`}
                    >
                      <span
                        className={`quality-sheet__dot quality-sheet__dot--${chk.severity}`}
                        aria-hidden="true"
                      />
                      <div className="quality-sheet__check-text">
                        <div className="quality-sheet__check-row">
                          <span className="quality-sheet__check-label">
                            {chk.label}
                          </span>
                          <span className="quality-sheet__check-badge">
                            {chk.severity === 'good'
                              ? 'OK'
                              : chk.severity === 'warn'
                                ? 'Warn'
                                : 'Alert'}
                          </span>
                        </div>
                        <span className="quality-sheet__check-detail">
                          {chk.detail}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>

              {report.glitchEvents.length > 0 && (
                <div className="quality-sheet__section">
                  <h3 className="quality-sheet__section-title">
                    Detected Events ({report.glitchEvents.length})
                  </h3>
                  <ul className="quality-sheet__events">
                    {report.glitchEvents
                      .slice()
                      .reverse()
                      .slice(0, 12)
                      .map((ev, idx) => (
                        <li
                          key={`${ev.timeSec}-${ev.code}-${idx}`}
                          className="quality-sheet__event"
                        >
                          <span className="quality-sheet__event-time">
                            {formatDurationMs(ev.timeSec * 1000)}
                          </span>
                          <span className="quality-sheet__event-msg">
                            {ev.message}
                          </span>
                        </li>
                      ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>

        <div className="sheet-footer">
          <button
            type="button"
            className="btn btn-primary"
            style={{ width: '100%' }}
            onClick={onClose}
          >
            {isRecording ? 'Back to Recording' : 'Done'}
          </button>
        </div>
      </div>
    </div>
  );
};
