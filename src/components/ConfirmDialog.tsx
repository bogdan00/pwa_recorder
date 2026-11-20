import React, { useEffect } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import './ConfirmDialog.css';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'danger' | 'warning';
  isBusy?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'danger',
  isBusy = false,
  onCancel,
  onConfirm,
}) => {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isBusy) {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, isBusy, onCancel]);

  if (!open) return null;

  return (
    <div
      className="sheet-backdrop confirm-dialog-backdrop"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-desc"
      data-testid="confirm-dialog"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isBusy) {
          onCancel();
        }
      }}
    >
      <div className="sheet-panel confirm-dialog-panel">
        <div className="sheet-header confirm-dialog-header">
          <div className="confirm-dialog-title-wrap">
            <span
              className={`confirm-dialog-icon ${
                tone === 'danger'
                  ? 'confirm-dialog-icon--danger'
                  : 'confirm-dialog-icon--warning'
              }`}
              aria-hidden="true"
            >
              <AlertTriangle size={18} />
            </span>
            <h2 id="confirm-dialog-title" className="sheet-title">
              {title}
            </h2>
          </div>
        </div>

        <div className="sheet-body confirm-dialog-body">
          <p id="confirm-dialog-desc" className="confirm-dialog-desc">
            {description}
          </p>
        </div>

        <div className="sheet-footer confirm-dialog-footer">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onCancel}
            disabled={isBusy}
            data-testid="confirm-dialog-cancel"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${tone === 'danger' ? 'btn-danger' : 'btn-amber'}`}
            onClick={() => void onConfirm()}
            disabled={isBusy}
            data-testid="confirm-dialog-confirm"
          >
            {isBusy ? (
              <>
                <Loader2 size={15} className="spin" />
                Working…
              </>
            ) : (
              confirmLabel
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
