import React, { useMemo } from 'react';
import { Sliders } from 'lucide-react';
import type {
  AppSettings,
  AudioQualitySettings,
  ChannelCountOption,
} from '../../types/models';
import {
  type CodecCapabilities,
  detectMatchingPreset,
  estimateSizePerMinuteBytes,
  formatQualitySummaryPill,
  QUALITY_PRESETS,
  resolveEffectiveFormat,
} from '../../audio/qualityPresets';
import { AudioFormatControls } from '../../components/AudioFormatControls';
import { ToggleRow } from '../../components/ToggleRow';
import { formatBytes, formatGainDb } from '../../utils/format';

export interface QualitySettingsSectionProps {
  settings: AppSettings;
  caps: CodecCapabilities | null;
  onUpdateSettings: (next: AppSettings) => void;
}

const DSP_TOGGLES: Array<{
  key: keyof Pick<
    AudioQualitySettings,
    | 'highPassFilter'
    | 'softLimiter'
    | 'noiseSuppression'
    | 'autoGainControl'
    | 'echoCancellation'
  >;
  title: string;
  description: string;
}> = [
  {
    key: 'highPassFilter',
    title: '80 Hz Rumble Filter',
    description:
      'Removes low room hum and handling bumps without thinning voice warmth',
  },
  {
    key: 'softLimiter',
    title: 'Anti-Clip Safety Limiter',
    description:
      'Softly catches sudden loud character voices before digital clipping',
  },
  {
    key: 'noiseSuppression',
    title: 'Browser Noise Suppression',
    description:
      'Turn OFF in quiet rooms to capture full uncolored phone mic fidelity',
  },
  {
    key: 'autoGainControl',
    title: 'Browser Auto Gain Control',
    description:
      'Automatically boosts whispers; turn OFF for natural studio dynamics',
  },
  {
    key: 'echoCancellation',
    title: 'Browser Echo Cancellation',
    description:
      'Recommended OFF for audiobooks (phone-call processing reduces richness)',
  },
];

export const QualitySettingsSection: React.FC<QualitySettingsSectionProps> = ({
  settings,
  caps,
  onUpdateSettings,
}) => {
  const quality = settings.audioQuality;
  const effectiveFormat = resolveEffectiveFormat(quality.format, caps);
  const isWav = effectiveFormat === 'wav';

  const bytesPerMin = useMemo(
    () => estimateSizePerMinuteBytes(quality, caps),
    [quality, caps],
  );

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

  const updateQuality = (patch: Partial<AudioQualitySettings>) => {
    const merged: AudioQualitySettings = { ...quality, ...patch };
    merged.preset = detectMatchingPreset(merged);
    onUpdateSettings({ ...settings, audioQuality: merged });
  };

  return (
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
          {!isWav
            ? ` · ${quality.bitrateMode === 'constant' ? 'CBR' : 'VBR'}`
            : ''}
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
            onClick={() =>
              onUpdateSettings({
                ...settings,
                audioQuality: { ...preset.settings },
              })
            }
          >
            <span className="preset-card__name">{preset.name}</span>
            <span className="preset-card__sub">{preset.tagline}</span>
          </button>
        ))}
      </div>

      <ToggleRow
        testId="keep-local-master-row"
        title="Save Local Lossless Master"
        description="Keep an uncompressed 32-bit Float WAV copy on this device for Quality Lab blind A/B tests & multi-bitrate export. Google Drive still syncs your regular chapter file."
        checked={settings.keepLocalMaster}
        onToggle={() =>
          onUpdateSettings({
            ...settings,
            keepLocalMaster: !settings.keepLocalMaster,
          })
        }
      />

      <AudioFormatControls
        value={quality}
        caps={caps}
        formatLabel="Format / Codec"
        wavLabel="WAV (Lossless)"
        autoFallbackLabel="Auto (Native)"
        showCodecFallbackLabels
        showBitrateReadout
        verboseBitrateModeLabels
        sampleRateHint={
          quality.sampleRate === 96000 && !isWav ? (
            <span className="field-hint">
              96 kHz shines best in Lossless WAV with an external USB-C/Lightning
              mic (compressed codecs clamp to 48 kHz).
            </span>
          ) : null
        }
        bitrateHint={
          selectedMaxBitrate > 0 && quality.bitrateKbps > selectedMaxBitrate ? (
            <span className="field-hint">
              This browser&apos;s {effectiveFormat.toUpperCase()} encoder caps{' '}
              {quality.channels === 2 ? 'stereo' : 'mono'} at{' '}
              {selectedMaxBitrate} kbps and will automatically use{' '}
              {selectedMaxBitrate} kbps (or switch to WAV for lossless).
            </span>
          ) : null
        }
        onChange={updateQuality}
      />

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
            <span
              className="font-mono"
              style={{ fontSize: 12.5, color: 'var(--accent-amber)' }}
            >
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
          onChange={(e) => updateQuality({ inputGain: Number(e.target.value) })}
        />
      </div>

      {/* Studio Voice Chain & Raw Mic DSP Toggles */}
      <div>
        {DSP_TOGGLES.map((item) => (
          <ToggleRow
            key={item.key}
            title={item.title}
            description={item.description}
            checked={quality[item.key]}
            onToggle={() => updateQuality({ [item.key]: !quality[item.key] })}
          />
        ))}
      </div>
    </section>
  );
};
