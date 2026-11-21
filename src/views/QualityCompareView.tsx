import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Download,
  FlaskConical,
  Headphones,
  Loader2,
  Mic,
  Sliders,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react';
import type {
  AudioDeviceSettings,
  AudioFormatOption,
  AudioQualitySettings,
  BitrateKbpsOption,
  BookProject,
  Recording,
  SampleRateOption,
} from '../types/models';
import {
  AbComparePlayer,
  type CompareTrackSlot,
} from '../audio/abComparePlayer';
import type { CapturedMicTestAudio } from '../audio/audioDevices';
import {
  type BlindChoice,
  type BlindTierResult,
  computeThresholdRecommendation,
  decodeAudioBlob,
  type DecodedPcmAudio,
  type ExportQualitySpec,
  slicePcmWindow,
  THRESHOLD_LADDER_KBPS,
  transcodePcm,
  type TranscodedExportResult,
} from '../audio/audioExporter';
import {
  type CodecCapabilities,
  detectMatchingPreset,
  probeAudioCapabilities,
} from '../audio/qualityPresets';
import { useMicTest } from '../hooks/useMicTest';
import { getRecordingBlob, getRecordingMaster } from '../storage/db';
import {
  formatBytes,
  formatDurationMs,
  formatSampleRate,
} from '../utils/format';
import {
  closestSampleRateOption,
  ExportFilesTab,
} from './quality-lab/ExportFilesTab';
import { SideBySideAbTab } from './quality-lab/SideBySideAbTab';
import {
  type BlindRevealInfo,
  ThresholdFinderTab,
} from './quality-lab/ThresholdFinderTab';
import './QualityCompareView.css';

type QualityLabTab = 'threshold' | 'ab' | 'export';

interface QualityCompareViewProps {
  project?: BookProject;
  recording?: Recording;
  micTestMode?: boolean;
  audioDevice?: AudioDeviceSettings;
  initialMicCapture?: CapturedMicTestAudio | null;
  onMicCaptureChange?: (capture: CapturedMicTestAudio) => void;
  onOpenSettings?: () => void;
  audioQuality: AudioQualitySettings;
  hasMiniPlayer: boolean;
  onBack: () => void;
  onApplyRecommendedQuality: (nextQuality: AudioQualitySettings) => void;
  onDeleteLocalMaster?: (recordingId: string) => Promise<void>;
  onResolveCloudBlob?: (recording: Recording) => Promise<Blob | null>;
  onToast: (message: string) => void;
}

const COMPARE_WINDOW_SEC = 12;
const DEFAULT_MIC_DEVICE: AudioDeviceSettings = {
  deviceId: 'default',
  deviceLabel: 'System Default Microphone',
};
const MIC_TEST_META = { orderIndex: 0, name: 'Mic Test' };

export const QualityCompareView: React.FC<QualityCompareViewProps> = ({
  project,
  recording,
  micTestMode = false,
  audioDevice,
  initialMicCapture = null,
  onMicCaptureChange,
  onOpenSettings,
  audioQuality,
  hasMiniPlayer,
  onBack,
  onApplyRecommendedQuality,
  onDeleteLocalMaster,
  onResolveCloudBlob,
  onToast,
}) => {
  const [activeTab, setActiveTab] = useState<QualityLabTab>('threshold');
  const [caps, setCaps] = useState<CodecCapabilities | null>(null);
  const [micCapture, setMicCapture] = useState<CapturedMicTestAudio | null>(
    initialMicCapture,
  );

  // Decoded source audio (local lossless master preferred; falls back to chapter audio)
  const [loadingSource, setLoadingSource] = useState(!micTestMode);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [usingLocalMaster, setUsingLocalMaster] = useState(
    Boolean(micTestMode && initialMicCapture),
  );
  const [sourceBlob, setSourceBlob] = useState<Blob | null>(
    micTestMode && initialMicCapture ? initialMicCapture.wavBlob : null,
  );
  const [fullPcm, setFullPcm] = useState<DecodedPcmAudio | null>(
    micTestMode && initialMicCapture ? initialMicCapture.pcm : null,
  );
  const [windowStartSec, setWindowStartSec] = useState(0);

  // Shared A/B audio player
  const playerRef = useRef<AbComparePlayer | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeSlot, setActiveSlot] = useState<CompareTrackSlot | null>(null);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [playDurationSec, setPlayDurationSec] = useState(0);

  // Tab 1: Guided Blind Threshold Finder
  const [blindFormat, setBlindFormat] = useState<AudioFormatOption>('auto');
  const [blindBitrate, setBlindBitrate] = useState<BitrateKbpsOption>(64);
  const [blindSampleRate, setBlindSampleRate] = useState<SampleRateOption>(48000);
  const [blindEncoding, setBlindEncoding] = useState(false);
  const [blindCandidate, setBlindCandidate] = useState<TranscodedExportResult | null>(null);
  const [aIsMaster, setAIsMaster] = useState<boolean>(() => Math.random() < 0.5);
  const [lastReveal, setLastReveal] = useState<BlindRevealInfo | null>(null);
  const [tierResults, setTierResults] = useState<Record<number, BlindTierResult>>({});

  // Tab 2: Open Side-by-Side A/B
  const [abSpec, setAbSpec] = useState<ExportQualitySpec>({
    format: 'auto',
    sampleRate: 48000,
    bitrateKbps: 96,
    bitrateMode: 'variable',
    wavBitDepth: 16,
  });
  const [abEncoding, setAbEncoding] = useState(false);
  const [abCandidate, setAbCandidate] = useState<TranscodedExportResult | null>(null);
  const [deletingMaster, setDeletingMaster] = useState(false);

  const effectiveMeta = useMemo(
    () =>
      recording
        ? { orderIndex: recording.orderIndex, name: recording.name }
        : MIC_TEST_META,
    [recording],
  );

  // Stable refs for parent callbacks so parent re-renders (e.g., toasts) never re-trigger audio decode/encode effects
  const onResolveCloudBlobRef = useRef(onResolveCloudBlob);
  onResolveCloudBlobRef.current = onResolveCloudBlob;
  const onToastRef = useRef(onToast);
  onToastRef.current = onToast;
  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  const effectiveMetaRef = useRef(effectiveMeta);
  effectiveMetaRef.current = effectiveMeta;

  const micTest = useMicTest({
    device: audioDevice ?? DEFAULT_MIC_DEVICE,
    quality: audioQuality,
    onFallbackToast: (msg) => onToastRef.current(msg),
  });

  // Initialize A/B engine & probe codec caps
  useEffect(() => {
    const ab = new AbComparePlayer();
    playerRef.current = ab;
    void probeAudioCapabilities().then(setCaps);
    return () => {
      ab.dispose();
      playerRef.current = null;
    };
  }, []);

  // Sync updated initialMicCapture from Settings (e.g. if user opens Settings while in Mic Test Lab)
  useEffect(() => {
    if (!micTestMode || !initialMicCapture) return;
    setMicCapture(initialMicCapture);
  }, [micTestMode, initialMicCapture]);

  const applyDefaultSampleRates = useCallback((sampleRate: number) => {
    const defaultSr = closestSampleRateOption(Math.min(48000, sampleRate));
    setBlindSampleRate(defaultSr);
    setAbSpec((prev) => ({ ...prev, sampleRate: defaultSr }));
  }, []);

  // Apply mic capture directly as lossless 32-bit Float master in Mic Test mode
  useEffect(() => {
    if (!micTestMode) return;
    setLoadingSource(false);
    setSourceError(null);
    setBlindCandidate(null);
    setAbCandidate(null);
    setTierResults({});
    setLastReveal(null);

    if (!micCapture) {
      setSourceBlob(null);
      setUsingLocalMaster(false);
      setFullPcm(null);
      return;
    }

    setSourceBlob(micCapture.wavBlob);
    setUsingLocalMaster(true);
    setFullPcm(micCapture.pcm);
    applyDefaultSampleRates(micCapture.pcm.sampleRate);
  }, [micTestMode, micCapture, applyDefaultSampleRates]);

  // Load source audio in Chapter mode (local master if available, else regular chapter blob)
  useEffect(() => {
    if (micTestMode || !recording) return;
    let cancelled = false;
    setLoadingSource(true);
    setSourceError(null);
    setFullPcm(null);
    setBlindCandidate(null);
    setAbCandidate(null);

    (async () => {
      try {
        const rec = recordingRef.current;
        if (!rec) return;
        const masterBlob = await getRecordingMaster(rec.id);
        let blob: Blob | null = masterBlob ?? null;
        const isMaster = Boolean(masterBlob);

        if (!blob) {
          blob = (await getRecordingBlob(rec.id)) ?? null;
        }
        if (!blob && onResolveCloudBlobRef.current) {
          blob = await onResolveCloudBlobRef.current(rec);
        }
        if (!blob) {
          throw new Error('Audio data is not available locally for this chapter.');
        }

        const decoded = await decodeAudioBlob(blob);
        if (cancelled) return;

        setSourceBlob(blob);
        setUsingLocalMaster(isMaster);
        setFullPcm(decoded);
        applyDefaultSampleRates(decoded.sampleRate);
      } catch (err) {
        if (!cancelled) {
          setSourceError(
            err instanceof Error ? err.message : 'Could not decode source audio.',
          );
        }
      } finally {
        if (!cancelled) setLoadingSource(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [micTestMode, recording?.id, recording?.hasLocalMaster, applyDefaultSampleRates]);

  // Extract looped comparison passage (full track if <= 20s, else 12s window)
  const comparePcm = useMemo(() => {
    if (!fullPcm) return null;
    if (fullPcm.durationMs / 1000 <= 20) return fullPcm;
    return slicePcmWindow(fullPcm, windowStartSec, COMPARE_WINDOW_SEC);
  }, [fullPcm, windowStartSec]);

  const fullReferenceBytes = useMemo(() => {
    if (sourceBlob) return sourceBlob.size;
    return recording?.localMasterBytes ?? recording?.fileSizeBytes ?? 1;
  }, [sourceBlob, recording?.localMasterBytes, recording?.fileSizeBytes]);

  const compareReferenceBytes = useMemo(() => {
    if (!fullPcm || !comparePcm) return fullReferenceBytes;
    const ratio = comparePcm.durationMs / Math.max(1, fullPcm.durationMs);
    return Math.max(1, Math.round(fullReferenceBytes * ratio));
  }, [fullPcm, comparePcm, fullReferenceBytes]);

  const stopPlayback = useCallback(() => {
    playerRef.current?.stop();
    setIsPlaying(false);
    setActiveSlot(null);
    setPlayheadSec(0);
  }, []);

  // Poll playhead smoothly while playing
  useEffect(() => {
    if (!isPlaying) return;
    let rafId = 0;
    const tick = () => {
      const ab = playerRef.current;
      if (ab) {
        setPlayheadSec(ab.getCurrentTimeSec());
        if (!ab.getIsPlaying()) {
          setIsPlaying(false);
          return;
        }
      }
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [isPlaying]);

  const loadComparePair = useCallback(
    async (candidate: TranscodedExportResult) => {
      if (!comparePcm || !playerRef.current) return;
      stopPlayback();
      const decodedCandidate = await decodeAudioBlob(candidate.encoded.blob);
      playerRef.current.loadBuffers(comparePcm, decodedCandidate);
      setPlayDurationSec(playerRef.current.getDurationSec());
      setPlayheadSec(0);
    },
    [comparePcm, stopPlayback],
  );

  // Unified auto-transcode effect for active comparison tab (Threshold or Side-by-Side A/B)
  const activeCompareSpec: ExportQualitySpec | null = useMemo(() => {
    if (activeTab === 'threshold') {
      return {
        format: blindFormat,
        sampleRate: blindSampleRate,
        bitrateKbps: blindBitrate,
        bitrateMode: 'variable',
        wavBitDepth: 16,
      };
    }
    if (activeTab === 'ab') return abSpec;
    return null;
  }, [activeTab, blindFormat, blindSampleRate, blindBitrate, abSpec]);

  useEffect(() => {
    if (!activeCompareSpec || !comparePcm) return;
    let cancelled = false;
    const isBlind = activeTab === 'threshold';
    if (isBlind) {
      setBlindEncoding(true);
      setLastReveal(null);
    } else {
      setAbEncoding(true);
    }
    stopPlayback();

    (async () => {
      try {
        const res = await transcodePcm(
          comparePcm,
          activeCompareSpec,
          effectiveMetaRef.current,
          compareReferenceBytes,
        );
        if (cancelled) return;
        if (isBlind) {
          setBlindCandidate(res);
          setAIsMaster(Math.random() < 0.5);
        } else {
          setAbCandidate(res);
        }
        await loadComparePair(res);
      } catch (err) {
        if (!cancelled) {
          onToastRef.current(
            err instanceof Error
              ? err.message
              : isBlind
                ? 'Could not encode test sample'
                : 'Could not encode A/B preview',
          );
        }
      } finally {
        if (!cancelled) {
          if (isBlind) setBlindEncoding(false);
          else setAbEncoding(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeTab,
    activeCompareSpec,
    comparePcm,
    compareReferenceBytes,
    loadComparePair,
    stopPlayback,
  ]);

  // Record / stop a fresh 32-bit Float test clip directly inside Quality Lab (Mic Test mode)
  const handleToggleMicRecord = async () => {
    if (micTest.isTesting) {
      const captured = micTest.stop();
      if (captured) {
        setMicCapture(captured);
        onMicCaptureChange?.(captured);
        onToast(
          `Captured ${formatDurationMs(captured.pcm.durationMs)} lossless test clip`,
        );
      } else {
        micTest.setError(
          'Recording was too short — speak for at least half a second.',
        );
      }
      return;
    }
    stopPlayback();
    await micTest.start();
  };

  const handleToggleSlot = async (slot: CompareTrackSlot) => {
    const ab = playerRef.current;
    if (!ab) return;
    if (ab.getIsPlaying() && ab.getActiveSlot() === slot) {
      ab.pause();
      setIsPlaying(false);
      setActiveSlot(ab.getActiveSlot());
      setPlayheadSec(ab.getCurrentTimeSec());
      return;
    }
    if (ab.getActiveSlot() !== slot) {
      setPlayheadSec(0);
    }
    setActiveSlot(slot);
    await ab.play(slot);
    setIsPlaying(ab.getIsPlaying());
    setActiveSlot(ab.getActiveSlot());
    setPlayheadSec(ab.getCurrentTimeSec());
  };

  const handleBlindVote = (pickedLabel: 'A' | 'B' | 'same') => {
    if (!blindCandidate) return;
    stopPlayback();

    const choice: BlindChoice =
      pickedLabel === 'same'
        ? 'cant_tell'
        : (pickedLabel === 'A') === aIsMaster
          ? 'master'
          : 'compressed';

    const fullDurationMin = Math.max(
      0.001,
      (fullPcm?.durationMs ?? recording?.durationMs ?? 1000) / 60_000,
    );
    const estFullBytes = Math.round(blindCandidate.bytesPerMinute * fullDurationMin);

    setTierResults((prev) => {
      const cur = prev[blindBitrate];
      return {
        ...prev,
        [blindBitrate]: {
          bitrateKbps: blindBitrate,
          achievedBitrateKbps: blindCandidate.encoded.bitrateKbps,
          extension: blindCandidate.encoded.extension,
          sampleRate: blindCandidate.encoded.sampleRate,
          encodedBytes: estFullBytes,
          bytesPerMinute: blindCandidate.bytesPerMinute,
          savingsPercent: blindCandidate.savingsPercent,
          trials: (cur?.trials ?? 0) + 1,
          pickedMaster: (cur?.pickedMaster ?? 0) + (choice === 'master' ? 1 : 0),
          pickedCompressed:
            (cur?.pickedCompressed ?? 0) + (choice === 'compressed' ? 1 : 0),
          cantTell: (cur?.cantTell ?? 0) + (choice === 'cant_tell' ? 1 : 0),
        },
      };
    });

    setLastReveal({
      bitrateKbps: blindBitrate,
      aWasMaster: aIsMaster,
      choice,
      pickedLabel,
      encodedBytes: estFullBytes,
      savingsPercent: blindCandidate.savingsPercent,
      extension: blindCandidate.encoded.extension.toUpperCase(),
    });
  };

  const handleNextBlindTrial = () => {
    stopPlayback();
    setLastReveal(null);
    setAIsMaster(Math.random() < 0.5);
  };

  const handleAdvanceBitrate = () => {
    const idx = THRESHOLD_LADDER_KBPS.indexOf(blindBitrate);
    if (idx >= 0 && idx < THRESHOLD_LADDER_KBPS.length - 1) {
      setBlindBitrate(THRESHOLD_LADDER_KBPS[idx + 1]);
    } else {
      handleNextBlindTrial();
    }
  };

  const recommendation = useMemo(
    () => computeThresholdRecommendation(tierResults),
    [tierResults],
  );

  const handleApplyRecommendation = () => {
    if (!recommendation) return;
    const format: AudioFormatOption =
      recommendation.extension === 'wav' ? 'wav' : recommendation.extension;
    const nextQuality: AudioQualitySettings = {
      ...audioQuality,
      format,
      bitrateKbps: recommendation.recommendedKbps,
      sampleRate: closestSampleRateOption(recommendation.sampleRate),
    };
    nextQuality.preset = detectMatchingPreset(nextQuality);
    onApplyRecommendedQuality(nextQuality);
    onToast(
      `Recording quality set to ${recommendation.recommendedKbps} kbps ${recommendation.extension.toUpperCase()}`,
    );
  };

  const handleDeleteMasterClick = async () => {
    if (!recording || !onDeleteLocalMaster) return;
    setDeletingMaster(true);
    try {
      stopPlayback();
      await onDeleteLocalMaster(recording.id);
    } finally {
      setDeletingMaster(false);
    }
  };

  const fullDurationSec =
    (fullPcm?.durationMs ?? recording?.durationMs ?? 0) / 1000;
  const maxWindowStart = Math.max(0, Math.floor(fullDurationSec - COMPARE_WINDOW_SEC));
  const activeMicLabel =
    micTest.telemetry?.actualDeviceLabel ||
    micCapture?.deviceLabel ||
    audioDevice?.deviceLabel ||
    'System Default Microphone';
  const exportSourceKey = micTestMode
    ? `mic-${micCapture?.capturedAt ?? 0}`
    : `rec-${recording?.id ?? ''}-${recording?.hasLocalMaster ? 'm' : 'c'}`;

  return (
    <div
      className={`quality-lab-page ${hasMiniPlayer ? 'quality-lab-page--with-mini' : ''}`}
      data-testid="quality-lab-view"
    >
      <header className="quality-lab-topbar">
        <div className="app-container quality-lab-topbar__inner">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              micTest.stop();
              stopPlayback();
              onBack();
            }}
            aria-label={micTestMode ? 'Back to library' : 'Back to book'}
          >
            <ArrowLeft size={17} />
            {micTestMode ? 'Library' : 'Book'}
          </button>

          <span className="quality-lab-topbar__title">
            <FlaskConical size={16} />
            Quality Lab
          </span>

          {micTestMode && onOpenSettings ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                if (micTest.isTesting) void handleToggleMicRecord();
                stopPlayback();
                onOpenSettings();
              }}
              aria-label="Open Studio Settings"
            >
              <Sliders size={14} />
              Settings
            </button>
          ) : recording?.hasLocalMaster && onDeleteLocalMaster ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm quality-lab-topbar__delete"
              onClick={() => void handleDeleteMasterClick()}
              disabled={deletingMaster}
              aria-label="Delete local lossless master"
              data-testid="delete-local-master-btn"
            >
              <Trash2 size={14} />
              Free Master
            </button>
          ) : (
            <span style={{ width: 48 }} aria-hidden="true" />
          )}
        </div>
      </header>

      <main className="app-container quality-lab-content">
        {/* Source Summary Banner */}
        <section className="ql-source-card" data-testid="quality-lab-source">
          <div className="ql-source-card__top">
            <div className="ql-source-card__titles">
              <h1 className="ql-source-card__chapter">
                {micTestMode ? 'Microphone Test Clip' : recording?.name || 'Recording'}
              </h1>
              <span className="ql-source-card__book">
                {micTestMode ? activeMicLabel : project?.title || ''}
              </span>
            </div>
            <span
              className={`badge ${usingLocalMaster ? 'badge-sage' : 'badge-amber'}`}
              data-testid="quality-lab-source-badge"
            >
              {micTestMode
                ? fullPcm
                  ? 'Lossless Master'
                  : 'Ready to Record'
                : usingLocalMaster
                  ? 'Lossless Master'
                  : 'Chapter Source'}
            </span>
          </div>

          {fullPcm && (
            <div className="ql-source-card__specs font-mono">
              <span>{formatDurationMs(fullPcm.durationMs)}</span>
              <span>·</span>
              <span>{formatSampleRate(fullPcm.sampleRate)}</span>
              <span>·</span>
              <span>
                {usingLocalMaster
                  ? `${fullPcm.bitDepth === 32 ? '32-bit Float' : `${fullPcm.bitDepth ?? 24}-bit`} WAV`
                  : `${(recording?.extension ?? 'm4a').toUpperCase()}${recording?.bitrateKbps ? ` ${recording.bitrateKbps}k` : ''}`}
              </span>
              <span>·</span>
              <span>{formatBytes(fullReferenceBytes)}</span>
            </div>
          )}

          {micTestMode && (
            <div className="ql-mic-recorder" data-testid="ql-mic-recorder">
              <div className="ql-mic-recorder__row">
                <span className="font-mono ql-muted-mono">
                  {micTest.isTesting
                    ? `${micTest.telemetry ? `${micTest.telemetry.db.toFixed(0)} dB` : 'Listening…'} · ${formatDurationMs(micTest.telemetry?.capturedDurationMs ?? 0)}`
                    : fullPcm
                      ? 'Record a fresh sample anytime using your Settings mic'
                      : 'Speak a short test sentence to benchmark bitrates'}
                </span>
                <button
                  type="button"
                  className={`btn btn-sm ${micTest.isTesting ? 'btn-danger' : 'btn-primary'}`}
                  onClick={() => void handleToggleMicRecord()}
                  data-testid="ql-mic-record-btn"
                >
                  {micTest.isTesting ? (
                    <>
                      <Square size={13} fill="currentColor" />
                      Stop Recording
                    </>
                  ) : (
                    <>
                      <Mic size={14} />
                      {fullPcm ? 'Re-record Clip' : 'Record Test Clip'}
                    </>
                  )}
                </button>
              </div>

              {micTest.isTesting && (
                <div className="ql-mic-recorder__meter" aria-hidden="true">
                  <div
                    className={`ql-mic-recorder__fill ${
                      micTest.telemetry?.clipping
                        ? 'ql-mic-recorder__fill--clip'
                        : (micTest.telemetry?.level ?? 0) > 0.72
                          ? 'ql-mic-recorder__fill--hot'
                          : ''
                    }`}
                    style={{
                      width: `${Math.min(100, Math.round((micTest.telemetry?.level ?? 0) * 100))}%`,
                    }}
                  />
                </div>
              )}

              {micTest.error && (
                <span className="badge badge-danger">{micTest.error}</span>
              )}
            </div>
          )}

          {!micTestMode && !loadingSource && !usingLocalMaster && (
            <p className="ql-source-card__hint">
              Comparing from the saved chapter file. Turn on{' '}
              <strong>Save Local Lossless Master</strong> in Studio Settings for
              future recordings to benchmark directly against uncompressed 32-bit
              Float capture.
            </p>
          )}

          {fullPcm && fullDurationSec > 20 && (
            <div className="ql-window-picker">
              <div className="ql-window-picker__row">
                <span className="field-label">A/B Loop Passage ({COMPARE_WINDOW_SEC}s)</span>
                <span className="font-mono" style={{ fontSize: 12, color: 'var(--accent-amber)' }}>
                  {formatDurationMs(windowStartSec * 1000)} –{' '}
                  {formatDurationMs(
                    Math.min(fullDurationSec, windowStartSec + COMPARE_WINDOW_SEC) * 1000,
                  )}
                </span>
              </div>
              <input
                type="range"
                className="range-slider"
                min={0}
                max={maxWindowStart}
                step={1}
                value={windowStartSec}
                onChange={(e) => setWindowStartSec(Number(e.target.value))}
                aria-label="Select comparison passage start time"
              />
            </div>
          )}
        </section>

        {/* Segmented Tab Bar */}
        <div className="ql-tabs" role="tablist" aria-label="Quality Lab modes">
          {(
            [
              { id: 'threshold', label: 'Threshold', icon: <Sparkles size={14} /> },
              { id: 'ab', label: 'A/B Listen', icon: <Headphones size={14} /> },
              { id: 'export', label: 'Export', icon: <Download size={14} /> },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`ql-tab ${activeTab === tab.id ? 'ql-tab--active' : ''}`}
              onClick={() => {
                stopPlayback();
                setActiveTab(tab.id);
              }}
              data-testid={`ql-tab-${tab.id}`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        {loadingSource ? (
          <div className="ql-loading-box">
            <Loader2 size={22} className="spin" />
            <span>Decoding master audio…</span>
          </div>
        ) : sourceError ? (
          <div className="ql-error-box" role="alert">
            {sourceError}
          </div>
        ) : !fullPcm ? (
          <div className="ql-empty-mic-card" data-testid="ql-empty-mic-card">
            <Mic size={24} color="var(--accent-amber)" />
            <span>
              Tap <strong>Record Test Clip</strong> above (or run{' '}
              <strong>Test Mic</strong> in Studio Settings) to capture an
              uncompressed 32-bit Float sample from{' '}
              <strong>{activeMicLabel}</strong> and compare bitrates side by side.
            </span>
          </div>
        ) : activeTab === 'threshold' ? (
          <ThresholdFinderTab
            caps={caps}
            usingLocalMaster={usingLocalMaster}
            blindFormat={blindFormat}
            blindBitrate={blindBitrate}
            blindSampleRate={blindSampleRate}
            blindEncoding={blindEncoding}
            blindCandidate={blindCandidate}
            aIsMaster={aIsMaster}
            lastReveal={lastReveal}
            tierResults={tierResults}
            recommendation={recommendation}
            isPlaying={isPlaying}
            activeSlot={activeSlot}
            playheadSec={playheadSec}
            playDurationSec={playDurationSec}
            onChangeFormat={setBlindFormat}
            onChangeBitrate={setBlindBitrate}
            onToggleSlot={(slot) => void handleToggleSlot(slot)}
            onVote={handleBlindVote}
            onNextTrial={handleNextBlindTrial}
            onAdvanceBitrate={handleAdvanceBitrate}
            onApplyRecommendation={handleApplyRecommendation}
          />
        ) : activeTab === 'ab' ? (
          <SideBySideAbTab
            spec={abSpec}
            caps={caps}
            encoding={abEncoding}
            candidate={abCandidate}
            compareReferenceBytes={compareReferenceBytes}
            isPlaying={isPlaying}
            activeSlot={activeSlot}
            playheadSec={playheadSec}
            playDurationSec={playDurationSec}
            onChangeSpec={(patch) => setAbSpec((prev) => ({ ...prev, ...patch }))}
            onToggleSlot={(slot) => void handleToggleSlot(slot)}
          />
        ) : (
          <ExportFilesTab
            key={exportSourceKey}
            fullPcm={fullPcm}
            sourceBlob={sourceBlob}
            usingLocalMaster={usingLocalMaster}
            fullReferenceBytes={fullReferenceBytes}
            caps={caps}
            effectiveMeta={effectiveMeta}
            shareTitle={
              project && recording
                ? `${project.title} — ${recording.name}`
                : 'StoryTape Mic Test'
            }
            onToast={onToast}
          />
        )}
      </main>
    </div>
  );
};
