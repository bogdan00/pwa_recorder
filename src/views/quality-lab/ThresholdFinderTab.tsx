import React from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Eye,
  Loader2,
  Play,
  RefreshCw,
  Sliders,
} from 'lucide-react';
import type {
  AudioFormatOption,
  BitrateKbpsOption,
  SampleRateOption,
} from '../../types/models';
import type { CompareTrackSlot } from '../../audio/abComparePlayer';
import {
  type BlindChoice,
  type BlindTierResult,
  classifyBlindTier,
  THRESHOLD_LADDER_KBPS,
  type ThresholdRecommendation,
  type TranscodedExportResult,
} from '../../audio/audioExporter';
import type { CodecCapabilities } from '../../audio/qualityPresets';
import { CodecPillPicker } from '../../components/AudioFormatControls';
import { formatBytes, formatSampleRate } from '../../utils/format';
import { QualityLabTransportBar } from './QualityLabTransportBar';

export interface BlindRevealInfo {
  bitrateKbps: BitrateKbpsOption;
  aWasMaster: boolean;
  choice: BlindChoice;
  pickedLabel: 'A' | 'B' | 'same';
  encodedBytes: number;
  savingsPercent: number;
  extension: string;
}

export interface ThresholdFinderTabProps {
  caps: CodecCapabilities | null;
  usingLocalMaster: boolean;
  blindFormat: AudioFormatOption;
  blindBitrate: BitrateKbpsOption;
  blindSampleRate: SampleRateOption;
  blindEncoding: boolean;
  blindCandidate: TranscodedExportResult | null;
  aIsMaster: boolean;
  lastReveal: BlindRevealInfo | null;
  tierResults: Record<number, BlindTierResult>;
  recommendation: ThresholdRecommendation | null;
  isPlaying: boolean;
  activeSlot: CompareTrackSlot;
  playheadSec: number;
  playDurationSec: number;
  onChangeFormat: (format: AudioFormatOption) => void;
  onChangeBitrate: (kbps: BitrateKbpsOption) => void;
  onPlaySlot: (slot: CompareTrackSlot) => void;
  onTogglePause: () => void;
  onVote: (pickedLabel: 'A' | 'B' | 'same') => void;
  onNextTrial: () => void;
  onAdvanceBitrate: () => void;
  onApplyRecommendation: () => void;
}

export const ThresholdFinderTab: React.FC<ThresholdFinderTabProps> = ({
  caps,
  usingLocalMaster,
  blindFormat,
  blindBitrate,
  blindSampleRate,
  blindEncoding,
  blindCandidate,
  aIsMaster,
  lastReveal,
  tierResults,
  recommendation,
  isPlaying,
  activeSlot,
  playheadSec,
  playDurationSec,
  onChangeFormat,
  onChangeBitrate,
  onPlaySlot,
  onTogglePause,
  onVote,
  onNextTrial,
  onAdvanceBitrate,
  onApplyRecommendation,
}) => (
  <div className="ql-stack" data-testid="ql-panel-threshold">
    {/* Codec selector */}
    <div className="ql-card">
      <div className="ql-card__head">
        <span className="field-label">Test Codec</span>
        <span className="font-mono ql-muted-mono">
          {formatSampleRate(blindSampleRate)}
        </span>
      </div>
      <CodecPillPicker
        value={blindFormat}
        caps={caps}
        onChange={onChangeFormat}
      />

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
                onClick={() => onChangeBitrate(kbps)}
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
        <h2 className="ql-card__title">Blind Test · {blindBitrate} kbps</h2>
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
            (~{formatBytes(blindCandidate.bytesPerMinute)}/min). Switch freely
            mid-sentence — can you hear a difference?
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
              onClick={() => onPlaySlot(aIsMaster ? 'master' : 'candidate')}
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
              onClick={() => onPlaySlot(aIsMaster ? 'candidate' : 'master')}
              data-testid="blind-play-b"
            >
              <Play size={16} />
              <span>Sample B</span>
            </button>
          </div>

          <QualityLabTransportBar
            isPlaying={isPlaying}
            playheadSec={playheadSec}
            playDurationSec={playDurationSec}
            onTogglePause={onTogglePause}
          />

          {!lastReveal ? (
            <div className="ql-verdict-block">
              <span className="field-label">Which sounds cleaner?</span>
              <div className="ql-verdict-grid">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => onVote('A')}
                  data-testid="blind-vote-a"
                >
                  A is better
                </button>
                <button
                  type="button"
                  className="btn btn-amber btn-sm"
                  onClick={() => onVote('same')}
                  data-testid="blind-vote-same"
                >
                  Can&apos;t tell
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => onVote('B')}
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
                  onClick={onNextTrial}
                >
                  <RefreshCw size={13} />
                  Retest {blindBitrate}k
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={onAdvanceBitrate}
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
          onClick={onApplyRecommendation}
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
);
