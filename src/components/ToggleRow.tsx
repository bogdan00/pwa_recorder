import React from 'react';
import {
  InfoTipButton,
  InfoTipPanel,
  useInfoTip,
  type InfoTipContent,
} from './InfoTip';

export interface ToggleRowProps {
  title: string;
  description: React.ReactNode;
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
  testId?: string;
  help?: InfoTipContent;
}

export const ToggleRow: React.FC<ToggleRowProps> = ({
  title,
  description,
  checked,
  onToggle,
  disabled = false,
  testId,
  help,
}) => {
  const tip = useInfoTip();

  const row = (
    <div className="toggle-row" data-testid={testId}>
      <div className="toggle-text">
        <span className="info-tip-label-row">
          <span className="toggle-title">{title}</span>
          {help && (
            <InfoTipButton
              content={help}
              open={tip.open}
              panelId={tip.panelId}
              onToggle={tip.toggle}
            />
          )}
        </span>
        <span className="toggle-desc">{description}</span>
      </div>
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={checked}
        aria-label={title}
        disabled={disabled}
        onClick={onToggle}
      >
        <span className="switch-thumb" />
      </button>
    </div>
  );

  if (!help) return row;

  return (
    <div className="toggle-row-wrap">
      {row}
      {tip.open && (
        <InfoTipPanel
          content={help}
          panelId={tip.panelId}
          onClose={tip.close}
        />
      )}
    </div>
  );
};
