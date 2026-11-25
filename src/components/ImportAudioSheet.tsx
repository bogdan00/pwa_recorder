import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Check,
  FileAudio,
  Loader2,
  Plus,
  Upload,
  X,
} from 'lucide-react';
import {
  IMPORT_AUDIO_ACCEPT,
  inspectImportedAudioFile,
  naturalSortFiles,
  type ImportedAudioAnalysis,
} from '../audio/audioImporter';
import {
  formatBytes,
  formatDurationMs,
  formatSampleRate,
} from '../utils/format';
import './ImportAudioSheet.css';

export interface ImportAudioSubmissionItem {
  name: string;
  analysis: ImportedAudioAnalysis;
}

export interface ImportAudioSubmission {
  items: ImportAudioSubmissionItem[];
  recordedBy?: string;
}

interface QueuedAudioItem {
  key: string;
  fileName: string;
  fileSizeBytes: number;
  status: 'analyzing' | 'ready' | 'error';
  name: string;
  analysis?: ImportedAudioAnalysis;
  error?: string;
}

interface ImportAudioSheetProps {
  open: boolean;
  bookTitle: string;
  existingChapterCount: number;
  defaultNarrator: string;
  onClose: () => void;
  onImport: (submission: ImportAudioSubmission) => Promise<void>;
  inspectFile?: typeof inspectImportedAudioFile;
}

let queueItemSeq = 0;

function formatImportedSpec(analysis: ImportedAudioAnalysis): string {
  const parts: string[] = [analysis.extension.toUpperCase()];
  if (analysis.sampleRate > 0) {
    parts.push(formatSampleRate(analysis.sampleRate));
  }
  if (analysis.extension === 'wav' && analysis.bitDepth) {
    parts.push(
      analysis.bitDepth === 32 ? '32f' : `${analysis.bitDepth}-bit`,
    );
  } else if (analysis.bitrateKbps) {
    parts.push(`${analysis.bitrateKbps}k`);
  }
  if (analysis.channels === 2) {
    parts.push('Stereo');
  }
  return parts.join(' · ');
}

export const ImportAudioSheet: React.FC<ImportAudioSheetProps> = ({
  open,
  bookTitle,
  existingChapterCount,
  defaultNarrator,
  onClose,
  onImport,
  inspectFile = inspectImportedAudioFile,
}) => {
  const [items, setItems] = useState<QueuedAudioItem[]>([]);
  const [narrator, setNarrator] = useState(defaultNarrator);
  const [isDragging, setIsDragging] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sessionRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    sessionRef.current += 1;
    setItems([]);
    setNarrator(defaultNarrator);
    setIsDragging(false);
    setIsSaving(false);
    setSubmitError(null);
  }, [open, defaultNarrator]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSaving) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, isSaving, onClose]);

  if (!open) return null;

  const enqueueFiles = (rawFiles: FileList | File[]) => {
    const fileArray = Array.from(rawFiles);
    if (fileArray.length === 0) return;

    const sorted = naturalSortFiles(fileArray);
    const currentSession = sessionRef.current;
    const startOffset = existingChapterCount + items.length;
    setSubmitError(null);

    const placeholders: QueuedAudioItem[] = sorted.map((file) => {
      queueItemSeq += 1;
      return {
        key: `imp-${queueItemSeq}`,
        fileName: file.name,
        fileSizeBytes: file.size,
        status: 'analyzing',
        name: '',
      };
    });

    setItems((prev) => [...prev, ...placeholders]);

    sorted.forEach((file, idx) => {
      const itemKey = placeholders[idx].key;
      void inspectFile(file, { fallbackIndex: startOffset + idx })
        .then((analysis) => {
          if (sessionRef.current !== currentSession) return;
          setItems((prev) =>
            prev.map((entry) =>
              entry.key === itemKey
                ? {
                    ...entry,
                    status: 'ready',
                    name: analysis.suggestedName,
                    analysis,
                    error: undefined,
                  }
                : entry,
            ),
          );
        })
        .catch((err) => {
          if (sessionRef.current !== currentSession) return;
          const message =
            err instanceof Error
              ? err.message
              : 'Could not read audio file.';
          setItems((prev) =>
            prev.map((entry) =>
              entry.key === itemKey
                ? {
                    ...entry,
                    status: 'error',
                    error: message,
                  }
                : entry,
            ),
          );
        });
    });
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      enqueueFiles(e.target.files);
    }
    e.target.value = '';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!isSaving) setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (isSaving) return;
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      enqueueFiles(e.dataTransfer.files);
    }
  };

  const handleRenameItem = (key: string, nextName: string) => {
    setItems((prev) =>
      prev.map((entry) =>
        entry.key === key ? { ...entry, name: nextName } : entry,
      ),
    );
  };

  const handleMoveItem = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    setItems((prev) => {
      const next = prev.slice();
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return next;
    });
  };

  const handleRemoveItem = (key: string) => {
    setItems((prev) => prev.filter((entry) => entry.key !== key));
  };

  const isAnalyzing = items.some((i) => i.status === 'analyzing');
  const readyItems = items.filter(
    (i): i is QueuedAudioItem & { analysis: ImportedAudioAnalysis } =>
      i.status === 'ready' && Boolean(i.analysis),
  );
  const errorCount = items.filter((i) => i.status === 'error').length;
  const hasBlankReadyTitle = readyItems.some((i) => !i.name.trim());
  const canSubmit =
    !isSaving &&
    !isAnalyzing &&
    readyItems.length > 0 &&
    !hasBlankReadyTitle;

  const totalDurationMs = readyItems.reduce(
    (sum, i) => sum + i.analysis.durationMs,
    0,
  );
  const totalBytes = readyItems.reduce(
    (sum, i) => sum + i.analysis.fileSizeBytes,
    0,
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setIsSaving(true);
    setSubmitError(null);
    try {
      await onImport({
        items: readyItems.map((item) => ({
          name: item.name.trim(),
          analysis: item.analysis,
        })),
        recordedBy: narrator.trim() || undefined,
      });
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : 'Failed to import audio files.',
      );
      setIsSaving(false);
    }
  };

  let readySequence = 0;

  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-audio-title"
      id="import-audio-sheet"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSaving) {
          onClose();
        }
      }}
    >
      <form className="sheet-panel import-audio-panel" onSubmit={handleSubmit}>
        <div className="sheet-header">
          <div className="import-audio-header-text">
            <h2 id="import-audio-title" className="sheet-title">
              Import Audio
            </h2>
            <p className="import-audio-subtitle">Add files to {bookTitle}</p>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            disabled={isSaving}
            aria-label="Close import audio sheet"
          >
            <X size={20} />
          </button>
        </div>

        <div className="sheet-body">
          <input
            ref={fileInputRef}
            id="import-audio-file-input"
            type="file"
            accept={IMPORT_AUDIO_ACCEPT}
            multiple
            className="sr-only"
            onChange={handleFileInputChange}
            disabled={isSaving}
          />

          {items.length === 0 ? (
            <div
              className={`import-dropzone ${isDragging ? 'import-dropzone--active' : ''}`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <span className="import-dropzone__icon" aria-hidden="true">
                <Upload size={22} />
              </span>
              <div className="import-dropzone__copy">
                <p className="import-dropzone__title">
                  Import previously recorded chapters
                </p>
                <p className="import-dropzone__hint">
                  Supports MP3, M4A/M4B, WAV, WebM, OGG, FLAC &amp; AAC. Original
                  audio is preserved without re-encoding.
                </p>
              </div>
              <button
                type="button"
                id="choose-audio-files-btn"
                className="btn btn-primary btn-sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={isSaving}
              >
                <FileAudio size={15} />
                Choose Audio Files
              </button>
            </div>
          ) : (
            <>
              <div
                className={`import-toolbar ${isDragging ? 'import-toolbar--active' : ''}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <div className="import-toolbar__summary">
                  {isAnalyzing ? (
                    <span className="import-toolbar__analyzing">
                      <Loader2 size={14} className="spin" />
                      Inspecting audio…
                    </span>
                  ) : readyItems.length > 0 ? (
                    <span>
                      <strong>
                        {readyItems.length}{' '}
                        {readyItems.length === 1 ? 'chapter' : 'chapters'}
                      </strong>{' '}
                      · <span className="font-mono">{formatDurationMs(totalDurationMs)}</span>{' '}
                      · {formatBytes(totalBytes)}
                    </span>
                  ) : (
                    <span>No valid audio files selected</span>
                  )}
                  {errorCount > 0 && (
                    <span className="import-toolbar__skipped">
                      {errorCount} unsupported {errorCount === 1 ? 'file' : 'files'} skipped
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  id="add-more-audio-files-btn"
                  className="btn btn-secondary btn-sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isSaving}
                >
                  <Plus size={14} />
                  Add Files
                </button>
              </div>

              <div className="import-queue" role="list" aria-label="Selected audio files">
                {items.map((item, idx) => {
                  const chapterNumber =
                    item.status === 'ready'
                      ? existingChapterCount + ++readySequence
                      : null;

                  return (
                    <div
                      key={item.key}
                      role="listitem"
                      className={`import-item ${
                        item.status === 'error' ? 'import-item--error' : ''
                      }`}
                      data-testid={`import-item-${idx}`}
                      data-status={item.status}
                    >
                      {item.status === 'analyzing' ? (
                        <div className="import-item__status-row">
                          <Loader2 size={16} className="spin import-item__spinner" />
                          <div className="import-item__status-copy">
                            <span className="import-item__filename">
                              {item.fileName}
                            </span>
                            <span className="import-item__submeta">
                              Reading audio metadata…
                            </span>
                          </div>
                          <button
                            type="button"
                            className="icon-btn import-item__action-btn"
                            onClick={() => handleRemoveItem(item.key)}
                            disabled={isSaving}
                            aria-label={`Remove ${item.fileName}`}
                          >
                            <X size={15} />
                          </button>
                        </div>
                      ) : item.status === 'error' ? (
                        <div className="import-item__status-row">
                          <AlertCircle size={16} className="import-item__error-icon" />
                          <div className="import-item__status-copy">
                            <span className="import-item__filename">
                              {item.fileName}
                            </span>
                            <span
                              className="import-item__error-text"
                              role="alert"
                            >
                              {item.error || 'Unsupported audio file.'}
                            </span>
                          </div>
                          <button
                            type="button"
                            className="icon-btn import-item__action-btn"
                            onClick={() => handleRemoveItem(item.key)}
                            disabled={isSaving}
                            aria-label={`Remove ${item.fileName}`}
                          >
                            <X size={15} />
                          </button>
                        </div>
                      ) : (
                        <>
                          <div className="import-item__top">
                            <span className="import-item__index font-mono">
                              {String(chapterNumber ?? idx + 1).padStart(2, '0')}
                            </span>
                            <input
                              type="text"
                              className="input import-item__title-input"
                              value={item.name}
                              onChange={(e) =>
                                handleRenameItem(item.key, e.target.value)
                              }
                              placeholder="Chapter title"
                              maxLength={120}
                              disabled={isSaving}
                              aria-label={`Chapter title for ${item.fileName}`}
                            />
                            <div className="import-item__controls">
                              {items.length > 1 && (
                                <>
                                  <button
                                    type="button"
                                    className="icon-btn import-item__action-btn"
                                    onClick={() => handleMoveItem(idx, -1)}
                                    disabled={isSaving || idx === 0}
                                    aria-label={`Move ${item.name || item.fileName} up`}
                                  >
                                    <ArrowUp size={14} />
                                  </button>
                                  <button
                                    type="button"
                                    className="icon-btn import-item__action-btn"
                                    onClick={() => handleMoveItem(idx, 1)}
                                    disabled={isSaving || idx === items.length - 1}
                                    aria-label={`Move ${item.name || item.fileName} down`}
                                  >
                                    <ArrowDown size={14} />
                                  </button>
                                </>
                              )}
                              <button
                                type="button"
                                className="icon-btn import-item__action-btn"
                                onClick={() => handleRemoveItem(item.key)}
                                disabled={isSaving}
                                aria-label={`Remove ${item.name || item.fileName}`}
                              >
                                <X size={15} />
                              </button>
                            </div>
                          </div>
                          {item.analysis && (
                            <div className="import-item__meta">
                              <span className="font-mono">
                                {formatDurationMs(item.analysis.durationMs)}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span>{formatImportedSpec(item.analysis)}</span>
                              <span aria-hidden="true">·</span>
                              <span>{formatBytes(item.analysis.fileSizeBytes)}</span>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>

              {readyItems.length > 0 && (
                <div className="field">
                  <label
                    htmlFor="import-narrator-input"
                    className="field-label"
                  >
                    Read By (optional)
                  </label>
                  <input
                    id="import-narrator-input"
                    type="text"
                    className="input"
                    value={narrator}
                    onChange={(e) => setNarrator(e.target.value)}
                    placeholder="e.g. Mom, Dad, Grandma"
                    maxLength={80}
                    disabled={isSaving}
                  />
                </div>
              )}
            </>
          )}

          {submitError && (
            <div className="import-audio-error" role="alert">
              {submitError}
            </div>
          )}
        </div>

        <div className="sheet-footer">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            disabled={isSaving}
          >
            Cancel
          </button>
          <button
            type="submit"
            id="confirm-import-audio-btn"
            className="btn btn-primary"
            disabled={!canSubmit}
          >
            {isSaving ? (
              <>
                <Loader2 size={16} className="spin" />
                Importing…
              </>
            ) : (
              <>
                <Check size={16} />
                {readyItems.length > 1
                  ? `Import ${readyItems.length} Chapters`
                  : 'Import Chapter'}
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
};
