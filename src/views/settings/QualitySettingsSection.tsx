import React, { useMemo } from 'react';
import { Sliders, Volume1, Volume2 } from 'lucide-react';
import type {
  AppSettings,
  AudioQualitySettings,
  ChannelCountOption,
} from '../../types/models';
import {
  gainDbToMultiplier,
  gainMultiplierToDb,
  MAX_INPUT_GAIN_DB,
  MIN_INPUT_GAIN_DB,
} from '../../audio/inputStrip';
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

const GAIN_SCALE_TICKS: Array<{ db: number; dbLabel: string; multLabel: string }> = [
  { db: -6, dbLabel: '-6', multLabel: '0.5×' },
  { db: 0, dbLabel: '0', multLabel: '1×' },
  { db: 6, dbLabel: '+6', multLabel: '2×' },
  { db: 12, dbLabel: '+12', multLabel: '4×' },
  { db: 18, dbLabel: '+18', multLabel: '8×' },
  { db: 24, dbLabel: '+24', multLabel: '16×' },
];

const GAIN_PREVIEW_BAR_WEIGHTS = [0.36, 0.64, 0.9, 1.0, 0.84, 0.56, 0.34];

function describeGainLevel(gainDb: number, multiplier: number, softLimiter: boolean): {
  tone: 'quiet' | 'normal' | 'boost' | 'hot';
  summary: string;
} {
  if (gainDb < -0.25) {
    return {
      tone: 'quiet',
      summary: `Softer (${gainDb.toFixed(1)} dB · ${multiplier.toFixed(2)}×) — tones down loud voices or very close microphones.`,
    };
  }
  if (gainDb <= 0.25) {
    return {
      tone: 'normal',
      summary:
        'Natural level (0 dB · 1×) — leaves your microphone untouched. Slide right to boost a quiet phone.',
    };
  }
  if (gainDb <= 6.5) {
    return {
      tone: 'boost',
      summary: `Gentle boost (+${gainDb.toFixed(1)} dB · ${multiplier.toFixed(1)}×) — subtle lift for slightly soft reading.`,
    };
  }
  if (gainDb <= 14.5) {
    return {
      tone: 'boost',
      summary: `Strong boost (+${gainDb.toFixed(1)} dB · ${multiplier.toFixed(1)}×) — noticeable volume lift for quiet rooms or iPhones in Raw mode.`,
    };
  }
  return {
    tone: 'hot',
    summary: softLimiter
      ? `Heavy boost (+${gainDb.toFixed(1)} dB · ${multiplier.toFixed(1)}×) — rescues very quiet mics (Anti-Clip Limiter protects loud peaks).`
      : `Heavy boost (+${gainDb.toFixed(1)} dB · ${multiplier.toFixed(1)}×) — rescues very quiet mics; turn ON Anti-Clip Limiter to prevent distortion.`,
  };
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
      'Automatically boosts quiet speech (uses built-in studio auto-gain on Safari/iOS); turn OFF for fixed manual gain',
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

      {/* Input Gain slider with animated loudness preview & beginner logarithmic guide */}
      {(() => {
        const gainDb = gainMultiplierToDb(quality.inputGain);
        const gainRatio = Math.max(
          0,
          Math.min(
            1,
            (gainDb - MIN_INPUT_GAIN_DB) /
              (MAX_INPUT_GAIN_DB - MIN_INPUT_GAIN_DB),
          ),
        );
        const gainGuide = describeGainLevel(
          gainDb,
          quality.inputGain,
          quality.softLimiter,
        );
        const pulseSec = (1.85 - gainRatio * 0.9).toFixed(2);

        return (
          <div className="field">
            <div className="gain-header">
              <label htmlFor="input-gain-slider" className="field-label">
                Input Gain Boost
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  className="font-mono"
                  data-testid="input-gain-readout"
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

            <div className="gain-guide-card" data-testid="gain-guide-card">
              {/* Animated visual cue: left = quieter, right = louder */}
              <div
                className={`gain-viz gain-viz--${gainGuide.tone}`}
                aria-hidden="true"
                style={{ '--gain-pulse-dur': `${pulseSec}s` } as React.CSSProperties}
              >
                <span
                  className={`gain-viz__side ${gainDb < -0.25 ? 'gain-viz__side--active' : ''}`}
                >
                  <Volume1 size={14} />
                  <span>Quieter</span>
                </span>

                <div className="gain-viz__bars">
                  {GAIN_PREVIEW_BAR_WEIGHTS.map((weight, idx) => {
                    // Perceptual bar height grows clearly from ~18% at -6 dB to 100% at +24 dB
                    const scale = Math.max(
                      0.14,
                      Math.min(1, (0.18 + gainRatio * 0.82) * weight),
                    );
                    return (
                      <span
                        key={idx}
                        className="gain-viz__bar"
                        style={
                          {
                            '--bar-scale': scale.toFixed(3),
                            '--bar-delay': `${idx * 95}ms`,
                          } as React.CSSProperties
                        }
                      />
                    );
                  })}
                </div>

                <span
                  className={`gain-viz__side gain-viz__side--right ${gainDb > 0.25 ? 'gain-viz__side--active' : ''}`}
                >
                  <span>Louder</span>
                  <Volume2 size={14} />
                </span>
              </div>

              <input
                id="input-gain-slider"
                type="range"
                className="range-slider"
                min={MIN_INPUT_GAIN_DB}
                max={MAX_INPUT_GAIN_DB}
                step={0.5}
                value={gainDb}
                aria-valuetext={formatGainDb(quality.inputGain)}
                onChange={(e) =>
                  updateQuality({
                    inputGain: gainDbToMultiplier(Number(e.target.value)),
                  })
                }
              />

              {/* Clickable logarithmic doubling ticks (-6 dB = 0.5x ... +24 dB = 16x) */}
              <div
                className="gain-scale-ticks"
                role="group"
                aria-label="Quick input gain stops"
              >
                {GAIN_SCALE_TICKS.map((tick) => {
                  const isActive = Math.abs(gainDb - tick.db) < 0.75;
                  return (
                    <button
                      key={tick.db}
                      type="button"
                      className={`gain-tick ${isActive ? 'gain-tick--active' : ''}`}
                      onClick={() =>
                        updateQuality({ inputGain: gainDbToMultiplier(tick.db) })
                      }
                      aria-label={`Set input gain to ${tick.dbLabel} dB (${tick.multLabel})`}
                    >
                      <span className="gain-tick__db">{tick.dbLabel}</span>
                      <span className="gain-tick__mult">{tick.multLabel}</span>
                    </button>
                  );
                })}
              </div>

              <p
                className="gain-guide-status"
                data-testid="gain-guidance-text"
              >
                {gainGuide.summary}
              </p>

              <p
                className="gain-log-explainer"
                data-testid="gain-log-explainer"
              >
                <strong>Slide left</strong> for quieter, <strong>right</strong>{' '}
                for louder. Decibels (dB) use a <strong>logarithmic scale</strong>
                : every <strong>+6 dB doubles</strong> signal strength (+6 dB =
                2×, +12 dB = 4×, +18 dB = 8×, +24 dB = 16×) — small tweaks like
                +4 dB are subtle, while +12 to +18 dB gives a big boost.
              </p>
            </div>
          </div>
        );
      })()}

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
