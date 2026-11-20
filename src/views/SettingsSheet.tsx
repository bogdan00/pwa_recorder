import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Cloud,
  Download,
  ExternalLink,
  FolderOpen,
  HardDrive,
  Link2,
  Loader2,
  Mic,
  Palette,
  RefreshCw,
  Share2,
  Sliders,
  Smartphone,
  Users,
  Volume2,
  X,
} from 'lucide-react';
import type {
  AppSettings,
  AudioFormatOption,
  AudioQualitySettings,
  BitrateKbpsOption,
  BitrateModeOption,
  ChannelCountOption,
  SampleRateOption,
  WavBitDepthOption,
} from '../types/models';
import {
  type AudioInputDeviceInfo,
  listAudioInputDevices,
  MicLevelTester,
  type MicTestTelemetry,
  requestMicPermissionAndList,
  subscribeDeviceChanges,
} from '../audio/audioDevices';
import {
  BITRATE_OPTIONS,
  type CodecCapabilities,
  detectMatchingPreset,
  estimateSizePerMinuteBytes,
  formatQualitySummaryPill,
  probeAudioCapabilities,
  QUALITY_PRESETS,
  resolveEffectiveFormat,
  SAMPLE_RATE_OPTIONS,
  WAV_BIT_DEPTH_OPTIONS,
} from '../audio/qualityPresets';
import type { GoogleAuthState } from '../drive/googleAuth';
import { getDriveFolderWebUrl } from '../drive/shareUtils';
import type { PwaInstallState } from '../pwa/installPrompt';
import { ThemePickerGrid } from '../components/ThemeSwitcherSheet';
import { formatBytes, formatGainDb, formatSampleRate } from '../utils/format';
import './SettingsSheet.css';

interface SettingsSheetProps {
  open: boolean;
  settings: AppSettings;
  authState: GoogleAuthState;
  pwaInstallState?: PwaInstallState;
  isSyncing: boolean;
  syncStatusMessage: string | null;
  onClose: () => void;
  onUpdateSettings: (next: AppSettings) => void;
  onInstallApp?: () => void;
  onConnectDrive: () => void;
  onSignOutDrive: () => void;
  onSyncAll: () => void;
  onOpenShareLibrary: () => void;
  onJoinSharedFolder: (input: string) => Promise<void>;
  onPickSharedFolder: () => Promise<void>;
  onSwitchToPersonalLibrary: () => Promise<void>;
  onUnlinkSharedBook: (folderId: string) => void;
  onClearSyncedCache: () => Promise<number>;
  onToast: (message: string) => void;
}

export const SettingsSheet: React.FC<SettingsSheetProps> = ({
  open,
  settings,
  authState,
  pwaInstallState,
  isSyncing,
  syncStatusMessage,
  onClose,
  onUpdateSettings,
  onInstallApp,
  onConnectDrive,
  onSignOutDrive,
  onSyncAll,
  onOpenShareLibrary,
  onJoinSharedFolder,
  onPickSharedFolder,
  onSwitchToPersonalLibrary,
  onUnlinkSharedBook,
  onClearSyncedCache,
  onToast,
}) => {
  const [devices, setDevices] = useState<AudioInputDeviceInfo[]>([]);
  const [micPermGranted, setMicPermGranted] = useState(false);
  const [deviceLoading, setDeviceLoading] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);

  const [testingMic, setTestingMic] = useState(false);
  const [telemetry, setTelemetry] = useState<MicTestTelemetry | null>(null);
  const testerRef = useRef<MicLevelTester | null>(null);

  const [caps, setCaps] = useState<CodecCapabilities | null>(null);
  const [joinInput, setJoinInput] = useState('');
  const [joiningFolder, setJoiningFolder] = useState(false);
  const [storageUsage, setStorageUsage] = useState<{
    usage: number;
    quota: number;
  } | null>(null);

  const refreshDevices = useCallback(async () => {
    setDeviceLoading(true);
    setDeviceError(null);
    try {
      const res = await listAudioInputDevices();
      setDevices(res.devices);
      setMicPermGranted(res.permissionGranted);
    } catch (err) {
      setDeviceError(
        err instanceof Error ? err.message : 'Unable to detect microphones.',
      );
    } finally {
      setDeviceLoading(false);
    }
  }, []);

  const stopMicTest = useCallback(() => {
    testerRef.current?.stop();
    testerRef.current = null;
    setTestingMic(false);
    setTelemetry(null);
  }, []);

  useEffect(() => {
    if (!open) {
      stopMicTest();
      return;
    }

    void refreshDevices();
    void probeAudioCapabilities().then(setCaps);

    if (
      typeof navigator !== 'undefined' &&
      navigator.storage &&
      typeof navigator.storage.estimate === 'function'
    ) {
      void navigator.storage
        .estimate()
        .then((est) => {
          setStorageUsage({
            usage: est.usage ?? 0,
            quota: est.quota ?? 0,
          });
        })
        .catch(() => {});
    }

    const unsub = subscribeDeviceChanges(() => {
      void refreshDevices();
    });
    return () => {
      unsub();
      stopMicTest();
    };
  }, [open, refreshDevices, stopMicTest]);

  const quality = settings.audioQuality;
  const effectiveFormat = resolveEffectiveFormat(quality.format, caps);
  const bytesPerMin = useMemo(
    () => estimateSizePerMinuteBytes(quality, caps),
    [quality, caps],
  );

  if (!open) return null;

  const updateQuality = (patch: Partial<AudioQualitySettings>) => {
    const merged: AudioQualitySettings = {
      ...quality,
      ...patch,
    };
    merged.preset = detectMatchingPreset(merged);
    onUpdateSettings({
      ...settings,
      audioQuality: merged,
    });
  };

  const applyPreset = (presetSettings: AudioQualitySettings) => {
    onUpdateSettings({
      ...settings,
      audioQuality: { ...presetSettings },
    });
  };

  const handleUnlockDevices = async () => {
    setDeviceLoading(true);
    setDeviceError(null);
    try {
      const res = await requestMicPermissionAndList();
      setDevices(res.devices);
      setMicPermGranted(res.permissionGranted);
      onToast(`Detected ${res.devices.length} microphone${res.devices.length === 1 ? '' : 's'}`);
    } catch (err) {
      setDeviceError(
        err instanceof Error ? err.message : 'Microphone permission denied.',
      );
    } finally {
      setDeviceLoading(false);
    }
  };

  const handleToggleMicTest = async () => {
    if (testingMic) {
      stopMicTest();
      return;
    }
    setDeviceError(null);
    const tester = new MicLevelTester();
    testerRef.current = tester;
    setTestingMic(true);
    try {
      const res = await tester.start(
        settings.audioDevice,
        settings.audioQuality,
        (t) => setTelemetry(t),
      );
      if (res.usedFallback && res.fallbackReason) {
        onToast(res.fallbackReason);
      }
      // Refresh device list now that mic permission is definitely granted
      void refreshDevices();
    } catch (err) {
      stopMicTest();
      setDeviceError(
        err instanceof Error ? err.message : 'Unable to start mic test.',
      );
    }
  };

  const isWav = effectiveFormat === 'wav';
  const selectedMaxBitrate =
    caps && effectiveFormat === 'm4a'
      ? quality.channels === 2
        ? caps.aacMaxStereoKbps
        : caps.aacMaxMonoKbps
      : caps && effectiveFormat === 'webm'
        ? quality.channels === 2
          ? caps.opusMaxStereoKbps
          : caps.opusMaxMonoKbps
        : 0;

  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      data-testid="settings-sheet"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet-panel">
        <div className="sheet-header">
          <h2 id="settings-title" className="sheet-title">
            Studio Settings
          </h2>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close settings"
          >
            <X size={20} />
          </button>
        </div>

        <div className="sheet-body">
          {/* ==============================================================
              1. Recording Device (Microphone Selector + Live Level Tester)
              ============================================================== */}
          <section className="settings-section" aria-label="Recording Device">
            <div className="settings-section__head">
              <h3 className="settings-section__title">
                <Mic size={17} />
                Recording Device
              </h3>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => void refreshDevices()}
                disabled={deviceLoading}
                aria-label="Refresh microphones"
              >
                <RefreshCw size={14} className={deviceLoading ? 'spin' : ''} />
                Refresh
              </button>
            </div>

            {!micPermGranted && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span className="field-hint">
                  Browsers hide microphone names until permission is granted.
                  Tap below to list built-in, Bluetooth, or USB microphones.
                </span>
                <div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void handleUnlockDevices()}
                    disabled={deviceLoading}
                    id="detect-microphones-btn"
                  >
                    <Mic size={14} />
                    Detect Microphones
                  </button>
                </div>
              </div>
            )}

            <div className="device-list" role="radiogroup" aria-label="Microphone input">
              <button
                type="button"
                role="radio"
                aria-checked={settings.audioDevice.deviceId === 'default'}
                className={`device-radio ${settings.audioDevice.deviceId === 'default' ? 'device-radio--active' : ''}`}
                onClick={() =>
                  onUpdateSettings({
                    ...settings,
                    audioDevice: {
                      deviceId: 'default',
                      deviceLabel: 'System Default Microphone',
                    },
                  })
                }
              >
                <span className="device-radio__label">
                  System Default Microphone
                </span>
                {settings.audioDevice.deviceId === 'default' && (
                  <Check size={16} color="var(--accent-amber)" />
                )}
              </button>

              {devices
                .filter((d) => d.deviceId !== 'default')
                .map((dev) => {
                  const selected = settings.audioDevice.deviceId === dev.deviceId;
                  return (
                    <button
                      key={dev.deviceId}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`device-radio ${selected ? 'device-radio--active' : ''}`}
                      onClick={() =>
                        onUpdateSettings({
                          ...settings,
                          audioDevice: {
                            deviceId: dev.deviceId,
                            deviceLabel: dev.label,
                          },
                        })
                      }
                    >
                      <span className="device-radio__label">{dev.label}</span>
                      {selected && (
                        <Check size={16} color="var(--accent-amber)" />
                      )}
                    </button>
                  );
                })}
            </div>

            {micPermGranted &&
              devices.filter((d) => d.deviceId !== 'default').length <= 1 && (
                <span className="field-hint">
                  Connect a USB-C/Lightning mic or Bluetooth headset to switch
                  between multiple inputs.
                </span>
              )}

            {/* Built-in live microphone test meter */}
            <div className="mic-tester-box">
              <div className="mic-tester-row">
                <span className="field-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Volume2 size={14} />
                  Live Input Level Check
                </span>
                <button
                  type="button"
                  className={`btn btn-sm ${testingMic ? 'btn-danger' : 'btn-secondary'}`}
                  onClick={() => void handleToggleMicTest()}
                >
                  {testingMic ? 'Stop Test' : 'Test Mic'}
                </button>
              </div>

              <div className="mic-meter-track" aria-hidden="true">
                <div
                  className={`mic-meter-fill ${
                    telemetry?.clipping
                      ? 'mic-meter-fill--clip'
                      : (telemetry?.level ?? 0) > 0.72
                        ? 'mic-meter-fill--hot'
                        : ''
                  }`}
                  style={{
                    width: `${Math.min(100, Math.round((telemetry?.level ?? 0) * 100))}%`,
                  }}
                />
              </div>

              <div className="mic-telemetry">
                <span>
                  {telemetry
                    ? `${telemetry.db.toFixed(0)} dB${telemetry.clipping ? ' · CLIP' : ''}`
                    : 'Tap Test Mic to verify level & gain'}
                </span>
                {telemetry && (
                  <span>
                    {formatSampleRate(telemetry.actualSampleRate)} ·{' '}
                    {telemetry.actualChannels} ch
                  </span>
                )}
              </div>
            </div>

            {deviceError && (
              <span className="badge badge-danger">{deviceError}</span>
            )}
          </section>

          {/* ==============================================================
              2. Detailed Recording Quality Settings
              ============================================================== */}
          <section className="settings-section" aria-label="Recording Quality">
            <div className="settings-section__head">
              <h3 className="settings-section__title">
                <Sliders size={17} />
                Recording Quality
              </h3>
              <span
                className={`badge ${quality.preset === 'custom' ? 'badge-amber' : ''}`}
                data-testid="quality-preset-badge"
              >
                {quality.preset === 'custom'
                  ? 'Custom'
                  : QUALITY_PRESETS.find((p) => p.id === quality.preset)?.name ||
                    quality.preset}
              </span>
            </div>

            {/* Live summary + size estimator */}
            <div className="quality-summary-card" data-testid="quality-summary-card">
              <span className="quality-summary-card__main">
                {formatQualitySummaryPill(quality, caps)}
                {!isWav ? ` · ${quality.bitrateMode === 'constant' ? 'CBR' : 'VBR'}` : ''}
              </span>
              <span className="quality-summary-card__size">
                Est. size: <strong>~{formatBytes(bytesPerMin)}/min</strong> (~
                {formatBytes(bytesPerMin * 60)}/hr)
              </span>
            </div>

            {/* Presets */}
            <div className="preset-grid">
              {QUALITY_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`preset-card ${quality.preset === preset.id ? 'preset-card--active' : ''}`}
                  onClick={() => applyPreset(preset.settings)}
                >
                  <span className="preset-card__name">{preset.name}</span>
                  <span className="preset-card__sub">{preset.tagline}</span>
                </button>
              ))}
            </div>

            {/* Output Format / Codec */}
            <div className="field">
              <span className="field-label">Format / Codec</span>
              <div className="pill-grid">
                {(
                  [
                    {
                      id: 'auto',
                      label: caps
                        ? `Auto (${caps.autoBestFormat.toUpperCase()})`
                        : 'Auto (Native)',
                    },
                    {
                      id: 'm4a',
                      label:
                        caps && !caps.aacSupported
                          ? 'M4A AAC (Fallback)'
                          : 'M4A (AAC)',
                    },
                    {
                      id: 'webm',
                      label:
                        caps && !caps.opusSupported
                          ? 'WebM Opus (Fallback)'
                          : 'WebM (Opus)',
                    },
                    { id: 'wav', label: 'WAV (Lossless)' },
                  ] as Array<{ id: AudioFormatOption; label: string }>
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    className={`opt-pill ${quality.format === opt.id ? 'opt-pill--active' : ''}`}
                    onClick={() => updateQuality({ format: opt.id })}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Sample Rate */}
            <div className="field">
              <span className="field-label">Sample Rate</span>
              <div className="pill-grid">
                {SAMPLE_RATE_OPTIONS.map((sr) => (
                  <button
                    key={sr.value}
                    type="button"
                    className={`opt-pill font-mono ${quality.sampleRate === sr.value ? 'opt-pill--active' : ''}`}
                    onClick={() =>
                      updateQuality({ sampleRate: sr.value as SampleRateOption })
                    }
                    title={sr.note}
                  >
                    {sr.label}
                  </button>
                ))}
              </div>
              {quality.sampleRate === 96000 && !isWav && (
                <span className="field-hint">
                  96 kHz shines best in Lossless WAV with an external USB-C/Lightning mic (compressed codecs clamp to 48 kHz).
                </span>
              )}
            </div>

            {/* Bitrate & VBR/CBR (when compressed format) OR Bit Depth (when WAV) */}
            {!isWav ? (
              <>
                <div className="field">
                  <div className="gain-header">
                    <span className="field-label">Bitrate</span>
                    <span className="font-mono" style={{ fontSize: 12.5, color: 'var(--accent-amber)' }}>
                      {quality.bitrateKbps} kbps
                    </span>
                  </div>
                  <div className="pill-grid">
                    {BITRATE_OPTIONS.map((kbps) => (
                      <button
                        key={kbps}
                        type="button"
                        className={`opt-pill font-mono ${quality.bitrateKbps === kbps ? 'opt-pill--active' : ''}`}
                        onClick={() =>
                          updateQuality({ bitrateKbps: kbps as BitrateKbpsOption })
                        }
                      >
                        {kbps}k
                      </button>
                    ))}
                  </div>
                  {selectedMaxBitrate > 0 &&
                    quality.bitrateKbps > selectedMaxBitrate && (
                      <span className="field-hint">
                        This browser&apos;s {effectiveFormat.toUpperCase()} encoder caps{' '}
                        {quality.channels === 2 ? 'stereo' : 'mono'} at{' '}
                        {selectedMaxBitrate} kbps and will automatically use{' '}
                        {selectedMaxBitrate} kbps (or switch to WAV for lossless).
                      </span>
                    )}
                </div>

                <div className="field">
                  <span className="field-label">Bitrate Mode</span>
                  <div className="pill-grid">
                    {(
                      [
                        { id: 'variable', label: 'VBR (Variable — Better Quality)' },
                        { id: 'constant', label: 'CBR (Constant)' },
                      ] as Array<{ id: BitrateModeOption; label: string }>
                    ).map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        className={`opt-pill ${quality.bitrateMode === m.id ? 'opt-pill--active' : ''}`}
                        onClick={() => updateQuality({ bitrateMode: m.id })}
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
                      className={`opt-pill ${quality.wavBitDepth === bd.value ? 'opt-pill--active' : ''}`}
                      onClick={() =>
                        updateQuality({
                          wavBitDepth: bd.value as WavBitDepthOption,
                        })
                      }
                    >
                      {bd.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Channels */}
            <div className="field">
              <span className="field-label">Channels</span>
              <div className="pill-grid">
                {(
                  [
                    { id: 1, label: 'Mono (1 ch · Voice)' },
                    { id: 2, label: 'Stereo (2 ch · External Mic)' },
                  ] as Array<{ id: ChannelCountOption; label: string }>
                ).map((ch) => (
                  <button
                    key={ch.id}
                    type="button"
                    className={`opt-pill ${quality.channels === ch.id ? 'opt-pill--active' : ''}`}
                    onClick={() => updateQuality({ channels: ch.id })}
                  >
                    {ch.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Input Gain slider */}
            <div className="field">
              <div className="gain-header">
                <label htmlFor="input-gain-slider" className="field-label">
                  Input Gain Boost
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="font-mono" style={{ fontSize: 12.5, color: 'var(--accent-amber)' }}>
                    {quality.inputGain.toFixed(2)}× ({formatGainDb(quality.inputGain)})
                  </span>
                  {Math.abs(quality.inputGain - 1) > 0.01 && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ minHeight: 26, padding: '2px 8px', fontSize: 11.5 }}
                      onClick={() => updateQuality({ inputGain: 1.0 })}
                    >
                      Reset
                    </button>
                  )}
                </div>
              </div>
              <input
                id="input-gain-slider"
                type="range"
                className="range-slider"
                min={0.5}
                max={2.5}
                step={0.05}
                value={quality.inputGain}
                onChange={(e) =>
                  updateQuality({ inputGain: Number(e.target.value) })
                }
              />
            </div>

            {/* Studio Voice Chain & Raw Mic DSP Toggles */}
            <div>
              <div className="toggle-row">
                <div className="toggle-text">
                  <span className="toggle-title">80 Hz Rumble Filter</span>
                  <span className="toggle-desc">
                    Removes low room hum and handling bumps without thinning voice warmth
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  className="switch"
                  aria-checked={quality.highPassFilter}
                  aria-label="80 Hz Rumble Filter"
                  onClick={() =>
                    updateQuality({ highPassFilter: !quality.highPassFilter })
                  }
                >
                  <span className="switch-thumb" />
                </button>
              </div>

              <div className="toggle-row">
                <div className="toggle-text">
                  <span className="toggle-title">Anti-Clip Safety Limiter</span>
                  <span className="toggle-desc">
                    Softly catches sudden loud character voices before digital clipping
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  className="switch"
                  aria-checked={quality.softLimiter}
                  aria-label="Anti-Clip Safety Limiter"
                  onClick={() =>
                    updateQuality({ softLimiter: !quality.softLimiter })
                  }
                >
                  <span className="switch-thumb" />
                </button>
              </div>

              <div className="toggle-row">
                <div className="toggle-text">
                  <span className="toggle-title">Browser Noise Suppression</span>
                  <span className="toggle-desc">
                    Turn OFF in quiet rooms to capture full uncolored phone mic fidelity
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  className="switch"
                  aria-checked={quality.noiseSuppression}
                  aria-label="Browser Noise Suppression"
                  onClick={() =>
                    updateQuality({
                      noiseSuppression: !quality.noiseSuppression,
                    })
                  }
                >
                  <span className="switch-thumb" />
                </button>
              </div>

              <div className="toggle-row">
                <div className="toggle-text">
                  <span className="toggle-title">Browser Auto Gain Control</span>
                  <span className="toggle-desc">
                    Automatically boosts whispers; turn OFF for natural studio dynamics
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  className="switch"
                  aria-checked={quality.autoGainControl}
                  aria-label="Browser Auto Gain Control"
                  onClick={() =>
                    updateQuality({
                      autoGainControl: !quality.autoGainControl,
                    })
                  }
                >
                  <span className="switch-thumb" />
                </button>
              </div>

              <div className="toggle-row">
                <div className="toggle-text">
                  <span className="toggle-title">Browser Echo Cancellation</span>
                  <span className="toggle-desc">
                    Recommended OFF for audiobooks (phone-call processing reduces richness)
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  className="switch"
                  aria-checked={quality.echoCancellation}
                  aria-label="Browser Echo Cancellation"
                  onClick={() =>
                    updateQuality({
                      echoCancellation: !quality.echoCancellation,
                    })
                  }
                >
                  <span className="switch-thumb" />
                </button>
              </div>
            </div>
          </section>

          {/* ==============================================================
              3. Google Drive Sync
              ============================================================== */}
          <section className="settings-section" aria-label="Google Drive Sync">
            <div className="settings-section__head">
              <h3 className="settings-section__title">
                <Cloud size={17} />
                Google Drive Folder
              </h3>
              <span
                className={`badge ${
                  authState.status === 'connected'
                    ? 'badge-sage'
                    : authState.status === 'expired'
                      ? 'badge-amber'
                      : ''
                }`}
              >
                {authState.status === 'connected'
                  ? 'Connected'
                  : authState.status === 'expired'
                    ? 'Reconnect Needed'
                    : authState.status === 'disconnected'
                      ? 'Disconnected'
                      : 'Not Configured'}
              </span>
            </div>

            {authState.userEmail && (
              <span className="field-hint">
                Signed in as <strong>{authState.userEmail}</strong>
              </span>
            )}

            {authState.lastError && (
              <span className="badge badge-danger">{authState.lastError}</span>
            )}

            <div className="field">
              <label htmlFor="drive-root-folder-input" className="field-label">
                Drive Root Folder Name
              </label>
              <input
                id="drive-root-folder-input"
                type="text"
                className="input"
                value={settings.driveRootFolderName}
                onChange={(e) =>
                  onUpdateSettings({
                    ...settings,
                    driveRootFolderName: e.target.value,
                    driveRootFolderId: undefined,
                  })
                }
                placeholder="StoryTape Audiobooks"
              />
              <span className="field-hint">
                Each book gets its own subfolder containing <code>project.json</code>,{' '}
                <code>cover.jpg</code>, and all chapter audio files.
              </span>
            </div>

            <div className="drive-actions-row">
              {authState.status === 'connected' ? (
                <>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={onSyncAll}
                    disabled={isSyncing}
                  >
                    {isSyncing ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                    {isSyncing ? 'Syncing…' : 'Sync All Now'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={onOpenShareLibrary}
                    id="settings-share-library-btn"
                  >
                    <Share2 size={14} />
                    Share Library
                  </button>
                  {settings.driveRootFolderId && (
                    <a
                      href={getDriveFolderWebUrl(settings.driveRootFolderId)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn-ghost btn-sm"
                    >
                      <ExternalLink size={14} />
                      Open Folder
                    </a>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={onSignOutDrive}
                    disabled={isSyncing}
                  >
                    Sign Out
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={onConnectDrive}
                >
                  <Cloud size={15} />
                  {authState.status === 'expired'
                    ? 'Reconnect Google Drive'
                    : 'Connect Google Drive'}
                </button>
              )}
            </div>

            {syncStatusMessage && (
              <span className="field-hint">{syncStatusMessage}</span>
            )}

            {/* Family Sharing & Collaboration Controls */}
            <div className="collab-box" data-testid="settings-collab-box">
              <div className="collab-box__head">
                <span className="collab-box__title">
                  <Users size={15} />
                  Family &amp; Collaborator Sharing
                </span>
                <span
                  className={`badge ${settings.driveLibraryMode === 'shared' ? 'badge-sage' : ''}`}
                >
                  {settings.driveLibraryMode === 'shared'
                    ? settings.driveAccessRole === 'reader'
                      ? 'Shared · Listener'
                      : 'Shared · Co-Narrator'
                    : 'Personal Library'}
                </span>
              </div>

              {settings.driveLibraryMode === 'shared' && (
                <div className="collab-active-row">
                  <span className="field-hint">
                    Synced with shared folder{' '}
                    <strong>
                      {settings.driveSharedFolderName || 'Shared Audiobooks'}
                    </strong>
                    .
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    id="switch-personal-library-btn"
                    onClick={() => void onSwitchToPersonalLibrary()}
                    disabled={isSyncing}
                  >
                    Switch to My Personal Library
                  </button>
                </div>
              )}

              <div className="field">
                <label htmlFor="join-folder-input" className="field-label">
                  Join a Shared Library or Book
                </label>
                <div className="collab-join-row">
                  <input
                    id="join-folder-input"
                    type="text"
                    className="input"
                    value={joinInput}
                    onChange={(e) => setJoinInput(e.target.value)}
                    placeholder="Paste StoryTape invite link or Google Drive folder URL"
                  />
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    id="settings-join-folder-btn"
                    disabled={!joinInput.trim() || joiningFolder || isSyncing}
                    onClick={async () => {
                      setJoiningFolder(true);
                      try {
                        await onJoinSharedFolder(joinInput);
                        setJoinInput('');
                      } finally {
                        setJoiningFolder(false);
                      }
                    }}
                  >
                    <Link2 size={14} />
                    {joiningFolder ? 'Joining…' : 'Join'}
                  </button>
                </div>
              </div>

              {authState.status === 'connected' && (
                <div className="drive-actions-row">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    id="settings-google-picker-btn"
                    onClick={() => void onPickSharedFolder()}
                    disabled={isSyncing}
                  >
                    <FolderOpen size={14} />
                    Browse Shared Folders (Google Picker)
                  </button>
                </div>
              )}

              {(settings.sharedBookFolders?.length ?? 0) > 0 && (
                <div className="field">
                  <span className="field-label">Linked Shared Books</span>
                  <div className="shared-books-list">
                    {settings.sharedBookFolders!.map((link) => (
                      <div key={link.folderId} className="shared-book-row">
                        <div className="shared-book-row__info">
                          <span className="shared-book-row__title">
                            {link.title}
                          </span>
                          <span className="field-hint">
                            {link.role === 'reader' ? 'Listener' : 'Co-Narrator'}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => onUnlinkSharedBook(link.folderId)}
                        >
                          Unlink
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* ==============================================================
              4. Appearance, Defaults & Local Storage
              ============================================================== */}
          <section className="settings-section" aria-label="Appearance and Storage">
            <div className="settings-section__head">
              <h3 className="settings-section__title">
                <Palette size={17} />
                Appearance &amp; Defaults
              </h3>
            </div>

            <div className="field">
              <span className="field-label">Theme</span>
              <ThemePickerGrid
                currentTheme={settings.theme}
                onSelectTheme={(theme) =>
                  onUpdateSettings({ ...settings, theme })
                }
              />
            </div>

            <div className="field">
              <label htmlFor="default-narrator-input" className="field-label">
                Default Narrator Name
              </label>
              <input
                id="default-narrator-input"
                type="text"
                className="input"
                value={settings.defaultNarrator}
                onChange={(e) =>
                  onUpdateSettings({
                    ...settings,
                    defaultNarrator: e.target.value,
                  })
                }
                placeholder="e.g. Dad / Mom (auto-filled on new books)"
              />
            </div>

            <div className="toggle-row">
              <div className="toggle-text">
                <span className="toggle-title">Keep Screen Awake While Recording</span>
                <span className="toggle-desc">
                  Prevents your phone from locking mid-chapter (Screen Wake Lock)
                </span>
              </div>
              <button
                type="button"
                role="switch"
                className="switch"
                aria-checked={settings.keepScreenAwake}
                aria-label="Keep Screen Awake While Recording"
                onClick={() =>
                  onUpdateSettings({
                    ...settings,
                    keepScreenAwake: !settings.keepScreenAwake,
                  })
                }
              >
                <span className="switch-thumb" />
              </button>
            </div>

            {pwaInstallState &&
              (pwaInstallState.isInstalled ||
                pwaInstallState.canInstallFromSettings) && (
                <div
                  className="settings-install-card"
                  data-testid="settings-install-card"
                >
                  <div className="settings-install-card__info">
                    <span className="settings-install-card__title">
                      <Smartphone size={15} />
                      StoryTape App
                    </span>
                    <span className="settings-install-card__sub">
                      {pwaInstallState.isInstalled
                        ? 'Running as an installed standalone app.'
                        : pwaInstallState.isIosManualInstall
                          ? 'Add to your iPhone or iPad Home Screen for full-screen offline use.'
                          : 'Install to your Home Screen for full-screen offline recording & playback.'}
                    </span>
                  </div>
                  {pwaInstallState.isInstalled ? (
                    <span className="settings-install-badge">
                      <Check size={13} />
                      Installed
                    </span>
                  ) : (
                    onInstallApp && (
                      <button
                        type="button"
                        className="btn btn-amber btn-sm"
                        id="settings-install-app-btn"
                        onClick={onInstallApp}
                      >
                        <Download size={14} />
                        {pwaInstallState.isIosManualInstall
                          ? 'How to Install'
                          : 'Install App'}
                      </button>
                    )
                  )}
                </div>
              )}

            {storageUsage && (
              <div className="field">
                <div className="gain-header">
                  <span className="field-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <HardDrive size={14} />
                    Local Offline Storage
                  </span>
                  <span className="font-mono" style={{ fontSize: 12, color: 'var(--ink-muted)' }}>
                    {formatBytes(storageUsage.usage)}
                    {storageUsage.quota > 0
                      ? ` / ${formatBytes(storageUsage.quota)}`
                      : ''}
                  </span>
                </div>
                {storageUsage.quota > 0 && (
                  <div className="storage-bar">
                    <div
                      className="storage-bar__fill"
                      style={{
                        width: `${Math.min(100, Math.max(1, (storageUsage.usage / storageUsage.quota) * 100))}%`,
                      }}
                    />
                  </div>
                )}
                <div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={async () => {
                      const count = await onClearSyncedCache();
                      onToast(
                        count > 0
                          ? `Freed local audio cache for ${count} synced chapter${count === 1 ? '' : 's'}`
                          : 'No synced local audio cache to free',
                      );
                    }}
                  >
                    Free Cached Audio for Synced Chapters
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};
