import React from 'react';
import { Loader2, Play } from 'lucide-react';
import type { CompareTrackSlot } from '../../audio/abComparePlayer';
import type {
  ExportQualitySpec,
  TranscodedExportResult,
} from '../../audio/audioExporter';
import {
  type CodecCapabilities,
  resolveEffectiveFormat,
} from '../../audio/qualityPresets';
import { AudioFormatControls } from '../../components/AudioFormatControls';
import { formatBytes } from '../../utils/format';
import { QualityLabTransportBar } from './QualityLabTransportBar';

export interface SideBySideAbTabProps {
  spec: ExportQualitySpec;
  caps: CodecCapabilities | null;
  encoding: boolean;
  candidate: TranscodedExportResult | null;
  compareReferenceBytes: number;
  isPlaying: boolean;
  activeSlot: CompareTrackSlot;
  playheadSec: number;
  playDurationSec: number;
  onChangeSpec: (patch: Partial<ExportQualitySpec>) => void;
  onPlaySlot: (slot: CompareTrackSlot) => void;
  onTogglePause: () => void;
}

export const SideBySideAbTab: React.FC<SideBySideAbTabProps> = ({
  spec,
  caps,
  encoding,
  candidate,
  compareReferenceBytes,
  isPlaying,
  activeSlot,
  playheadSec,
  playDurationSec,
  onChangeSpec,
  onPlaySlot,
  onTogglePause,
}) => {
  const effectiveFmt = resolveEffectiveFormat(spec.format, caps);

  return (
    <div className="ql-stack" data-testid="ql-panel-ab">
      <div className="ql-card">
        <AudioFormatControls
          value={spec}
          caps={caps}
          formatLabel="Compare Format"
          onChange={onChangeSpec}
        />
      </div>

      <div className="ql-card">
        <div className="ql-card__head">
          <h2 className="ql-card__title">Instant Master ↔ Export</h2>
          {candidate && (
            <span
              className="badge badge-sage font-mono"
              data-testid="ab-savings-badge"
            >
              {candidate.savingsPercent}% smaller ({candidate.compressionRatio}×)
            </span>
          )}
        </div>

        {encoding ? (
          <div className="ql-inline-loading">
            <Loader2 size={16} className="spin" />
            <span>Encoding preview…</span>
          </div>
        ) : (
          <>
            {candidate && (
              <div className="ql-size-compare font-mono">
                <div>
                  <span className="ql-size-compare__label">Master</span>
                  <strong>{formatBytes(compareReferenceBytes)}</strong>
                </div>
                <div>
                  <span className="ql-size-compare__label">
                    {candidate.encoded.bitrateKbps
                      ? `${candidate.encoded.bitrateKbps}k ${candidate.encoded.extension.toUpperCase()}`
                      : `${candidate.encoded.bitDepth ?? 16}-bit WAV`}
                  </span>
                  <strong>{formatBytes(candidate.fileSizeBytes)}</strong>
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
                onClick={() => onPlaySlot('master')}
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
                onClick={() => onPlaySlot('candidate')}
                data-testid="ab-play-export"
              >
                <Play size={16} />
                <span>
                  {effectiveFmt === 'wav'
                    ? `${spec.wavBitDepth}-bit WAV`
                    : `${spec.bitrateKbps}k ${effectiveFmt.toUpperCase()}`}
                </span>
              </button>
            </div>

            <QualityLabTransportBar
              isPlaying={isPlaying}
              playheadSec={playheadSec}
              playDurationSec={playDurationSec}
              onTogglePause={onTogglePause}
            />
          </>
        )}
      </div>
    </div>
  );
};
