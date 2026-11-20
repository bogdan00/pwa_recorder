import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Download,
  Eye,
  FlaskConical,
  Headphones,
  Loader2,
  Mic,
  Pause,
  Play,
  RefreshCw,
  Share2,
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
  BitrateModeOption,
  BookProject,
  Recording,
  SampleRateOption,
  WavBitDepthOption,
} from '../types/models';
import {
  AbComparePlayer,
  type CompareTrackSlot,
} from '../audio/abComparePlayer';
import {
  type CapturedMicTestAudio,
  MicLevelTester,
  type MicTestTelemetry,
} from '../audio/audioDevices';
import {
  type BlindChoice,
  type BlindTierResult,
  buildExportFileName,
  classifyBlindTier,
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
  BITRATE_OPTIONS,
  type CodecCapabilities,
  detectMatchingPreset,
  probeAudioCapabilities,
  resolveEffectiveFormat,
  SAMPLE_RATE_OPTIONS,
  WAV_BIT_DEPTH_OPTIONS,
} from '../audio/qualityPresets';
import { shareAudioChapter } from '../drive/shareUtils';
import { getRecordingBlob, getRecordingMaster } from '../storage/db';
import {
  formatBytes,
  formatDurationMs,
  formatSampleRate,
} from '../utils/format';
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
const DEFAULT_BATCH_TIERS: BitrateKbpsOption[] = [32, 64, 96, 128, 192, 320];

function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function closestSampleRateOption(rate: number): SampleRateOption {
  const options: SampleRateOption[] = [16000, 24000, 44100, 48000, 96000];
  let best: SampleRateOption = 48000;
  let bestDiff = Infinity;
  for (const opt of options) {
    const diff = Math.abs(opt - rate);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = opt;
    }
  }
  return best;
}

interface BlindRevealInfo {
  bitrateKbps: BitrateKbpsOption;
  aWasMaster: boolean;
  choice: BlindChoice;
  pickedLabel: 'A' | 'B' | 'same';
  encodedBytes: number;
  savingsPercent: number;
  extension: string;
}

const MIC_TEST_META = {
  orderIndex: 0,
  name: 'Mic Test',
};

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

  // Mic Test Mode live recorder state
  const [micCapture, setMicCapture] = useState<CapturedMicTestAudio | null>(
    initialMicCapture,
  );
  const [recordingMicClip, setRecordingMicClip] = useState(false);
  const [micTelemetry, setMicTelemetry] = useState<MicTestTelemetry | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const micTesterRef = useRef<MicLevelTester | null>(null);

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

  // Shared synchronized A/B audio player
  const playerRef = useRef<AbComparePlayer | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeSlot, setActiveSlot] = useState<CompareTrackSlot>('master');
  const [playheadSec, setPlayheadSec] = useState(0);
  const [playDurationSec, setPlayDurationSec] = useState(0);

  // ---- Tab 1: Guided Blind Threshold Finder ----
  const [blindFormat, setBlindFormat] = useState<AudioFormatOption>('auto');
  const [blindBitrate, setBlindBitrate] = useState<BitrateKbpsOption>(64);
  const [blindSampleRate, setBlindSampleRate] = useState<SampleRateOption>(48000);
  const [blindEncoding, setBlindEncoding] = useState(false);
  const [blindCandidate, setBlindCandidate] = useState<TranscodedExportResult | null>(null);
  const [aIsMaster, setAIsMaster] = useState<boolean>(() => Math.random() < 0.5);
  const [lastReveal, setLastReveal] = useState<BlindRevealInfo | null>(null);
  const [tierResults, setTierResults] = useState<Record<number, BlindTierResult>>({});

  // ---- Tab 2: Open Side-by-Side A/B ----
  const [abFormat, setAbFormat] = useState<AudioFormatOption>('auto');
  const [abSampleRate, setAbSampleRate] = useState<SampleRateOption>(48000);
  const [abBitrate, setAbBitrate] = useState<BitrateKbpsOption>(96);
  const [abBitrateMode, setAbBitrateMode] = useState<BitrateModeOption>('variable');
  const [abWavBitDepth, setAbWavBitDepth] = useState<WavBitDepthOption>(16);
  const [abEncoding, setAbEncoding] = useState(false);
  const [abCandidate, setAbCandidate] = useState<TranscodedExportResult | null>(null);

  // ---- Tab 3: Single & Batch Export ----
  const [exportFormat, setExportFormat] = useState<AudioFormatOption>('auto');
  const [exportSampleRate, setExportSampleRate] = useState<SampleRateOption>(48000);
  const [exportBitrate, setExportBitrate] = useState<BitrateKbpsOption>(128);
  const [exportBitrateMode, setExportBitrateMode] = useState<BitrateModeOption>('variable');
  const [exportWavBitDepth, setExportWavBitDepth] = useState<WavBitDepthOption>(24);
  const [singleExporting, setSingleExporting] = useState(false);
  const [singleResult, setSingleResult] = useState<TranscodedExportResult | null>(null);

  const [batchFormat, setBatchFormat] = useState<AudioFormatOption>('auto');
  const [batchTiers, setBatchTiers] = useState<BitrateKbpsOption[]>(DEFAULT_BATCH_TIERS);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgressText, setBatchProgressText] = useState<string | null>(null);
  const [batchResults, setBatchResults] = useState<TranscodedExportResult[]>([]);

  // Master deletion confirmation
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

  // Initialize A/B engine & probe codec caps; clean up mic tester on unmount
  useEffect(() => {
    const ab = new AbComparePlayer();
    playerRef.current = ab;
    void probeAudioCapabilities().then(setCaps);
    return () => {
      micTesterRef.current?.stop();
      micTesterRef.current = null;
      ab.dispose();
      playerRef.current = null;
    };
  }, []);

  // Sync updated initialMicCapture from Settings (e.g. if user opens Settings while in Mic Test Lab)
  useEffect(() => {
    if (!micTestMode || !initialMicCapture) return;
    setMicCapture(initialMicCapture);
  }, [micTestMode, initialMicCapture]);

  // Apply mic capture directly as lossless 32-bit Float master in Mic Test mode
  useEffect(() => {
    if (!micTestMode) return;
    setLoadingSource(false);
    setSourceError(null);
    setBlindCandidate(null);
    setAbCandidate(null);
    setBatchResults([]);
    setSingleResult(null);
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
    const defaultSr = closestSampleRateOption(
      Math.min(48000, micCapture.pcm.sampleRate),
    );
    setBlindSampleRate(defaultSr);
    setAbSampleRate(defaultSr);
    setExportSampleRate(closestSampleRateOption(micCapture.pcm.sampleRate));
  }, [micTestMode, micCapture]);

  // Load source audio in Chapter mode (local master if available, else regular chapter blob)
  useEffect(() => {
    if (micTestMode || !recording) return;
    let cancelled = false;
    setLoadingSource(true);
    setSourceError(null);
    setFullPcm(null);
    setBlindCandidate(null);
    setAbCandidate(null);
    setBatchResults([]);
    setSingleResult(null);

    (async () => {
      try {
        const rec = recordingRef.current;
        if (!rec) return;
        const masterBlob = await getRecordingMaster(rec.id);
        let blob: Blob | null = masterBlob ?? null;
        let isMaster = Boolean(masterBlob);

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

        const defaultSr = closestSampleRateOption(Math.min(48000, decoded.sampleRate));
        setBlindSampleRate(defaultSr);
        setAbSampleRate(defaultSr);
        setExportSampleRate(closestSampleRateOption(decoded.sampleRate));
      } catch (err) {
        if (!cancelled) {
          setSourceError(
            err instanceof Error ? err.message : 'Could not decode source audio.',
          );
        }
      } finally {
        if (!cancelled) {
          setLoadingSource(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [micTestMode, recording?.id, recording?.hasLocalMaster]);

  // Extract looped comparison passage (full track if <= 20s, else 12s window)
  const comparePcm = useMemo(() => {
    if (!fullPcm) return null;
    const totalSec = fullPcm.durationMs / 1000;
    if (totalSec <= 20) return fullPcm;
    return slicePcmWindow(fullPcm, windowStartSec, COMPARE_WINDOW_SEC);
  }, [fullPcm, windowStartSec]);

  // Reference byte count for the active comparison passage (used for accurate % savings)
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

  // Load pair into AbComparePlayer whenever candidate changes on the active tab
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

  // Auto-encode candidate for Tab 1 (Find Threshold) whenever bitrate/format/window changes
  useEffect(() => {
    if (activeTab !== 'threshold' || !comparePcm) return;
    let cancelled = false;
    setBlindEncoding(true);
    setLastReveal(null);
    stopPlayback();

    const spec: ExportQualitySpec = {
      format: blindFormat,
      sampleRate: blindSampleRate,
      bitrateKbps: blindBitrate,
      bitrateMode: 'variable',
      wavBitDepth: 16,
    };

    (async () => {
      try {
        const res = await transcodePcm(
          comparePcm,
          spec,
          effectiveMetaRef.current,
          compareReferenceBytes,
        );
        if (cancelled) return;
        setBlindCandidate(res);
        setAIsMaster(Math.random() < 0.5);
        await loadComparePair(res);
      } catch (err) {
        if (!cancelled) {
          onToastRef.current(
            err instanceof Error ? err.message : 'Could not encode test sample',
          );
        }
      } finally {
        if (!cancelled) setBlindEncoding(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeTab,
    comparePcm,
    blindFormat,
    blindBitrate,
    blindSampleRate,
    compareReferenceBytes,
    loadComparePair,
    stopPlayback,
  ]);

  // Auto-encode candidate for Tab 2 (Side-by-Side A/B) whenever settings change
  useEffect(() => {
    if (activeTab !== 'ab' || !comparePcm) return;
    let cancelled = false;
    setAbEncoding(true);
    stopPlayback();

    const spec: ExportQualitySpec = {
      format: abFormat,
      sampleRate: abSampleRate,
      bitrateKbps: abBitrate,
      bitrateMode: abBitrateMode,
      wavBitDepth: abWavBitDepth,
    };

    (async () => {
      try {
        const res = await transcodePcm(
          comparePcm,
          spec,
          effectiveMetaRef.current,
          compareReferenceBytes,
        );
        if (cancelled) return;
        setAbCandidate(res);
        await loadComparePair(res);
      } catch (err) {
        if (!cancelled) {
          onToastRef.current(
            err instanceof Error ? err.message : 'Could not encode A/B preview',
          );
        }
      } finally {
        if (!cancelled) setAbEncoding(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeTab,
    comparePcm,
    abFormat,
    abSampleRate,
    abBitrate,
    abBitrateMode,
    abWavBitDepth,
    compareReferenceBytes,
    loadComparePair,
    stopPlayback,
  ]);

  // Record / stop a fresh 32-bit Float test clip directly inside Quality Lab (Mic Test mode)
  const handleToggleMicRecord = async () => {
    if (recordingMicClip) {
      const tester = micTesterRef.current;
      micTesterRef.current = null;
      setRecordingMicClip(false);
      setMicTelemetry(null);
      if (tester) {
        tester.stop();
        const captured = tester.getCapturedAudio();
        if (captured) {
          setMicCapture(captured);
          onMicCaptureChange?.(captured);
          onToast(
            `Captured ${formatDurationMs(captured.pcm.durationMs)} lossless test clip`,
          );
        } else {
          setMicError('Recording was too short — speak for at least half a second.');
        }
      }
      return;
    }

    stopPlayback();
    setMicError(null);
    const tester = new MicLevelTester();
    micTesterRef.current = tester;
    setRecordingMicClip(true);
    try {
      const dev: AudioDeviceSettings = audioDevice ?? {
        deviceId: 'default',
        deviceLabel: 'System Default Microphone',
      };
      const res = await tester.start(dev, audioQuality, (t) =>
        setMicTelemetry(t),
      );
      if (res.usedFallback && res.fallbackReason) {
        onToast(res.fallbackReason);
      }
    } catch (err) {
      micTesterRef.current?.stop();
      micTesterRef.current = null;
      setRecordingMicClip(false);
      setMicTelemetry(null);
      setMicError(
        err instanceof Error ? err.message : 'Could not access microphone.',
      );
    }
  };

  // Stop playback when switching tabs
  const handleTabChange = (tab: QualityLabTab) => {
    stopPlayback();
    setActiveTab(tab);
  };

  const handlePlaySlot = async (slot: CompareTrackSlot) => {
    const ab = playerRef.current;
    if (!ab) return;
    setActiveSlot(slot);
    await ab.play(slot);
    setIsPlaying(true);
  };

  const handleTogglePause = () => {
    const ab = playerRef.current;
    if (!ab) return;
    if (isPlaying) {
      ab.pause();
      setIsPlaying(false);
    } else {
      void handlePlaySlot(activeSlot);
    }
  };

  // Blind trial voting handler
  const handleBlindVote = (pickedLabel: 'A' | 'B' | 'same') => {
    if (!blindCandidate) return;
    stopPlayback();

    let choice: BlindChoice;
    if (pickedLabel === 'same') {
      choice = 'cant_tell';
    } else if (pickedLabel === 'A') {
      choice = aIsMaster ? 'master' : 'compressed';
    } else {
      choice = aIsMaster ? 'compressed' : 'master';
    }

    // Scale candidate size to full recording duration for accurate display
    const fullDurationMin = Math.max(
      0.001,
      (fullPcm?.durationMs ?? recording?.durationMs ?? 1000) / 60_000,
    );
    const estFullBytes = Math.round(blindCandidate.bytesPerMinute * fullDurationMin);

    setTierResults((prev) => {
      const cur = prev[blindBitrate];
      const next: BlindTierResult = {
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
      };
      return { ...prev, [blindBitrate]: next };
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

  // Single full-chapter / mic-clip export
  const handleSingleExport = async (action: 'download' | 'share') => {
    if (!fullPcm) return;
    setSingleExporting(true);
    try {
      const spec: ExportQualitySpec = {
        format: exportFormat,
        sampleRate: exportSampleRate,
        bitrateKbps: exportBitrate,
        bitrateMode: exportBitrateMode,
        wavBitDepth: exportWavBitDepth,
      };
      const result = await transcodePcm(
        fullPcm,
        spec,
        effectiveMeta,
        fullReferenceBytes,
      );
      setSingleResult(result);

      if (action === 'download') {
        triggerBlobDownload(result.encoded.blob, result.fileName);
        onToast(`Exported ${result.fileName}`);
      } else {
        const shareTitle = project && recording
          ? `${project.title} — ${recording.name}`
          : 'StoryTape Mic Test';
        const outcome = await shareAudioChapter({
          blob: result.encoded.blob,
          fileName: result.fileName,
          title: shareTitle,
          text: `Exported ${effectiveMeta.name} (${result.fileName})`,
        });
        if (outcome === 'shared') onToast(`Shared ${result.fileName}`);
        else if (outcome === 'downloaded') onToast(`Downloaded ${result.fileName}`);
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setSingleExporting(false);
    }
  };

  const handleDownloadLosslessMaster = () => {
    if (!sourceBlob || !fullPcm) return;
    const fileName = buildExportFileName(
      effectiveMeta,
      {
        extension: 'wav',
        sampleRate: fullPcm.sampleRate,
        bitDepth: fullPcm.bitDepth ?? 32,
      },
      true,
    );
    triggerBlobDownload(sourceBlob, fileName);
    onToast(`Downloaded ${fileName}`);
  };

  // Batch comparison export
  const toggleBatchTier = (kbps: BitrateKbpsOption) => {
    setBatchTiers((prev) =>
      prev.includes(kbps)
        ? prev.filter((k) => k !== kbps)
        : [...prev, kbps].sort((a, b) => a - b),
    );
  };

  const handleRunBatchExport = async () => {
    if (!fullPcm || batchTiers.length === 0) return;
    setBatchRunning(true);
    setBatchResults([]);
    const results: TranscodedExportResult[] = [];
    const targetSr = closestSampleRateOption(Math.min(48000, fullPcm.sampleRate));

    try {
      for (let i = 0; i < batchTiers.length; i += 1) {
        const kbps = batchTiers[i];
        setBatchProgressText(
          `Encoding ${kbps} kbps (${i + 1} of ${batchTiers.length})…`,
        );
        const res = await transcodePcm(
          fullPcm,
          {
            format: batchFormat,
            sampleRate: targetSr,
            bitrateKbps: kbps,
            bitrateMode: 'variable',
            wavBitDepth: 16,
          },
          effectiveMeta,
          fullReferenceBytes,
        );
        results.push(res);
        setBatchResults([...results]);
      }
      onToast(`Encoded ${results.length} comparison files`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Batch export failed');
    } finally {
      setBatchRunning(false);
      setBatchProgressText(null);
    }
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

  const abEffectiveFmt = resolveEffectiveFormat(abFormat, caps);
  const exportEffectiveFmt = resolveEffectiveFormat(exportFormat, caps);
  const fullDurationSec =
    (fullPcm?.durationMs ?? recording?.durationMs ?? 0) / 1000;
  const maxWindowStart = Math.max(0, Math.floor(fullDurationSec - COMPARE_WINDOW_SEC));
  const activeMicLabel =
    micTelemetry?.actualDeviceLabel ||
    micCapture?.deviceLabel ||
    audioDevice?.deviceLabel ||
    'System Default Microphone';

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
              micTesterRef.current?.stop();
              micTesterRef.current = null;
              setRecordingMicClip(false);
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
                if (recordingMicClip) {
                  void handleToggleMicRecord();
                }
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

          {/* Embedded Mic Test Recorder Bar in Mic Test Mode */}
          {micTestMode && (
            <div className="ql-mic-recorder" data-testid="ql-mic-recorder">
              <div className="ql-mic-recorder__row">
                <span className="font-mono ql-muted-mono">
                  {recordingMicClip
                    ? `${micTelemetry ? `${micTelemetry.db.toFixed(0)} dB` : 'Listening…'} · ${formatDurationMs(micTelemetry?.capturedDurationMs ?? 0)}`
                    : fullPcm
                      ? 'Record a fresh sample anytime using your Settings mic'
                      : 'Speak a short test sentence to benchmark bitrates'}
                </span>
                <button
                  type="button"
                  className={`btn btn-sm ${recordingMicClip ? 'btn-danger' : 'btn-primary'}`}
                  onClick={() => void handleToggleMicRecord()}
                  data-testid="ql-mic-record-btn"
                >
                  {recordingMicClip ? (
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

              {recordingMicClip && (
                <div className="ql-mic-recorder__meter" aria-hidden="true">
                  <div
                    className={`ql-mic-recorder__fill ${
                      micTelemetry?.clipping
                        ? 'ql-mic-recorder__fill--clip'
                        : (micTelemetry?.level ?? 0) > 0.72
                          ? 'ql-mic-recorder__fill--hot'
                          : ''
                    }`}
                    style={{
                      width: `${Math.min(100, Math.round((micTelemetry?.level ?? 0) * 100))}%`,
                    }}
                  />
                </div>
              )}

              {micError && (
                <span className="badge badge-danger">{micError}</span>
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

          {/* Optional passage scrubber for long chapters (> 20s) */}
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
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'threshold'}
            className={`ql-tab ${activeTab === 'threshold' ? 'ql-tab--active' : ''}`}
            onClick={() => handleTabChange('threshold')}
            data-testid="ql-tab-threshold"
          >
            <Sparkles size={14} />
            Threshold
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'ab'}
            className={`ql-tab ${activeTab === 'ab' ? 'ql-tab--active' : ''}`}
            onClick={() => handleTabChange('ab')}
            data-testid="ql-tab-ab"
          >
            <Headphones size={14} />
            A/B Listen
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'export'}
            className={`ql-tab ${activeTab === 'export' ? 'ql-tab--active' : ''}`}
            onClick={() => handleTabChange('export')}
            data-testid="ql-tab-export"
          >
            <Download size={14} />
            Export
          </button>
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
        ) : (
          <>
            {/* ================================================================
                TAB 1: FIND THRESHOLD (Guided Blind A/B Test)
                ================================================================ */}
            {activeTab === 'threshold' && (
              <div className="ql-stack" data-testid="ql-panel-threshold">
                {/* Codec selector */}
                <div className="ql-card">
                  <div className="ql-card__head">
                    <span className="field-label">Test Codec</span>
                    <span className="font-mono ql-muted-mono">
                      {formatSampleRate(blindSampleRate)}
                    </span>
                  </div>
                  <div className="pill-grid">
                    {(
                      [
                        {
                          id: 'auto',
                          label: caps
                            ? `Auto (${caps.autoBestFormat.toUpperCase()})`
                            : 'Auto',
                        },
                        { id: 'm4a', label: 'M4A (AAC)' },
                        { id: 'webm', label: 'WebM (Opus)' },
                      ] as Array<{ id: AudioFormatOption; label: string }>
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={`opt-pill ${blindFormat === opt.id ? 'opt-pill--active' : ''}`}
                        onClick={() => setBlindFormat(opt.id)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>

                  {/* Bitrate ladder selector */}
                  <div className="field" style={{ marginTop: 12 }}>
                    <span className="field-label">Bitrate Ladder</span>
                    <div className="ql-ladder-grid">
                      {THRESHOLD_LADDER_KBPS.map((kbps) => {
                        const status = classifyBlindTier(tierResults[kbps]);
                        return (
                          <button
                            key={kbps}
                            type="button"
                            className={`ql-ladder-pill font-mono ${
                              blindBitrate === kbps ? 'ql-ladder-pill--active' : ''
                            } ${
                              status === 'audible'
                                ? 'ql-ladder-pill--audible'
                                : status === 'transparent'
                                  ? 'ql-ladder-pill--transparent'
                                  : ''
                            }`}
                            onClick={() => setBlindBitrate(kbps)}
                            data-testid={`ladder-tier-${kbps}`}
                          >
                            <span>{kbps}k</span>
                            {status !== 'untested' && (
                              <span className="ql-ladder-pill__dot" aria-hidden="true">
                                {status === 'transparent' ? '✓' : '!'}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Active Blind A/B Card */}
                <div className="ql-card" data-testid="blind-trial-card">
                  <div className="ql-card__head">
                    <h2 className="ql-card__title">
                      Blind Test · {blindBitrate} kbps
                    </h2>
                    {blindCandidate && (
                      <span className="badge badge-sage font-mono">
                        {blindCandidate.savingsPercent >= 0
                          ? `${blindCandidate.savingsPercent}% smaller`
                          : 'Same size'}
                      </span>
                    )}
                  </div>

                  <p className="ql-helper-text">
                    One sample is your{' '}
                    <strong>{usingLocalMaster ? 'Lossless Master' : 'Original'}</strong>{' '}
                    and the other is{' '}
                    <strong>
                      {blindCandidate?.encoded.bitrateKbps ?? blindBitrate} kbps{' '}
                      {(blindCandidate?.encoded.extension ?? 'm4a').toUpperCase()}
                    </strong>
                    {blindCandidate && (
                      <>
                        {' '}
                        (~{formatBytes(blindCandidate.bytesPerMinute)}/min). Switch
                        freely mid-sentence — can you hear a difference?
                      </>
                    )}
                  </p>

                  {blindEncoding ? (
                    <div className="ql-inline-loading">
                      <Loader2 size={16} className="spin" />
                      <span>Encoding {blindBitrate} kbps test sample…</span>
                    </div>
                  ) : (
                    <>
                      {/* Synchronized Sample A / Sample B buttons */}
                      <div className="ql-ab-grid">
                        <button
                          type="button"
                          className={`ql-sample-btn ${
                            isPlaying &&
                            ((aIsMaster && activeSlot === 'master') ||
                              (!aIsMaster && activeSlot === 'candidate'))
                              ? 'ql-sample-btn--playing'
                              : ''
                          }`}
                          onClick={() =>
                            void handlePlaySlot(aIsMaster ? 'master' : 'candidate')
                          }
                          data-testid="blind-play-a"
                        >
                          <Play size={16} />
                          <span>Sample A</span>
                        </button>

                        <button
                          type="button"
                          className={`ql-sample-btn ${
                            isPlaying &&
                            ((!aIsMaster && activeSlot === 'master') ||
                              (aIsMaster && activeSlot === 'candidate'))
                              ? 'ql-sample-btn--playing'
                              : ''
                          }`}
                          onClick={() =>
                            void handlePlaySlot(aIsMaster ? 'candidate' : 'master')
                          }
                          data-testid="blind-play-b"
                        >
                          <Play size={16} />
                          <span>Sample B</span>
                        </button>
                      </div>

                      {/* Live progress + pause */}
                      <div className="ql-transport-bar">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={handleTogglePause}
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

                      {/* Blind verdict or Reveal */}
                      {!lastReveal ? (
                        <div className="ql-verdict-block">
                          <span className="field-label">Which sounds cleaner?</span>
                          <div className="ql-verdict-grid">
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => handleBlindVote('A')}
                              data-testid="blind-vote-a"
                            >
                              A is better
                            </button>
                            <button
                              type="button"
                              className="btn btn-amber btn-sm"
                              onClick={() => handleBlindVote('same')}
                              data-testid="blind-vote-same"
                            >
                              Can&apos;t tell
                            </button>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => handleBlindVote('B')}
                              data-testid="blind-vote-b"
                            >
                              B is better
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div
                          className="ql-reveal-box"
                          role="status"
                          data-testid="blind-reveal-box"
                        >
                          <div className="ql-reveal-box__title">
                            <Eye size={15} />
                            {lastReveal.choice === 'master'
                              ? 'You spotted the Lossless Master!'
                              : lastReveal.choice === 'cant_tell'
                                ? 'Marked indistinguishable (transparent)'
                                : 'You actually preferred the compressed copy!'}
                          </div>
                          <p className="ql-reveal-box__detail">
                            <strong>Sample A</strong> was{' '}
                            {lastReveal.aWasMaster
                              ? 'Lossless Master'
                              : `${lastReveal.bitrateKbps} kbps ${lastReveal.extension}`}{' '}
                            · <strong>Sample B</strong> was{' '}
                            {lastReveal.aWasMaster
                              ? `${lastReveal.bitrateKbps} kbps ${lastReveal.extension}`
                              : 'Lossless Master'}
                            .
                          </p>
                          <div className="ql-reveal-box__actions">
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={handleNextBlindTrial}
                            >
                              <RefreshCw size={13} />
                              Retest {blindBitrate}k
                            </button>
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              onClick={handleAdvanceBitrate}
                              data-testid="blind-next-bitrate-btn"
                            >
                              Next Bitrate
                              <ArrowRight size={13} />
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* Recommended Sweet Spot Banner */}
                {recommendation && (
                  <div
                    className="ql-recommend-card"
                    data-testid="threshold-recommendation-card"
                  >
                    <div className="ql-recommend-card__head">
                      <CheckCircle2 size={18} color="var(--accent-sage)" />
                      <div>
                        <div className="ql-recommend-card__title">
                          Sweet Spot: {recommendation.recommendedKbps} kbps{' '}
                          {recommendation.extension.toUpperCase()}
                        </div>
                        <div className="ql-recommend-card__sub font-mono">
                          ~{formatBytes(recommendation.bytesPerMinute)}/min ·{' '}
                          {recommendation.savingsPercent}% smaller than master
                        </div>
                      </div>
                    </div>
                    <p className="ql-helper-text">{recommendation.reason}</p>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={handleApplyRecommendation}
                      data-testid="apply-recommended-quality-btn"
                    >
                      <Sliders size={14} />
                      Apply {recommendation.recommendedKbps} kbps to Recording Settings
                    </button>
                  </div>
                )}

                {/* Tested tiers log */}
                {Object.keys(tierResults).length > 0 && (
                  <div className="ql-card">
                    <span className="field-label">Your Test Results</span>
                    <div className="ql-results-list">
                      {Object.values(tierResults)
                        .sort((a, b) => a.bitrateKbps - b.bitrateKbps)
                        .map((t) => {
                          const cls = classifyBlindTier(t);
                          return (
                            <div key={t.bitrateKbps} className="ql-result-row">
                              <div className="ql-result-row__left">
                                <span className="font-mono ql-result-row__rate">
                                  {t.bitrateKbps}k {t.extension.toUpperCase()}
                                </span>
                                <span className="ql-result-row__meta font-mono">
                                  {formatBytes(t.encodedBytes)} ({t.savingsPercent}% saved) ·{' '}
                                  {t.pickedMaster}/{t.trials} master
                                </span>
                              </div>
                              <span
                                className={`badge ${
                                  cls === 'transparent' ? 'badge-sage' : 'badge-amber'
                                }`}
                              >
                                {cls === 'transparent' ? 'No diff' : 'Audible'}
                              </span>
                            </div>
                          );
                        })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ================================================================
                TAB 2: OPEN SIDE-BY-SIDE A/B LISTEN
                ================================================================ */}
            {activeTab === 'ab' && (
              <div className="ql-stack" data-testid="ql-panel-ab">
                <div className="ql-card">
                  <div className="field">
                    <span className="field-label">Compare Format</span>
                    <div className="pill-grid">
                      {(
                        [
                          {
                            id: 'auto',
                            label: caps
                              ? `Auto (${caps.autoBestFormat.toUpperCase()})`
                              : 'Auto',
                          },
                          { id: 'm4a', label: 'M4A (AAC)' },
                          { id: 'webm', label: 'WebM (Opus)' },
                          { id: 'wav', label: 'WAV' },
                        ] as Array<{ id: AudioFormatOption; label: string }>
                      ).map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          className={`opt-pill ${abFormat === opt.id ? 'opt-pill--active' : ''}`}
                          onClick={() => setAbFormat(opt.id)}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="field">
                    <span className="field-label">Sample Rate</span>
                    <div className="pill-grid">
                      {SAMPLE_RATE_OPTIONS.map((sr) => (
                        <button
                          key={sr.value}
                          type="button"
                          className={`opt-pill font-mono ${abSampleRate === sr.value ? 'opt-pill--active' : ''}`}
                          onClick={() => setAbSampleRate(sr.value)}
                        >
                          {sr.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {abEffectiveFmt !== 'wav' ? (
                    <>
                      <div className="field">
                        <span className="field-label">Bitrate</span>
                        <div className="pill-grid">
                          {BITRATE_OPTIONS.map((kbps) => (
                            <button
                              key={kbps}
                              type="button"
                              className={`opt-pill font-mono ${abBitrate === kbps ? 'opt-pill--active' : ''}`}
                              onClick={() => setAbBitrate(kbps)}
                            >
                              {kbps}k
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="field">
                        <span className="field-label">Bitrate Mode</span>
                        <div className="pill-grid">
                          {(
                            [
                              { id: 'variable', label: 'VBR' },
                              { id: 'constant', label: 'CBR' },
                            ] as Array<{ id: BitrateModeOption; label: string }>
                          ).map((m) => (
                            <button
                              key={m.id}
                              type="button"
                              className={`opt-pill ${abBitrateMode === m.id ? 'opt-pill--active' : ''}`}
                              onClick={() => setAbBitrateMode(m.id)}
                            >
                              {m.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="field">
                      <span className="field-label">WAV Bit Depth</span>
                      <div className="pill-grid">
                        {WAV_BIT_DEPTH_OPTIONS.map((bd) => (
                          <button
                            key={bd.value}
                            type="button"
                            className={`opt-pill ${abWavBitDepth === bd.value ? 'opt-pill--active' : ''}`}
                            onClick={() => setAbWavBitDepth(bd.value)}
                          >
                            {bd.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Live Synchronized Master <-> Export Switcher */}
                <div className="ql-card">
                  <div className="ql-card__head">
                    <h2 className="ql-card__title">Instant Master ↔ Export</h2>
                    {abCandidate && (
                      <span
                        className="badge badge-sage font-mono"
                        data-testid="ab-savings-badge"
                      >
                        {abCandidate.savingsPercent}% smaller ({abCandidate.compressionRatio}×)
                      </span>
                    )}
                  </div>

                  {abEncoding ? (
                    <div className="ql-inline-loading">
                      <Loader2 size={16} className="spin" />
                      <span>Encoding preview…</span>
                    </div>
                  ) : (
                    <>
                      {abCandidate && (
                        <div className="ql-size-compare font-mono">
                          <div>
                            <span className="ql-size-compare__label">Master</span>
                            <strong>{formatBytes(compareReferenceBytes)}</strong>
                          </div>
                          <div>
                            <span className="ql-size-compare__label">
                              {abCandidate.encoded.bitrateKbps
                                ? `${abCandidate.encoded.bitrateKbps}k ${abCandidate.encoded.extension.toUpperCase()}`
                                : `${abCandidate.encoded.bitDepth ?? 16}-bit WAV`}
                            </span>
                            <strong>{formatBytes(abCandidate.fileSizeBytes)}</strong>
                          </div>
                        </div>
                      )}

                      <div className="ql-ab-grid">
                        <button
                          type="button"
                          className={`ql-sample-btn ${
                            isPlaying && activeSlot === 'master'
                              ? 'ql-sample-btn--playing'
                              : ''
                          }`}
                          onClick={() => void handlePlaySlot('master')}
                          data-testid="ab-play-master"
                        >
                          <Play size={16} />
                          <span>Master</span>
                        </button>
                        <button
                          type="button"
                          className={`ql-sample-btn ${
                            isPlaying && activeSlot === 'candidate'
                              ? 'ql-sample-btn--playing'
                              : ''
                          }`}
                          onClick={() => void handlePlaySlot('candidate')}
                          data-testid="ab-play-export"
                        >
                          <Play size={16} />
                          <span>
                            {abEffectiveFmt === 'wav'
                              ? `${abWavBitDepth}-bit WAV`
                              : `${abBitrate}k ${abEffectiveFmt.toUpperCase()}`}
                          </span>
                        </button>
                      </div>

                      <div className="ql-transport-bar">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={handleTogglePause}
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
                    </>
                  )}
                </div>
              </div>
            )}

            {/* ================================================================
                TAB 3: EXPORT FILES (Single Custom + Batch Comparison Set)
                ================================================================ */}
            {activeTab === 'export' && (
              <div className="ql-stack" data-testid="ql-panel-export">
                {/* Single Export Card */}
                <div className="ql-card">
                  <div className="ql-card__head">
                    <h2 className="ql-card__title">Custom Single Export</h2>
                    {usingLocalMaster && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={handleDownloadLosslessMaster}
                        data-testid="download-master-wav-btn"
                      >
                        <Download size={13} />
                        Raw Master WAV
                      </button>
                    )}
                  </div>

                  <div className="field">
                    <span className="field-label">Format</span>
                    <div className="pill-grid">
                      {(
                        [
                          {
                            id: 'auto',
                            label: caps
                              ? `Auto (${caps.autoBestFormat.toUpperCase()})`
                              : 'Auto',
                          },
                          { id: 'm4a', label: 'M4A (AAC)' },
                          { id: 'webm', label: 'WebM (Opus)' },
                          { id: 'wav', label: 'WAV (Lossless)' },
                        ] as Array<{ id: AudioFormatOption; label: string }>
                      ).map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          className={`opt-pill ${exportFormat === opt.id ? 'opt-pill--active' : ''}`}
                          onClick={() => setExportFormat(opt.id)}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="field">
                    <span className="field-label">Sample Rate</span>
                    <div className="pill-grid">
                      {SAMPLE_RATE_OPTIONS.map((sr) => (
                        <button
                          key={sr.value}
                          type="button"
                          className={`opt-pill font-mono ${exportSampleRate === sr.value ? 'opt-pill--active' : ''}`}
                          onClick={() => setExportSampleRate(sr.value)}
                        >
                          {sr.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {exportEffectiveFmt !== 'wav' ? (
                    <>
                      <div className="field">
                        <span className="field-label">Bitrate</span>
                        <div className="pill-grid">
                          {BITRATE_OPTIONS.map((kbps) => (
                            <button
                              key={kbps}
                              type="button"
                              className={`opt-pill font-mono ${exportBitrate === kbps ? 'opt-pill--active' : ''}`}
                              onClick={() => setExportBitrate(kbps)}
                            >
                              {kbps}k
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="field">
                        <span className="field-label">Bitrate Mode</span>
                        <div className="pill-grid">
                          {(
                            [
                              { id: 'variable', label: 'VBR' },
                              { id: 'constant', label: 'CBR' },
                            ] as Array<{ id: BitrateModeOption; label: string }>
                          ).map((m) => (
                            <button
                              key={m.id}
                              type="button"
                              className={`opt-pill ${exportBitrateMode === m.id ? 'opt-pill--active' : ''}`}
                              onClick={() => setExportBitrateMode(m.id)}
                            >
                              {m.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="field">
                      <span className="field-label">WAV Bit Depth</span>
                      <div className="pill-grid">
                        {WAV_BIT_DEPTH_OPTIONS.map((bd) => (
                          <button
                            key={bd.value}
                            type="button"
                            className={`opt-pill ${exportWavBitDepth === bd.value ? 'opt-pill--active' : ''}`}
                            onClick={() => setExportWavBitDepth(bd.value)}
                          >
                            {bd.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="ql-export-actions">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => void handleSingleExport('download')}
                      disabled={singleExporting}
                      data-testid="single-export-download-btn"
                    >
                      {singleExporting ? (
                        <Loader2 size={14} className="spin" />
                      ) : (
                        <Download size={14} />
                      )}
                      {singleExporting ? 'Encoding…' : 'Export & Download'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => void handleSingleExport('share')}
                      disabled={singleExporting}
                    >
                      <Share2 size={14} />
                      Share
                    </button>
                  </div>

                  {singleResult && (
                    <div className="ql-export-done font-mono" data-testid="single-export-result">
                      <Check size={14} color="var(--accent-sage)" />
                      <span>
                        {singleResult.fileName} · {formatBytes(singleResult.fileSizeBytes)} (
                        {singleResult.savingsPercent >= 0
                          ? `${singleResult.savingsPercent}% smaller`
                          : 'lossless'}
                        )
                      </span>
                    </div>
                  )}
                </div>

                {/* Batch Comparison Set Card */}
                <div className="ql-card">
                  <div className="ql-card__head">
                    <h2 className="ql-card__title">Batch Comparison Set</h2>
                    <span className="font-mono ql-muted-mono">
                      {batchTiers.length} selected
                    </span>
                  </div>
                  <p className="ql-helper-text">
                    Encode the full chapter across multiple bitrates from the same
                    source so you can compare exact file sizes and listen in any
                    external player.
                  </p>

                  <div className="field">
                    <span className="field-label">Codec</span>
                    <div className="pill-grid">
                      {(
                        [
                          {
                            id: 'auto',
                            label: caps
                              ? `Auto (${caps.autoBestFormat.toUpperCase()})`
                              : 'Auto',
                          },
                          { id: 'm4a', label: 'M4A (AAC)' },
                          { id: 'webm', label: 'WebM (Opus)' },
                        ] as Array<{ id: AudioFormatOption; label: string }>
                      ).map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          className={`opt-pill ${batchFormat === opt.id ? 'opt-pill--active' : ''}`}
                          onClick={() => setBatchFormat(opt.id)}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="field">
                    <span className="field-label">Bitrates to Encode</span>
                    <div className="pill-grid">
                      {THRESHOLD_LADDER_KBPS.map((kbps) => {
                        const active = batchTiers.includes(kbps);
                        return (
                          <button
                            key={kbps}
                            type="button"
                            className={`opt-pill font-mono ${active ? 'opt-pill--active' : ''}`}
                            onClick={() => toggleBatchTier(kbps)}
                          >
                            {active ? '✓ ' : ''}
                            {kbps}k
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="ql-export-actions">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => void handleRunBatchExport()}
                      disabled={batchRunning || batchTiers.length === 0}
                      data-testid="batch-encode-btn"
                    >
                      {batchRunning ? (
                        <Loader2 size={14} className="spin" />
                      ) : (
                        <FlaskConical size={14} />
                      )}
                      {batchProgressText ||
                        `Encode Comparison Set (${batchTiers.length})`}
                    </button>

                    {batchResults.length > 1 && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          batchResults.forEach((r) =>
                            triggerBlobDownload(r.encoded.blob, r.fileName),
                          );
                          onToast(`Downloaded ${batchResults.length} files`);
                        }}
                      >
                        <Download size={14} />
                        Download All
                      </button>
                    )}
                  </div>

                  {batchResults.length > 0 && (
                    <div
                      className="ql-results-list"
                      data-testid="batch-export-results"
                    >
                      {batchResults.map((res) => (
                        <div key={res.fileName} className="ql-result-row">
                          <div className="ql-result-row__left">
                            <span className="font-mono ql-result-row__rate">
                              {res.encoded.bitrateKbps
                                ? `${res.encoded.bitrateKbps} kbps ${res.encoded.extension.toUpperCase()}`
                                : `${res.encoded.bitDepth ?? 16}-bit WAV`}
                            </span>
                            <span className="ql-result-row__meta font-mono">
                              {formatBytes(res.fileSizeBytes)} ·{' '}
                              {res.savingsPercent}% smaller · ~
                              {formatBytes(res.bytesPerMinute)}/min
                            </span>
                          </div>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => {
                              triggerBlobDownload(res.encoded.blob, res.fileName);
                              onToast(`Downloaded ${res.fileName}`);
                            }}
                            aria-label={`Download ${res.fileName}`}
                          >
                            <Download size={13} />
                            Save
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
};
