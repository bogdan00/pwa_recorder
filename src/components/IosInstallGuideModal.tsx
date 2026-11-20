import React from 'react';
import { PlusSquare, Share, Smartphone, X } from 'lucide-react';
import './IosInstallGuideModal.css';

interface IosInstallGuideModalProps {
  open: boolean;
  onClose: () => void;
}

export const IosInstallGuideModal: React.FC<IosInstallGuideModalProps> = ({
  open,
  onClose,
}) => {
  if (!open) return null;

  const baseIconUrl = `${import.meta.env.BASE_URL}icons/icon-192.png`;

  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ios-install-guide-title"
      data-testid="ios-install-guide-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet-panel ios-install-sheet">
        <div className="sheet-header">
          <h2 id="ios-install-guide-title" className="sheet-title">
            Install StoryTape
          </h2>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close install guide"
          >
            <X size={20} />
          </button>
        </div>

        <div className="sheet-body ios-install-sheet__body">
          <div className="ios-install-hero">
            <img
              src={baseIconUrl}
              alt=""
              className="ios-install-hero__icon"
              aria-hidden="true"
            />
            <div className="ios-install-hero__text">
              <span className="ios-install-hero__title">
                Add to your Home Screen
              </span>
              <span className="ios-install-hero__sub">
                Launch full-screen like a native app with offline recording &amp; bedtime playback.
              </span>
            </div>
          </div>

          <ol className="ios-install-steps">
            <li className="ios-install-step">
              <span className="ios-install-step__badge" aria-hidden="true">
                <Share size={18} />
              </span>
              <div className="ios-install-step__content">
                <span className="ios-install-step__title">
                  1. Tap the Share button
                </span>
                <span className="ios-install-step__desc">
                  Look for the square-with-arrow Share icon in Safari&apos;s toolbar.
                </span>
              </div>
            </li>

            <li className="ios-install-step">
              <span className="ios-install-step__badge" aria-hidden="true">
                <PlusSquare size={18} />
              </span>
              <div className="ios-install-step__content">
                <span className="ios-install-step__title">
                  2. Tap &ldquo;Add to Home Screen&rdquo;
                </span>
                <span className="ios-install-step__desc">
                  Scroll down the share sheet, choose <strong>Add to Home Screen</strong>, then tap <strong>Add</strong>.
                </span>
              </div>
            </li>
          </ol>

          <p className="ios-install-note">
            <Smartphone size={14} aria-hidden="true" />
            <span>
              Your recordings stay safely saved on this device and sync to Google Drive whenever you connect.
            </span>
          </p>

          <button
            type="button"
            className="btn btn-primary"
            onClick={onClose}
          >
            Got It
          </button>
        </div>
      </div>
    </div>
  );
};
