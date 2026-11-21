import React, { useState } from 'react';
import { Check, Download, FlaskConical, Loader2, Share2 } from 'lucide-react';
import type {
  AudioFormatOption,
  BitrateKbpsOption,
  Recording,
  SampleRateOption,
} from '../../types/models';
import {
  buildExportFileName,
  type DecodedPcmAudio,
  type ExportQualitySpec,
  THRESHOLD_LADDER_KBPS,
  transcodePcm,
  type TranscodedExportResult,
} from '../../audio/audioExporter';
import type { CodecCapabilities } from '../../audio/qualityPresets';
import {
  AudioFormatControls,
  CodecPillPicker,
} from '../../components/AudioFormatControls';
import { shareAudioChapter } from '../../drive/shareUtils';
import { downloadBlob } from '../../utils/blob';
import { formatBytes } from '../../utils/format';

const DEFAULT_BATCH_TIERS: BitrateKbpsOption[] = [32, 64, 96, 128, 192, 320];

export function closestSampleRateOption(rate: number): SampleRateOption {
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

export interface ExportFilesTabProps {
  fullPcm: DecodedPcmAudio;
  sourceBlob: Blob | null;
  usingLocalMaster: boolean;
  fullReferenceBytes: number;
  caps: CodecCapabilities | null;
  effectiveMeta: Pick<Recording, 'orderIndex' | 'name'>;
  shareTitle: string;
  onToast: (message: string) => void;
}

export const ExportFilesTab: React.FC<ExportFilesTabProps> = ({
  fullPcm,
  sourceBlob,
  usingLocalMaster,
  fullReferenceBytes,
  caps,
  effectiveMeta,
  shareTitle,
  onToast,
}) => {
  const [exportSpec, setExportSpec] = useState<ExportQualitySpec>(() => ({
    format: 'auto',
    sampleRate: closestSampleRateOption(fullPcm.sampleRate),
    bitrateKbps: 128,
    bitrateMode: 'variable',
    wavBitDepth: 24,
  }));
  const [singleExporting, setSingleExporting] = useState(false);
  const [singleResult, setSingleResult] =
    useState<TranscodedExportResult | null>(null);

  const [batchFormat, setBatchFormat] = useState<AudioFormatOption>('auto');
  const [batchTiers, setBatchTiers] =
    useState<BitrateKbpsOption[]>(DEFAULT_BATCH_TIERS);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgressText, setBatchProgressText] = useState<string | null>(
    null,
  );
  const [batchResults, setBatchResults] = useState<TranscodedExportResult[]>(
    [],
  );

  const handleDownloadMasterWav = () => {
    if (!sourceBlob) return;
    const fileName = buildExportFileName(
      effectiveMeta,
      {
        extension: 'wav',
        sampleRate: fullPcm.sampleRate,
        bitDepth: fullPcm.bitDepth ?? 32,
      },
      true,
    );
    downloadBlob(sourceBlob, fileName);
    onToast(`Downloaded ${fileName}`);
  };

  const handleSingleExport = async (action: 'download' | 'share') => {
    setSingleExporting(true);
    try {
      const result = await transcodePcm(
        fullPcm,
        exportSpec,
        effectiveMeta,
        fullReferenceBytes,
      );
      setSingleResult(result);

      if (action === 'download') {
        downloadBlob(result.encoded.blob, result.fileName);
        onToast(`Exported ${result.fileName}`);
      } else {
        const outcome = await shareAudioChapter({
          blob: result.encoded.blob,
          fileName: result.fileName,
          title: shareTitle,
          text: `Exported ${effectiveMeta.name} (${result.fileName})`,
        });
        if (outcome === 'shared') onToast(`Shared ${result.fileName}`);
        else if (outcome === 'downloaded') {
          onToast(`Downloaded ${result.fileName}`);
        }
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setSingleExporting(false);
    }
  };

  const handleRunBatchExport = async () => {
    if (batchTiers.length === 0) return;
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

  return (
    <div className="ql-stack" data-testid="ql-panel-export">
      {/* Single Export Card */}
      <div className="ql-card">
        <div className="ql-card__head">
          <h2 className="ql-card__title">Custom Single Export</h2>
          {usingLocalMaster && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={handleDownloadMasterWav}
              data-testid="download-master-wav-btn"
            >
              <Download size={13} />
              Raw Master WAV
            </button>
          )}
        </div>

        <AudioFormatControls
          value={exportSpec}
          caps={caps}
          wavLabel="WAV (Lossless)"
          onChange={(patch) => setExportSpec((prev) => ({ ...prev, ...patch }))}
        />

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
          <div
            className="ql-export-done font-mono"
            data-testid="single-export-result"
          >
            <Check size={14} color="var(--accent-sage)" />
            <span>
              {singleResult.fileName} · {formatBytes(singleResult.fileSizeBytes)}{' '}
              (
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
          Encode the full chapter across multiple bitrates from the same source
          so you can compare exact file sizes and listen in any external player.
        </p>

        <div className="field">
          <span className="field-label">Codec</span>
          <CodecPillPicker
            value={batchFormat}
            caps={caps}
            onChange={setBatchFormat}
          />
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
                  onClick={() =>
                    setBatchTiers((prev) =>
                      prev.includes(kbps)
                        ? prev.filter((k) => k !== kbps)
                        : [...prev, kbps].sort((a, b) => a - b),
                    )
                  }
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
                  downloadBlob(r.encoded.blob, r.fileName),
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
          <div className="ql-results-list" data-testid="batch-export-results">
            {batchResults.map((res) => (
              <div key={res.fileName} className="ql-result-row">
                <div className="ql-result-row__left">
                  <span className="font-mono ql-result-row__rate">
                    {res.encoded.bitrateKbps
                      ? `${res.encoded.bitrateKbps} kbps ${res.encoded.extension.toUpperCase()}`
                      : `${res.encoded.bitDepth ?? 16}-bit WAV`}
                  </span>
                  <span className="ql-result-row__meta font-mono">
                    {formatBytes(res.fileSizeBytes)} · {res.savingsPercent}%
                    smaller · ~{formatBytes(res.bytesPerMinute)}/min
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    downloadBlob(res.encoded.blob, res.fileName);
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
  );
};
