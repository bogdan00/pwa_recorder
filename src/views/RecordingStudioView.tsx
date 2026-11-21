import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Mic,
  Moon,
  Pause,
  Play,
  Scissors,
  SlidersHorizontal,
  Square,
  Trash2,
  Undo2,
  X,
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
import { useConfirm } from '../components/ConfirmDialogContext';
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
  localMaster?: {
    blob: Blob;
    sampleRate: number;
    bitDepth: 32;
    channels: Recording['channels'];
  };
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
  const confirm = useConfirm();
  const engineRef = useRef<RecordingEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = engineFactory
      ? engineFactory(project.id)
      : new RecordingEngine(project.id, project.title);
  }

  const [snap, setSnap] = useState<StudioSnapshot>(() =>
    engineRef.current!.getSnapshot(),
  );
  const [caps, setCaps] = useState<CodecCapabilities | null>(null);
  const [studioError, setStudioError] = useState<string | null>(null);
  const [isStartingMic, setIsStartingMic] = useState(false);

  // OLED Blackout Mode (pocket/bedtime zero-glare shield while recording)
  const [blackoutActive, setBlackoutActive] = useState(false);
  const [blackoutWakeArmed, setBlackoutWakeArmed] = useState(false);
  const blackoutWakeTimerRef = useRef<number | null>(null);

  // Modals
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveKeepMaster, setSaveKeepMaster] = useState(settings.keepLocalMaster);
  const [isSaving, setIsSaving] = useState(false);
  const [encodeProgress, setEncodeProgress] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmExitOpen, setConfirmExitOpen] = useState(false);

  useEffect(() => {
    void probeAudioCapabilities().then(setCaps);
  }, []);

  useEffect(() => {
    if (snap.phase !== 'recording' && blackoutActive) {
      setBlackoutActive(false);
      setBlackoutWakeArmed(false);
    }
  }, [blackoutActive, snap.phase]);

  useEffect(() => {
    return () => {
      if (blackoutWakeTimerRef.current !== null) {
        window.clearTimeout(blackoutWakeTimerRef.current);
      }
    };
  }, []);

  const handleBlackoutTap = () => {
    if (blackoutWakeArmed) {
      if (blackoutWakeTimerRef.current !== null) {
        window.clearTimeout(blackoutWakeTimerRef.current);
        blackoutWakeTimerRef.current = null;
      }
      setBlackoutWakeArmed(false);
      setBlackoutActive(false);
      return;
    }
    setBlackoutWakeArmed(true);
    if (blackoutWakeTimerRef.current !== null) {
      window.clearTimeout(blackoutWakeTimerRef.current);
    }
    blackoutWakeTimerRef.current = window.setTimeout(() => {
      blackoutWakeTimerRef.current = null;
      setBlackoutWakeArmed(false);
    }, 2500);
  };

  // Subscribe once for the lifetime of the view; dispose only on true unmount
  useEffect(() => {
    const engine = engineRef.current!;
    const unsub = engine.subscribe(setSnap);
    return () => {
      unsub();
      void engine.dispose();
    };
  }, []);

  // Load recoverable draft separately without tearing down engine subscriptions
  useEffect(() => {
    if (!resumeDraftId) return;
    void engineRef.current?.loadDraft(resumeDraftId);
  }, [resumeDraftId]);

  const hasUnsaved = snap.durationMs > 0 || snap.phase === 'recording';

  // Warn before accidental browser refresh/close while audio is unsaved
  useEffect(() => {
    if (!hasUnsaved) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasUnsaved]);

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
    if (isStartingMic) return;
    setStudioError(null);
    const engine = engineRef.current!;
    try {
      if (snap.phase === 'recording') {
        await engine.pause();
      } else {
        setIsStartingMic(true);
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
    } finally {
      setIsStartingMic(false);
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
    setSaveKeepMaster(settings.keepLocalMaster);
    setSaveError(null);
    setEncodeProgress(0);
    setSaveOpen(true);
  };

  const handleStopHere = async () => {
    if (snap.durationMs === 0 || snap.playheadMs < 150) return;
    const res = await engineRef.current!.trimToPlayhead();
    if (res.newDurationMs <= 0) return;
    setSaveKeepMaster(settings.keepLocalMaster);
    setSaveError(null);
    setEncodeProgress(0);
    setSaveOpen(true);
  };

  const handleConfirmSave = async (name: string, notes: string) => {
    setIsSaving(true);
    setSaveError(null);
    setEncodeProgress(0.05);
    try {
      const { encoded, localMaster, durationMs, overviewPeaks, deviceLabel } =
        await engineRef.current!.finalizeAndEncode(
          settings.audioQuality,
          (ratio) => setEncodeProgress(ratio),
          { captureLocalMaster: saveKeepMaster },
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
        localMaster,
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

  const handleRequestDiscard = () => {
    confirm({
      title: 'Discard this Take?',
      description: `This will permanently remove the current ${formatDurationMs(snap.durationMs)} unsaved recording.`,
      confirmLabel: 'Discard Take',
      cancelLabel: 'Keep Recording',
      tone: 'danger',
      onConfirm: async () => {
        await engineRef.current!.discard();
        onToast('Take discarded');
      },
    });
  };

  const statusLabel = isStartingMic
    ? 'STARTING…'
    : snap.phase === 'recording'
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
            engine={engineRef.current ?? undefined}
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

        {snap.captureWarning && (
          <div
            className="studio-warning-banner"
            role="status"
            data-testid="studio-capture-warning"
          >
            <span className="studio-warning-banner__text">
              {snap.captureWarning}
            </span>
            <button
              type="button"
              className="studio-warning-banner__dismiss"
              onClick={() => engineRef.current!.dismissCaptureWarning()}
              aria-label="Dismiss recording notice"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {/* Paused review controls + contextual Punch-In ("Re-record from here") or live Blackout button */}
        <section className="studio-review-zone" aria-label="Playback review controls">
          {snap.phase === 'recording' && (
            <button
              type="button"
              className="studio-blackout-btn"
              data-testid="blackout-mode-btn"
              onClick={() => setBlackoutActive(true)}
            >
              <Moon size={14} />
              Blackout screen
            </button>
          )}
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
                    <>
                      <button
                        type="button"
                        className="btn btn-amber btn-sm"
                        onClick={() => void handlePunchIn()}
                        id="punch-in-btn"
                      >
                        <Scissors size={14} />
                        Re-record from {formatDurationMs(snap.playheadMs)}
                      </button>

                      {snap.playheadMs >= 150 && (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => void handleStopHere()}
                          id="trim-stop-here-btn"
                        >
                          <Square size={12} fill="currentColor" />
                          Stop here ({formatDurationMs(snap.playheadMs)})
                        </button>
                      )}
                    </>
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
                  onClick={handleRequestDiscard}
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
        keepLocalMaster={saveKeepMaster}
        estimatedMasterBytes={Math.round(
          (snap.durationMs / 1000) * snap.actualSampleRate * snap.channels * 4 + 44,
        )}
        isPreviewPlaying={snap.phase === 'playing'}
        isSaving={isSaving}
        encodeProgress={encodeProgress}
        errorMessage={saveError}
        onToggleKeepLocalMaster={setSaveKeepMaster}
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
      {/* Pure-black OLED pocket/bedtime blackout shield (double-tap to wake) */}
      {blackoutActive && snap.phase === 'recording' && (
        <button
          type="button"
          className="studio-blackout-overlay"
          data-testid="studio-blackout-overlay"
          aria-label="Blackout recording screen. Tap twice to wake."
          onClick={handleBlackoutTap}
        >
          <span className="studio-blackout-overlay__rec">
            <span className="studio-blackout-overlay__dot" aria-hidden="true" />
            Recording
          </span>
          <span className="studio-blackout-overlay__timer">
            {formatDurationMs(snap.playheadMs)}
          </span>
          <span
            className={`studio-blackout-overlay__hint ${blackoutWakeArmed ? 'studio-blackout-overlay__hint--armed' : ''}`}
          >
            {blackoutWakeArmed
              ? 'Tap once more to wake screen'
              : 'Tap twice to wake screen'}
          </span>
        </button>
      )}
    </div>
  );
};
