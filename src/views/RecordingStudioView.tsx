import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Mic,
  Pause,
  Play,
  Scissors,
  SlidersHorizontal,
  Square,
  Trash2,
  Undo2,
} from 'lucide-react';
import type {
  AppSettings,
  BookProject,
  Recording,
} from '../types/models';
import {
  type CodecCapabilities,
  formatQualitySummaryPill,
  probeAudioCapabilities,
} from '../audio/qualityPresets';
import {
  RecordingEngine,
  type StudioSnapshot,
} from '../audio/recordingEngine';
import { formatDurationMs } from '../utils/format';
import { SaveRecordingSheet } from '../components/SaveRecordingSheet';
import { WaveformCanvas } from '../components/WaveformCanvas';
import './RecordingStudioView.css';

export interface SavedStudioRecording {
  name: string;
  notes: string;
  blob: Blob;
  mimeType: string;
  extension: Recording['extension'];
  durationMs: number;
  sampleRate: number;
  bitrateKbps?: number;
  bitDepth?: number;
  channels: Recording['channels'];
  deviceLabel: string;
  peaks: number[];
}

interface RecordingStudioViewProps {
  project: BookProject;
  existingRecordingCount: number;
  settings: AppSettings;
  resumeDraftId?: string | null;
  onOpenSettings: () => void;
  onExit: () => void;
  onToast: (message: string) => void;
  onRecordingSaved: (result: SavedStudioRecording) => Promise<void>;
  engineFactory?: (projectId: string) => RecordingEngine;
}

export const RecordingStudioView: React.FC<RecordingStudioViewProps> = ({
  project,
  existingRecordingCount,
  settings,
  resumeDraftId,
  onOpenSettings,
  onExit,
  onToast,
  onRecordingSaved,
  engineFactory,
}) => {
  const engineRef = useRef<RecordingEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = engineFactory
      ? engineFactory(project.id)
      : new RecordingEngine(project.id);
  }

  const [snap, setSnap] = useState<StudioSnapshot>(() =>
    engineRef.current!.getSnapshot(),
  );
  const [caps, setCaps] = useState<CodecCapabilities | null>(null);
  const [studioError, setStudioError] = useState<string | null>(null);

  // Modals
  const [saveOpen, setSaveOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [encodeProgress, setEncodeProgress] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);
  const [confirmExitOpen, setConfirmExitOpen] = useState(false);

  useEffect(() => {
    void probeAudioCapabilities().then(setCaps);
  }, []);

  useEffect(() => {
    const engine = engineRef.current!;
    const unsub = engine.subscribe(setSnap);

    if (resumeDraftId) {
      void engine.loadDraft(resumeDraftId);
    }

    return () => {
      unsub();
      void engine.dispose();
    };
  }, [resumeDraftId]);

  // Warn before accidental browser refresh/close while audio is unsaved
  useEffect(() => {
    const hasUnsaved = snap.durationMs > 0 || snap.phase === 'recording';
    if (!hasUnsaved) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [snap.durationMs, snap.phase]);

  const isScrubbedBack =
    snap.phase === 'paused' &&
    snap.durationMs > 0 &&
    snap.durationMs - snap.playheadMs > 300;

  const specSummary = useMemo(() => {
    const qText = formatQualitySummaryPill(settings.audioQuality, caps);
    const micLabel =
      snap.activeDeviceLabel ||
      settings.audioDevice.deviceLabel ||
      'Default Mic';
    const shortMic =
      micLabel.length > 22 ? `${micLabel.slice(0, 21)}…` : micLabel;
    return `${qText} · ${shortMic}`;
  }, [caps, settings.audioDevice.deviceLabel, settings.audioQuality, snap.activeDeviceLabel]);

  const defaultRecordingName = `Chapter ${existingRecordingCount + 1}`;

  const handleBigRecordPauseClick = async () => {
    setStudioError(null);
    const engine = engineRef.current!;
    try {
      if (snap.phase === 'recording') {
        await engine.pause();
      } else {
        const feedback = await engine.startOrResumeFromEnd(
          settings.audioDevice,
          settings.audioQuality,
          settings.keepScreenAwake,
        );
        if (feedback.usedFallbackDevice && feedback.fallbackReason) {
          onToast(feedback.fallbackReason);
        }
      }
    } catch (err) {
      setStudioError(
        err instanceof Error
          ? err.message
          : 'Could not access microphone. Check browser permissions.',
      );
    }
  };

  const handlePunchIn = async () => {
    setStudioError(null);
    const engine = engineRef.current!;
    try {
      const res = await engine.punchInFromPlayhead(
        settings.audioDevice,
        settings.audioQuality,
        settings.keepScreenAwake,
      );
      if (res.usedFallbackDevice && res.fallbackReason) {
        onToast(res.fallbackReason);
      } else {
        onToast(`Re-recording from ${formatDurationMs(snap.playheadMs)}`);
      }
    } catch (err) {
      setStudioError(
        err instanceof Error ? err.message : 'Could not resume microphone.',
      );
    }
  };

  const handleUndoTrim = async () => {
    const ok = await engineRef.current!.undoLastTrim();
    if (ok) onToast('Restored trimmed audio');
  };

  const handleStopClick = async () => {
    if (snap.durationMs === 0 && snap.phase === 'idle') return;
    await engineRef.current!.pauseForStopPrompt();
    setSaveError(null);
    setEncodeProgress(0);
    setSaveOpen(true);
  };

  const handleConfirmSave = async (name: string, notes: string) => {
    setIsSaving(true);
    setSaveError(null);
    setEncodeProgress(0.05);
    try {
      const { encoded, durationMs, overviewPeaks, deviceLabel } =
        await engineRef.current!.finalizeAndEncode(
          settings.audioQuality,
          (ratio) => setEncodeProgress(ratio),
        );

      await onRecordingSaved({
        name,
        notes,
        blob: encoded.blob,
        mimeType: encoded.mimeType,
        extension: encoded.extension,
        durationMs,
        sampleRate: encoded.sampleRate,
        bitrateKbps: encoded.bitrateKbps,
        bitDepth: encoded.bitDepth,
        channels: encoded.channels,
        deviceLabel: deviceLabel || settings.audioDevice.deviceLabel,
        peaks: overviewPeaks,
      });
      setSaveOpen(false);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : 'Failed to encode recording.',
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleBackRequest = async () => {
    if (snap.durationMs === 0 && snap.phase === 'idle') {
      onExit();
      return;
    }
    await engineRef.current!.pauseForStopPrompt();
    setConfirmExitOpen(true);
  };

  const handleDiscardConfirm = async () => {
    await engineRef.current!.discard();
    setConfirmDiscardOpen(false);
    onToast('Take discarded');
  };

  const statusLabel =
    snap.phase === 'recording'
      ? 'REC'
      : snap.phase === 'paused'
        ? 'PAUSED'
        : snap.phase === 'playing'
          ? 'PLAYING'
          : 'READY';

  const statusClass =
    snap.phase === 'recording'
      ? 'studio-status-pill--rec'
      : snap.phase === 'paused'
        ? 'studio-status-pill--paused'
        : snap.phase === 'playing'
          ? 'studio-status-pill--playing'
          : '';

  return (
    <div className="studio-page" data-testid="recording-studio-view">
      <div className="studio-inner">
        {/* Top bar */}
        <header className="studio-header">
          <button
            type="button"
            className="icon-btn"
            onClick={() => void handleBackRequest()}
            aria-label="Leave recording studio"
          >
            <ArrowLeft size={21} />
          </button>

          <div className="studio-book-pill">
            <span className="studio-book-pill__title">{project.title}</span>
          </div>

          <span className={`studio-status-pill ${statusClass}`} aria-live="polite">
            {snap.phase === 'recording' && (
              <span className="rec-dot" aria-hidden="true" />
            )}
            {statusLabel}
          </span>
        </header>

        {/* Audio spec pill & crisp tabular timer */}
        <section className="studio-timer-block">
          <button
            type="button"
            className="studio-spec-chip"
            onClick={onOpenSettings}
            disabled={snap.phase !== 'idle'}
            title={
              snap.phase === 'idle'
                ? 'Tap to change recording quality or microphone'
                : 'Audio settings lock while a take is in progress'
            }
          >
            <SlidersHorizontal size={12} />
            <span className="studio-spec-chip__text">{specSummary}</span>
          </button>

          <div className="studio-timer" data-testid="studio-timer">
            {formatDurationMs(snap.playheadMs, { showTenths: true })}
          </div>

          <div className="studio-timer-sub">
            {isScrubbedBack
              ? `Scrubbed · ${formatDurationMs(snap.durationMs, { showTenths: true })} total`
              : snap.phase === 'playing'
                ? `Previewing · ${formatDurationMs(snap.durationMs, { showTenths: true })} total`
                : '\u00A0'}
          </div>
        </section>

        {/* Live & Drag-to-Scrub Waveform Canvas */}
        <section className="studio-wave-wrap">
          <WaveformCanvas
            peaks={snap.peaks}
            durationMs={snap.durationMs}
            playheadMs={snap.playheadMs}
            phase={snap.phase}
            liveLevel={snap.liveLevel}
            onSeekMs={(ms) => engineRef.current!.seekToMs(ms)}
            onScrubStart={() => {
              if (snap.phase === 'playing') {
                engineRef.current!.pausePreview();
              }
            }}
          />
        </section>

        {studioError && (
          <div className="studio-error-banner" role="alert">
            {studioError}
          </div>
        )}

        {/* Paused review controls + contextual Punch-In ("Re-record from here") */}
        <section className="studio-review-zone" aria-label="Playback review controls">
          {(snap.phase === 'paused' || snap.phase === 'playing') &&
            snap.durationMs > 0 && (
              <>
                <div className="studio-review-bar">
                  <button
                    type="button"
                    className="studio-review-step"
                    onClick={() =>
                      engineRef.current!.seekToMs(snap.playheadMs - 5000)
                    }
                    aria-label="Skip back 5 seconds"
                  >
                    -5s
                  </button>

                  <button
                    type="button"
                    className="studio-review-play"
                    id="studio-preview-play-btn"
                    onClick={() => {
                      if (snap.phase === 'playing') {
                        engineRef.current!.pausePreview();
                      } else {
                        void engineRef.current!.playPreviewFromPlayhead();
                      }
                    }}
                  >
                    {snap.phase === 'playing' ? (
                      <>
                        <Pause size={15} />
                        Pause
                      </>
                    ) : (
                      <>
                        <Play size={15} style={{ marginLeft: 1 }} />
                        Play
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    className="studio-review-step"
                    onClick={() =>
                      engineRef.current!.seekToMs(snap.playheadMs + 5000)
                    }
                    aria-label="Skip forward 5 seconds"
                  >
                    +5s
                  </button>

                  {isScrubbedBack && (
                    <button
                      type="button"
                      className="studio-review-step"
                      onClick={() => engineRef.current!.seekToMs(snap.durationMs)}
                      aria-label="Jump to end of recording"
                    >
                      End
                    </button>
                  )}
                </div>

                <div className="studio-punch-row">
                  {isScrubbedBack && (
                    <button
                      type="button"
                      className="btn btn-amber btn-sm"
                      onClick={() => void handlePunchIn()}
                      id="punch-in-btn"
                    >
                      <Scissors size={14} />
                      Re-record from {formatDurationMs(snap.playheadMs)}
                    </button>
                  )}

                  {snap.phase === 'paused' && snap.canUndoTrim && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => void handleUndoTrim()}
                      id="undo-trim-btn"
                    >
                      <Undo2 size={14} />
                      Undo trim
                    </button>
                  )}
                </div>
              </>
            )}
        </section>

        {/* Bottom Thumb-Zone Transport Deck: BIG Start/Pause + Smaller Stop */}
        <footer className="studio-deck">
          {/* Left slot: Discard (only when paused with audio) */}
          <div className="studio-deck__slot">
            {snap.phase === 'paused' && snap.durationMs > 0 ? (
              <>
                <button
                  type="button"
                  className="discard-btn"
                  onClick={() => setConfirmDiscardOpen(true)}
                  aria-label="Discard current recording"
                >
                  <Trash2 size={18} />
                </button>
                <span className="studio-deck__label">Discard</span>
              </>
            ) : (
              <span className="studio-deck__label">&nbsp;</span>
            )}
          </div>

          {/* Center slot: BIG Start / Pause button */}
          <div className="studio-deck__slot">
            <div className="record-btn-wrap">
              {snap.phase === 'recording' && (
                <span className="record-btn-halo" aria-hidden="true" />
              )}
              <button
                type="button"
                id="big-record-pause-btn"
                className={`record-btn ${snap.phase === 'recording' ? 'record-btn--recording' : ''}`}
                onClick={() => void handleBigRecordPauseClick()}
                aria-label={
                  snap.phase === 'recording'
                    ? 'Pause recording'
                    : snap.durationMs > 0
                      ? 'Continue recording from end'
                      : 'Start recording'
                }
              >
                <span className="record-btn__ring" aria-hidden="true" />
                {snap.phase === 'recording' ? (
                  <Pause size={34} fill="currentColor" />
                ) : (
                  <Mic size={34} />
                )}
              </button>
            </div>
            <span className="studio-deck__label">
              {snap.phase === 'recording'
                ? 'Pause'
                : isScrubbedBack
                  ? 'Continue at end'
                  : snap.durationMs > 0
                    ? 'Resume'
                    : 'Record'}
            </span>
          </div>

          {/* Right slot: Smaller Stop button */}
          <div className="studio-deck__slot">
            <button
              type="button"
              id="small-stop-btn"
              className="stop-btn"
              onClick={() => void handleStopClick()}
              disabled={snap.phase === 'idle' && snap.durationMs === 0}
              aria-label="Stop and save recording"
            >
              <Square size={19} fill="currentColor" />
            </button>
            <span className="studio-deck__label">Stop</span>
          </div>
        </footer>
      </div>

      {/* Full Stop -> Name Recording Prompt */}
      <SaveRecordingSheet
        open={saveOpen}
        defaultName={defaultRecordingName}
        durationMs={snap.durationMs}
        specLabel={specSummary}
        isPreviewPlaying={snap.phase === 'playing'}
        isSaving={isSaving}
        encodeProgress={encodeProgress}
        errorMessage={saveError}
        onTogglePreview={() => {
          if (snap.phase === 'playing') {
            engineRef.current!.pausePreview();
          } else {
            engineRef.current!.seekToMs(0);
            void engineRef.current!.playPreviewFromPlayhead();
          }
        }}
        onBackToRecording={() => {
          if (snap.phase === 'playing') {
            engineRef.current!.pausePreview();
          }
          setSaveOpen(false);
        }}
        onConfirmSave={(name, notes) => void handleConfirmSave(name, notes)}
      />

      {/* Discard confirmation sheet */}
      {confirmDiscardOpen && (
        <div className="sheet-backdrop" role="dialog" aria-modal="true">
          <div className="sheet-panel">
            <div className="sheet-header">
              <h2 className="sheet-title">Discard this Take?</h2>
            </div>
            <div className="sheet-body">
              <p className="field-hint" style={{ fontSize: 14 }}>
                This will permanently remove the current{' '}
                {formatDurationMs(snap.durationMs)} unsaved recording.
              </p>
            </div>
            <div className="sheet-footer">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setConfirmDiscardOpen(false)}
              >
                Keep Recording
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void handleDiscardConfirm()}
              >
                Discard Take
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Leave studio confirmation sheet */}
      {confirmExitOpen && (
        <div className="sheet-backdrop" role="dialog" aria-modal="true">
          <div className="sheet-panel">
            <div className="sheet-header">
              <h2 className="sheet-title">Unsaved Recording</h2>
            </div>
            <div className="sheet-body">
              <p className="field-hint" style={{ fontSize: 14 }}>
                You have {formatDurationMs(snap.durationMs)} recorded. You can
                keep it as a recoverable draft on this device or discard it.
              </p>
            </div>
            <div className="sheet-footer" style={{ flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setConfirmExitOpen(false)}
              >
                Stay
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={async () => {
                  await engineRef.current!.discard();
                  setConfirmExitOpen(false);
                  onExit();
                }}
              >
                Discard &amp; Leave
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setConfirmExitOpen(false);
                  onToast('Draft saved locally — resume anytime from Library');
                  onExit();
                }}
              >
                Keep Draft &amp; Leave
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
