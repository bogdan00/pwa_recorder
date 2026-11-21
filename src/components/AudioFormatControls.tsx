import React from 'react';
import type {
  AudioFormatOption,
  BitrateKbpsOption,
  BitrateModeOption,
  SampleRateOption,
  WavBitDepthOption,
} from '../types/models';
import type { ExportQualitySpec } from '../audio/audioExporter';
import {
  BITRATE_OPTIONS,
  type CodecCapabilities,
  resolveEffectiveFormat,
  SAMPLE_RATE_OPTIONS,
  WAV_BIT_DEPTH_OPTIONS,
} from '../audio/qualityPresets';

export interface CodecPillPickerProps {
  value: AudioFormatOption;
  caps: CodecCapabilities | null;
  includeWav?: boolean;
  wavLabel?: string;
  autoFallbackLabel?: string;
  showCodecFallbackLabels?: boolean;
  onChange: (format: AudioFormatOption) => void;
}

export const CodecPillPicker: React.FC<CodecPillPickerProps> = ({
  value,
  caps,
  includeWav = false,
  wavLabel = 'WAV',
  autoFallbackLabel = 'Auto',
  showCodecFallbackLabels = false,
  onChange,
}) => {
  const options: Array<{ id: AudioFormatOption; label: string }> = [
    {
      id: 'auto',
      label: caps
        ? `Auto (${caps.autoBestFormat.toUpperCase()})`
        : autoFallbackLabel,
    },
    {
      id: 'm4a',
      label:
        showCodecFallbackLabels && caps && !caps.aacSupported
          ? 'M4A AAC (Fallback)'
          : 'M4A (AAC)',
    },
    {
      id: 'webm',
      label:
        showCodecFallbackLabels && caps && !caps.opusSupported
          ? 'WebM Opus (Fallback)'
          : 'WebM (Opus)',
    },
  ];
  if (includeWav) {
    options.push({ id: 'wav', label: wavLabel });
  }

  return (
    <div className="pill-grid">
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          className={`opt-pill ${value === opt.id ? 'opt-pill--active' : ''}`}
          onClick={() => onChange(opt.id)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
};

export interface AudioFormatControlsProps {
  value: ExportQualitySpec;
  caps: CodecCapabilities | null;
  formatLabel?: string;
  wavLabel?: string;
  autoFallbackLabel?: string;
  showCodecFallbackLabels?: boolean;
  showBitrateReadout?: boolean;
  verboseBitrateModeLabels?: boolean;
  sampleRateHint?: React.ReactNode;
  bitrateHint?: React.ReactNode;
  onChange: (patch: Partial<ExportQualitySpec>) => void;
}

export const AudioFormatControls: React.FC<AudioFormatControlsProps> = ({
  value,
  caps,
  formatLabel = 'Format',
  wavLabel = 'WAV',
  autoFallbackLabel = 'Auto',
  showCodecFallbackLabels = false,
  showBitrateReadout = false,
  verboseBitrateModeLabels = false,
  sampleRateHint,
  bitrateHint,
  onChange,
}) => {
  const isWav = resolveEffectiveFormat(value.format, caps) === 'wav';
  const modeOptions: Array<{ id: BitrateModeOption; label: string }> =
    verboseBitrateModeLabels
      ? [
          { id: 'variable', label: 'VBR (Variable — Better Quality)' },
          { id: 'constant', label: 'CBR (Constant)' },
        ]
      : [
          { id: 'variable', label: 'VBR' },
          { id: 'constant', label: 'CBR' },
        ];

  return (
    <>
      <div className="field">
        <span className="field-label">{formatLabel}</span>
        <CodecPillPicker
          value={value.format}
          caps={caps}
          includeWav
          wavLabel={wavLabel}
          autoFallbackLabel={autoFallbackLabel}
          showCodecFallbackLabels={showCodecFallbackLabels}
          onChange={(format) => onChange({ format })}
        />
      </div>

      <div className="field">
        <span className="field-label">Sample Rate</span>
        <div className="pill-grid">
          {SAMPLE_RATE_OPTIONS.map((sr) => (
            <button
              key={sr.value}
              type="button"
              className={`opt-pill font-mono ${value.sampleRate === sr.value ? 'opt-pill--active' : ''}`}
              onClick={() =>
                onChange({ sampleRate: sr.value as SampleRateOption })
              }
              title={sr.note}
            >
              {sr.label}
            </button>
          ))}
        </div>
        {sampleRateHint}
      </div>

      {!isWav ? (
        <>
          <div className="field">
            {showBitrateReadout ? (
              <div className="gain-header">
                <span className="field-label">Bitrate</span>
                <span
                  className="font-mono"
                  style={{ fontSize: 12.5, color: 'var(--accent-amber)' }}
                >
                  {value.bitrateKbps} kbps
                </span>
              </div>
            ) : (
              <span className="field-label">Bitrate</span>
            )}
            <div className="pill-grid">
              {BITRATE_OPTIONS.map((kbps) => (
                <button
                  key={kbps}
                  type="button"
                  className={`opt-pill font-mono ${value.bitrateKbps === kbps ? 'opt-pill--active' : ''}`}
                  onClick={() =>
                    onChange({ bitrateKbps: kbps as BitrateKbpsOption })
                  }
                >
                  {kbps}k
                </button>
              ))}
            </div>
            {bitrateHint}
          </div>

          <div className="field">
            <span className="field-label">Bitrate Mode</span>
            <div className="pill-grid">
              {modeOptions.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`opt-pill ${value.bitrateMode === m.id ? 'opt-pill--active' : ''}`}
                  onClick={() => onChange({ bitrateMode: m.id })}
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
                className={`opt-pill ${value.wavBitDepth === bd.value ? 'opt-pill--active' : ''}`}
                onClick={() =>
                  onChange({ wavBitDepth: bd.value as WavBitDepthOption })
                }
              >
                {bd.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
};
