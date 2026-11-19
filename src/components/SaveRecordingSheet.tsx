import React, { useEffect, useRef, useState } from 'react';
import { Check, Loader2, Pause, Play, X } from 'lucide-react';
import { formatDurationMs } from '../utils/format';
import './SaveRecordingSheet.css';

interface SaveRecordingSheetProps {
  open: boolean;
  defaultName: string;
  durationMs: number;
  specLabel: string;
  isPreviewPlaying: boolean;
  isSaving: boolean;
  encodeProgress: number; // 0..1
  errorMessage: string | null;
  onTogglePreview: () => void;
  onBackToRecording: () => void;
  onConfirmSave: (name: string, notes: string) => void;
}

export const SaveRecordingSheet: React.FC<SaveRecordingSheetProps> = ({
  open,
  defaultName,
  durationMs,
  specLabel,
  isPreviewPlaying,
  isSaving,
  encodeProgress,
  errorMessage,
  onTogglePreview,
  onBackToRecording,
  onConfirmSave,
}) => {
  const [name, setName] = useState(defaultName);
  const [notes, setNotes] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setName(defaultName);
      setNotes('');
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [open, defaultName]);

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || isSaving) return;
    onConfirmSave(trimmed, notes.trim());
  };

  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="save-recording-title"
    >
      <form className="sheet-panel" onSubmit={handleSubmit}>
        <div className="sheet-header">
          <h2 id="save-recording-title" className="sheet-title">
            Name this Recording
          </h2>
          <button
            type="button"
            className="icon-btn"
            onClick={onBackToRecording}
            disabled={isSaving}
            aria-label="Back to recording"
          >
            <X size={20} />
          </button>
        </div>

        <div className="sheet-body">
          <div className="save-rec-summary">
            <div className="save-rec-summary__meta">
              <span className="save-rec-summary__duration">
                {formatDurationMs(durationMs)}
              </span>
              <span className="save-rec-summary__spec">{specLabel}</span>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onTogglePreview}
              disabled={isSaving}
            >
              {isPreviewPlaying ? <Pause size={15} /> : <Play size={15} />}
              {isPreviewPlaying ? 'Pause' : 'Listen'}
            </button>
          </div>

          <div className="field">
            <label htmlFor="recording-name-input" className="field-label">
              Recording Name
            </label>
            <input
              ref={inputRef}
              id="recording-name-input"
              type="text"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Chapter 1 — Into the Woods"
              required
              disabled={isSaving}
              maxLength={120}
            />
          </div>

          <div className="field">
            <label htmlFor="recording-notes-input" className="field-label">
              Chapter Notes (optional)
            </label>
            <textarea
              id="recording-notes-input"
              className="textarea"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Pages 1–14, bedtime voices..."
              disabled={isSaving}
            />
          </div>

          {isSaving && (
            <div className="save-rec-progress" aria-live="polite">
              <div className="save-rec-progress__label">
                <span>Encoding audio…</span>
                <span className="font-mono">
                  {Math.round(encodeProgress * 100)}%
                </span>
              </div>
              <div className="save-rec-progress__bar">
                <div
                  className="save-rec-progress__fill"
                  style={{ width: `${Math.round(encodeProgress * 100)}%` }}
                />
              </div>
            </div>
          )}

          {errorMessage && (
            <div className="save-rec-error" role="alert">
              {errorMessage}
            </div>
          )}
        </div>

        <div className="sheet-footer">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onBackToRecording}
            disabled={isSaving}
          >
            Back to Recording
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={isSaving || !name.trim()}
            id="confirm-save-recording-btn"
          >
            {isSaving ? (
              <>
                <Loader2 size={16} className="spin" />
                Saving…
              </>
            ) : (
              <>
                <Check size={16} />
                Save Recording
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
};
