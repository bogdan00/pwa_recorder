import React, { useId, useState } from 'react';
import { HelpCircle, X } from 'lucide-react';
import './InfoTip.css';

export interface InfoTipBullet {
  readonly label: string;
  readonly text: string;
}

export interface InfoTipContent {
  readonly id: string;
  readonly topic: string;
  readonly title: string;
  readonly summary: string;
  readonly bullets?: readonly InfoTipBullet[];
  readonly tip?: string;
}

export interface InfoTipButtonProps {
  content: InfoTipContent;
  open: boolean;
  panelId: string;
  onToggle: () => void;
}

export const InfoTipButton: React.FC<InfoTipButtonProps> = ({
  content,
  open,
  panelId,
  onToggle,
}) => (
  <button
    type="button"
    className={`info-tip-btn ${open ? 'info-tip-btn--open' : ''}`}
    aria-expanded={open}
    aria-controls={panelId}
    aria-label={`Help: ${content.topic}`}
    data-testid={`help-btn-${content.id}`}
    onClick={(e) => {
      e.stopPropagation();
      onToggle();
    }}
  >
    <HelpCircle size={13} aria-hidden="true" />
  </button>
);

export interface InfoTipPanelProps {
  content: InfoTipContent;
  panelId: string;
  onClose: () => void;
}

export const InfoTipPanel: React.FC<InfoTipPanelProps> = ({
  content,
  panelId,
  onClose,
}) => (
  <div
    id={panelId}
    role="note"
    aria-label={`${content.topic} details`}
    className="info-tip-panel"
    data-testid={`help-panel-${content.id}`}
  >
    <div className="info-tip-panel__head">
      <span className="info-tip-panel__title">{content.title}</span>
      <button
        type="button"
        className="info-tip-panel__close"
        aria-label={`Close ${content.topic} help`}
        onClick={onClose}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>

    <p className="info-tip-panel__summary">{content.summary}</p>

    {content.bullets && content.bullets.length > 0 && (
      <ul className="info-tip-panel__list">
        {content.bullets.map((b) => (
          <li key={b.label}>
            <strong>{b.label}:</strong> {b.text}
          </li>
        ))}
      </ul>
    )}

    {content.tip && (
      <p className="info-tip-panel__tip">
        <strong>Tip:</strong> {content.tip}
      </p>
    )}
  </div>
);

export function useInfoTip() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return {
    open,
    panelId,
    toggle: () => setOpen((prev) => !prev),
    close: () => setOpen(false),
  };
}

export interface FieldHeaderWithHelpProps {
  label: React.ReactNode;
  htmlFor?: string;
  help?: InfoTipContent;
  right?: React.ReactNode;
}

export const FieldHeaderWithHelp: React.FC<FieldHeaderWithHelpProps> = ({
  label,
  htmlFor,
  help,
  right,
}) => {
  const tip = useInfoTip();

  const labelEl = htmlFor ? (
    <label htmlFor={htmlFor} className="field-label">
      {label}
    </label>
  ) : (
    <span className="field-label">{label}</span>
  );

  return (
    <>
      <div className="gain-header">
        <div className="info-tip-label-row">
          {labelEl}
          {help && (
            <InfoTipButton
              content={help}
              open={tip.open}
              panelId={tip.panelId}
              onToggle={tip.toggle}
            />
          )}
        </div>
        {right && <div className="field-header-right">{right}</div>}
      </div>
      {help && tip.open && (
        <InfoTipPanel
          content={help}
          panelId={tip.panelId}
          onClose={tip.close}
        />
      )}
    </>
  );
};
