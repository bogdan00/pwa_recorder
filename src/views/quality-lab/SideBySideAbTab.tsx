import React from 'react';
import { Loader2 } from 'lucide-react';
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
import {
  QualityLabSampleButton,
  QualityLabTransportBar,
} from './QualityLabTransportBar';

export interface SideBySideAbTabProps {
  spec: ExportQualitySpec;
  caps: CodecCapabilities | null;
  encoding: boolean;
  candidate: TranscodedExportResult | null;
  compareReferenceBytes: number;
  isPlaying: boolean;
  activeSlot: CompareTrackSlot | null;
  playheadSec: number;
  playDurationSec: number;
  onChangeSpec: (patch: Partial<ExportQualitySpec>) => void;
  onToggleSlot: (slot: CompareTrackSlot) => void;
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
  onToggleSlot,
}) => {
  const effectiveFmt = resolveEffectiveFormat(spec.format, caps);
  const exportLabel =
    effectiveFmt === 'wav'
      ? `${spec.wavBitDepth}-bit WAV`
      : `${spec.bitrateKbps}k ${effectiveFmt.toUpperCase()}`;

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
          <h2 className="ql-card__title">Compare Master ↔ Export</h2>
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
              <QualityLabSampleButton
                label="Master"
                isPlaying={isPlaying && activeSlot === 'master'}
                isPaused={
                  !isPlaying && activeSlot === 'master' && playheadSec > 0.05
                }
                onClick={() => onToggleSlot('master')}
                testId="ab-play-master"
              />
              <QualityLabSampleButton
                label={exportLabel}
                isPlaying={isPlaying && activeSlot === 'candidate'}
                isPaused={
                  !isPlaying && activeSlot === 'candidate' && playheadSec > 0.05
                }
                onClick={() => onToggleSlot('candidate')}
                testId="ab-play-export"
              />
            </div>

            <QualityLabTransportBar
              playheadSec={playheadSec}
              playDurationSec={playDurationSec}
            />
          </>
        )}
      </div>
    </div>
  );
};
