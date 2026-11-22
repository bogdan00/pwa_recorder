import React, { useState } from 'react';
import { Bug, Copy, Download, Loader2, Trash2 } from 'lucide-react';
import type { AppSettings } from '../../types/models';
import {
  buildSyncDiagnosticsReport,
  clearSyncDebugLog,
  copyDiagnosticsReportToClipboard,
  shareOrDownloadDiagnosticsReport,
} from '../../drive/diagnostics';

export interface DiagnosticsSettingsSectionProps {
  settings: AppSettings;
  onToast: (message: string) => void;
}

export const DiagnosticsSettingsSection: React.FC<
  DiagnosticsSettingsSectionProps
> = ({ settings, onToast }) => {
  const [exportingDebug, setExportingDebug] = useState(false);
  const [debugSummary, setDebugSummary] = useState<string | null>(null);

  const runDebugExport = async (mode: 'copy' | 'file') => {
    if (exportingDebug) return;
    setExportingDebug(true);
    try {
      const report = await buildSyncDiagnosticsReport(settings);
      const visibleCount = report.liveDriveProbe.visibleDriveItems?.length;
      const probeStatus = report.liveDriveProbe.ran
        ? `Drive probe: ${visibleCount ?? 0} visible item(s)`
        : 'Drive probe skipped (not connected)';
      setDebugSummary(
        `${report.localDb.projectCount} book(s) · ${report.recentEvents.length} trace event(s) · ${probeStatus}`,
      );
      if (mode === 'copy') {
        const ok = await copyDiagnosticsReportToClipboard(report);
        onToast(
          ok
            ? 'Copied sync debug report to clipboard'
            : 'Could not copy — try Share / Save JSON instead',
        );
      } else {
        const res = await shareOrDownloadDiagnosticsReport(report);
        if (res === 'shared') {
          onToast('Shared sync debug report');
        } else if (res === 'downloaded') {
          onToast('Downloaded sync debug JSON');
        }
      }
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Could not build debug report';
      setDebugSummary(msg);
      onToast(msg);
    } finally {
      setExportingDebug(false);
    }
  };

  return (
    <section
      className="settings-section"
      aria-label="Sync and Sharing Diagnostics"
      data-testid="settings-diagnostics-box"
    >
      <div className="settings-section__head">
        <h3 className="settings-section__title">
          <Bug size={17} />
          Sync &amp; Sharing Diagnostics
        </h3>
      </div>
      <span className="field-hint">
        Export a redacted JSON snapshot of your library settings, local books,
        live Google Drive folder visibility, and recent sync trace (tokens and
        API keys are never included).
      </span>
      <div className="drive-actions-row">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          id="export-debug-copy-btn"
          disabled={exportingDebug}
          onClick={() => void runDebugExport('copy')}
        >
          {exportingDebug ? (
            <Loader2 size={14} className="spin" />
          ) : (
            <Copy size={14} />
          )}
          {exportingDebug ? 'Collecting…' : 'Copy Debug JSON'}
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          id="export-debug-download-btn"
          disabled={exportingDebug}
          onClick={() => void runDebugExport('file')}
        >
          <Download size={14} />
          Share / Save JSON
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          id="clear-debug-log-btn"
          disabled={exportingDebug}
          onClick={() => {
            clearSyncDebugLog();
            setDebugSummary('Debug trace log cleared');
            onToast('Cleared sync debug trace');
          }}
        >
          <Trash2 size={14} />
          Clear Trace
        </button>
      </div>
      {debugSummary && <span className="field-hint">{debugSummary}</span>}
    </section>
  );
};
