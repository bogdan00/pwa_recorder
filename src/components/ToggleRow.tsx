import React from 'react';

export interface ToggleRowProps {
  title: string;
  description: React.ReactNode;
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
  testId?: string;
}

export const ToggleRow: React.FC<ToggleRowProps> = ({
  title,
  description,
  checked,
  onToggle,
  disabled = false,
  testId,
}) => (
  <div className="toggle-row" data-testid={testId}>
    <div className="toggle-text">
      <span className="toggle-title">{title}</span>
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
